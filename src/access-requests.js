// Access requests from the public landing page. Stored next to invite
// codes. Each new row emails an alert. The form stays off until
// ACCESS_REQUESTS_ENABLED is set, because the privacy page is still a
// placeholder.

const db = require('./db');
const { normaliseEmail, customerHost, createInvite, requestIp } = require('./auth-flow');
const { recordAudit } = require('./audit');
const { hit } = require('./rate-limit');
const { sendEmail, replyToAddress } = require('./mailer');
const { configuredAppOrigin } = require('./app-origin');
const { accessRequestsEnabled } = require('./access-flag');

const EMAIL_LIMIT = 5;
const IP_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;

function notifyAddress() {
  const raw = String(process.env.ACCESS_REQUEST_EMAIL || '').trim();
  return raw || replyToAddress();
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!name || name.length > 80) return '';
  return name;
}

function alertText(row) {
  const origin = configuredAppOrigin() || 'https://pivitlab.com';
  return [
    'Someone asked for access to pivitlab.',
    '',
    `Name: ${row.name}`,
    `Email: ${row.email}`,
    `Website: https://${row.website}`,
    '',
    'Create an invite code from the dashboard:',
    `${origin}/index.html`,
    '',
    'pivitlab',
  ].join('\n');
}

function publicRequest(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    website: row.website,
    invite_id: row.invite_id || null,
    created_at: row.created_at,
  };
}

async function submitAccessRequest(req) {
  const ip = requestIp(req);
  const ipHit = await hit(`access-ip:${ip || 'unknown'}`, IP_LIMIT, HOUR_MS);
  if (!ipHit.ok) {
    return {
      ok: false,
      status: 429,
      error: 'Please wait a moment and try again.',
      retryAfter: ipHit.retryAfter,
    };
  }

  const body = (req && req.body) || {};
  if (String(body.pivit_hp || '').trim()) return { ok: true, dropped: true };

  const name = cleanName(body.name);
  const email = normaliseEmail(body.email);
  const website = customerHost(body.website);
  if (!name || !email || !website) {
    return { ok: false, status: 400, error: 'Enter your name, a work email and your website.' };
  }

  const emailHit = await hit(`access-email:${email}`, EMAIL_LIMIT, HOUR_MS);
  if (!emailHit.ok) {
    return {
      ok: false,
      status: 429,
      error: 'Please wait a moment and try again.',
      retryAfter: emailHit.retryAfter,
    };
  }

  const { rows } = await db.query(
    `INSERT INTO access_requests (name, email, website, request_ip)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, website, created_at`,
    [name, email, website, ip]
  );
  const row = rows[0];
  try {
    const mailed = await sendEmail({
      to: notifyAddress(),
      subject: 'New pivitlab access request',
      text: alertText(row),
    });
    if (mailed && mailed.error) console.error('[access] notification email was not sent');
  } catch (err) {
    console.error('[access] notification email failed', err);
  }
  return { ok: true, request: row };
}

async function listAccessRequests() {
  const { rows } = await db.query(
    `SELECT id, name, email, website, invite_id, created_at
     FROM access_requests
     ORDER BY created_at DESC
     LIMIT 200`
  );
  return rows.map(publicRequest);
}

async function createInviteForRequest({ id, userId }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, name, email, website, invite_id, created_at
       FROM access_requests
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const row = found.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'not found' };
    }
    if (row.invite_id) {
      await client.query('COMMIT');
      return { ok: true, already: true, request: publicRequest(row) };
    }
    const note = `${row.name} · ${row.email} · ${row.website}`.slice(0, 200);
    const created = await createInvite({ userId, note, queryable: client });
    const updated = await client.query(
      `UPDATE access_requests
       SET invite_id = $1
       WHERE id = $2 AND invite_id IS NULL
       RETURNING id, name, email, website, invite_id, created_at`,
      [created.invite.id, id]
    );
    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'An invite was already created for this request.' };
    }
    await recordAudit(client, {
      userId,
      actorLabel: 'superadmin',
      action: 'access_request_invite',
      targetType: 'access_request',
      targetId: id,
      detail: { invite_id: created.invite.id, hint: created.invite.hint, email: row.email },
    });
    await client.query('COMMIT');
    return {
      ok: true,
      code: created.code,
      invite: created.invite,
      request: publicRequest(updated.rows[0]),
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    if (err && err.code === '22P02') return { ok: false, status: 404, error: 'not found' };
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  EMAIL_LIMIT,
  IP_LIMIT,
  accessRequestsEnabled,
  notifyAddress,
  submitAccessRequest,
  listAccessRequests,
  createInviteForRequest,
};
