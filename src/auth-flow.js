// Sign-up and sign-in tokens. The raw token and the 6-digit code are emailed
// and stored only as hashes. The link opens a page; the token is spent when
// that page's button is pressed, or when the code is entered. A mail scanner
// that only fetches the link does not spend it.

const crypto = require('crypto');
const db = require('./db');
const { sha256, timingSafeStringEqual } = require('./timing');
const { normaliseHost } = require('./host-scope');
const { newSiteKey } = require('./db/tenancy');
const { recordAudit } = require('./audit');
const { hit } = require('./rate-limit');
const { sendEmail } = require('./mailer');
const { configuredAppOrigin } = require('./app-origin');

const TERMS_VERSION = 'beta-2026-10-09';
const TOKEN_TTL_MS = 15 * 60 * 1000;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1000;
const CODE_TRIES = 5;
const LINK_SENT = "If that address can be used, we've sent a link.";
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function appOrigin() {
  return configuredAppOrigin() || 'https://pivitlab.com';
}

function normaliseEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function customerHost(raw) {
  let text = String(raw || '').trim();
  if (!text || text.length > 300) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let hostname = '';
  try {
    hostname = new URL(text).hostname;
  } catch (err) {
    return '';
  }
  const host = normaliseHost(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return '';
  if (/^\d+(\.\d+){3}$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.length < 2) return '';
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  return host;
}

function newInviteCode() {
  const bytes = crypto.randomBytes(10);
  let body = '';
  for (let i = 0; i < 10; i += 1) body += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return `pivit-${body}`;
}

function normaliseInviteCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
}

function requestIp(req) {
  const ip = req && req.ip ? String(req.ip) : '';
  return ip ? ip.slice(0, 64) : null;
}

function signInText({ link, code, signup }) {
  const line = signup
    ? 'Use this link to create your pivitlab account and sign in. It works once and expires in 15 minutes.'
    : 'Use this link to sign in to pivitlab. It works once and expires in 15 minutes.';
  return [
    'Hello,',
    '',
    line,
    '',
    link,
    '',
    `Or type this code on the sign-in page: ${code}`,
    '',
    'If you did not ask for this, you can ignore this email.',
    '',
    'pivitlab',
  ].join('\n');
}

async function allowLinkRequest(email, ip) {
  const emailHit = await hit(`auth-email:${email}`, EMAIL_LIMIT, HOUR_MS);
  if (!emailHit.ok) return emailHit;
  const ipHit = await hit(`auth-ip:${ip || 'unknown'}`, IP_LIMIT, HOUR_MS);
  if (!ipHit.ok) return ipHit;
  return { ok: true };
}

async function latestOpenToken(email) {
  const { rows } = await db.query(
    `SELECT id, created_at FROM login_tokens
     WHERE email = $1 AND used_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function issueToken(client, { email, purpose, website, inviteId, termsVersion, ip }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  await client.query(
    `UPDATE login_tokens SET used_at = now() WHERE email = $1 AND used_at IS NULL`,
    [email]
  );
  await client.query(
    `INSERT INTO login_tokens
       (email, purpose, token_hash, code_hash, expires_at, website, invite_id, terms_version, request_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      email,
      purpose,
      sha256(token),
      sha256(code),
      new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      website || null,
      inviteId || null,
      termsVersion || null,
      ip || null,
    ]
  );
  return { token, code };
}

async function sendLink({ email, token, code, signup }) {
  const link = `${appOrigin()}/sign-in.html?token=${encodeURIComponent(token)}`;
  const subject = signup ? 'Finish creating your pivitlab account' : 'Your pivitlab sign-in link';
  return sendEmail({
    to: email,
    subject,
    text: signInText({ link, code, signup }),
  });
}

async function loadInvite(code) {
  const normalised = normaliseInviteCode(code);
  if (!normalised) return null;
  const { rows } = await db.query(
    `SELECT * FROM invite_codes WHERE code_hash = $1`,
    [sha256(normalised)]
  );
  return rows[0] || null;
}

function inviteUsable(invite, now = Date.now()) {
  if (!invite) return false;
  if (invite.revoked_at) return false;
  if (invite.used_at) return false;
  if (new Date(invite.expires_at).getTime() <= now) return false;
  return true;
}

async function requestSignIn(email, req) {
  const ip = requestIp(req);
  const limited = await allowLinkRequest(email, ip);
  if (!limited.ok) return { ok: false, status: 429, error: 'Please wait a while before asking for another link.' };

  const recent = await latestOpenToken(email);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_MS) {
    return { ok: true, message: LINK_SENT };
  }

  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (!rows[0]) return { ok: true, message: LINK_SENT };

  const client = await db.pool.connect();
  let issued;
  try {
    await client.query('BEGIN');
    issued = await issueToken(client, { email, purpose: 'signin', ip });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }

  const sent = await sendLink({ email, token: issued.token, code: issued.code, signup: false });
  if (sent.error) {
    await db.query(`UPDATE login_tokens SET used_at = now() WHERE token_hash = $1`, [sha256(issued.token)]);
    return { ok: false, status: 503, error: "We couldn't send the email. Please try again." };
  }
  return { ok: true, message: LINK_SENT };
}

async function requestSignup({ email, website, inviteCode, req }) {
  const ip = requestIp(req);
  const limited = await allowLinkRequest(email, ip);
  if (!limited.ok) return { ok: false, status: 429, error: 'Please wait a while before asking for another link.' };

  const invite = await loadInvite(inviteCode);
  if (!inviteUsable(invite)) {
    return { ok: false, status: 400, error: 'That invite code is not valid.' };
  }

  const recent = await latestOpenToken(email);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_MS) {
    return { ok: true, message: LINK_SENT };
  }

  const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  const purpose = existing.rows[0] ? 'signin' : 'signup';

  const client = await db.pool.connect();
  let issued;
  try {
    await client.query('BEGIN');
    issued = await issueToken(client, {
      email,
      purpose,
      website: purpose === 'signup' ? website : null,
      inviteId: purpose === 'signup' ? invite.id : null,
      termsVersion: purpose === 'signup' ? TERMS_VERSION : null,
      ip,
    });
    if (purpose === 'signup') {
      await recordAudit(client, {
        action: 'signup_requested',
        actorLabel: email,
        targetType: 'invite',
        targetId: invite.id,
        detail: { website },
        ip,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }

  const sent = await sendLink({ email, token: issued.token, code: issued.code, signup: purpose === 'signup' });
  if (sent.error) {
    await db.query(`UPDATE login_tokens SET used_at = now() WHERE token_hash = $1`, [sha256(issued.token)]);
    return { ok: false, status: 503, error: "We couldn't send the email. Please try again." };
  }
  return { ok: true, message: LINK_SENT };
}

async function membershipFor(client, userId) {
  const { rows } = await client.query(
    `SELECT account_id, role FROM memberships
     WHERE user_id = $1
     ORDER BY (role = 'owner') DESC, created_at
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function finishSignin(client, email, ip) {
  const { rows } = await client.query(`SELECT * FROM users WHERE email = $1 FOR UPDATE`, [email]);
  const user = rows[0];
  if (!user) return { ok: false, status: 400, error: 'That sign-in link is not valid, or it has expired.' };
  const wasVerified = !!user.verified_at;
  await client.query(
    `UPDATE users SET verified_at = COALESCE(verified_at, now()) WHERE id = $1`,
    [user.id]
  );
  const membership = await membershipFor(client, user.id);
  if (!membership) return { ok: false, status: 400, error: 'That sign-in link is not valid, or it has expired.' };
  await recordAudit(client, {
    accountId: membership.account_id,
    userId: user.id,
    actorLabel: email,
    action: wasVerified ? 'signin' : 'email_verified',
    targetType: 'user',
    targetId: user.id,
    ip,
  });
  if (!wasVerified) {
    await recordAudit(client, {
      accountId: membership.account_id,
      userId: user.id,
      actorLabel: email,
      action: 'signin',
      targetType: 'user',
      targetId: user.id,
      ip,
    });
  }
  return {
    ok: true,
    userId: user.id,
    accountId: membership.account_id,
    superadmin: user.is_superadmin === true,
    email,
  };
}

async function markDomainConflict(client, accountId, host, siteId) {
  const { rows } = await client.query(
    `SELECT id FROM sites WHERE account_id <> $1 AND $2 = ANY(domains)`,
    [accountId, host]
  );
  if (rows.length === 0) return false;
  const ids = rows.map((row) => row.id).concat([siteId]);
  await client.query(`UPDATE sites SET conflict = true WHERE id = ANY($1::uuid[])`, [ids]);
  await recordAudit(client, {
    accountId,
    action: 'domain_conflict',
    targetType: 'site',
    targetId: siteId,
    detail: { host },
  });
  return true;
}

async function finishSignup(client, tokenRow, ip) {
  const inviteRows = await client.query(
    `SELECT * FROM invite_codes WHERE id = $1 FOR UPDATE`,
    [tokenRow.invite_id]
  );
  const invite = inviteRows.rows[0];
  if (!inviteUsable(invite)) {
    return { ok: false, status: 400, error: 'That invite code is not valid.' };
  }
  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [tokenRow.email]);
  if (existing.rows[0]) return finishSignin(client, tokenRow.email, ip);

  const host = tokenRow.website;
  const account = await client.query(
    `INSERT INTO accounts (name, legacy) VALUES ($1, false) RETURNING id`,
    [host]
  );
  const accountId = account.rows[0].id;
  const user = await client.query(
    `INSERT INTO users (email, verified_at, terms_version, terms_accepted_at)
     VALUES ($1, now(), $2, now()) RETURNING id`,
    [tokenRow.email, tokenRow.terms_version || TERMS_VERSION]
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [accountId, userId]
  );
  const site = await client.query(
    `INSERT INTO sites (account_id, name, domains, public_key)
     VALUES ($1, $2, $3::text[], $4) RETURNING id`,
    [accountId, host, [host], newSiteKey()]
  );
  await markDomainConflict(client, accountId, host, site.rows[0].id);
  await client.query(
    `UPDATE invite_codes
     SET used_at = now(), used_by = $2, account_id = $3
     WHERE id = $1`,
    [invite.id, userId, accountId]
  );
  await recordAudit(client, {
    accountId,
    userId,
    actorLabel: tokenRow.email,
    action: 'signup',
    targetType: 'account',
    targetId: accountId,
    detail: { website: host, terms_version: tokenRow.terms_version || TERMS_VERSION, invite_id: invite.id },
    ip,
  });
  await recordAudit(client, {
    accountId,
    userId,
    actorLabel: tokenRow.email,
    action: 'email_verified',
    targetType: 'user',
    targetId: userId,
    ip,
  });
  await recordAudit(client, {
    accountId,
    userId,
    actorLabel: tokenRow.email,
    action: 'signin',
    targetType: 'user',
    targetId: userId,
    ip,
  });
  await recordAudit(client, {
    accountId,
    userId,
    actorLabel: tokenRow.email,
    action: 'site_added',
    targetType: 'site',
    targetId: site.rows[0].id,
    detail: { host },
    ip,
  });
  return { ok: true, userId, accountId, superadmin: false, email: tokenRow.email };
}

async function consumeLink(rawToken, req) {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, status: 400, error: 'That sign-in link is not valid, or it has expired.' };
  const ip = requestIp(req);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE login_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING *`,
      [sha256(token)]
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return { ok: false, status: 400, error: 'That sign-in link is not valid, or it has expired.' };
    }
    const result = row.purpose === 'signup'
      ? await finishSignup(client, row, ip)
      : await finishSignin(client, row.email, ip);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

async function consumeCode(email, code, req) {
  const ip = requestIp(req);
  const normalisedCode = String(code || '').trim();
  if (!/^\d{6}$/.test(normalisedCode)) {
    return { ok: false, status: 401, error: 'That code is not valid, or it has expired.' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM login_tokens
       WHERE email = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [email]
    );
    const row = rows[0];
    if (!row || row.attempts >= CODE_TRIES) {
      await recordAudit(client, {
        action: 'signin_failed',
        actorLabel: email,
        detail: { reason: row ? 'code_locked' : 'code' },
        ip,
      });
      await client.query('COMMIT');
      const error = row
        ? 'That code has been tried too many times. Use the link in the email, or ask for a new one.'
        : 'That code is not valid, or it has expired.';
      return { ok: false, status: 401, error };
    }
    if (!timingSafeStringEqual(sha256(normalisedCode), row.code_hash)) {
      const attempts = row.attempts + 1;
      await client.query(`UPDATE login_tokens SET attempts = $2 WHERE id = $1`, [row.id, attempts]);
      await recordAudit(client, {
        action: 'signin_failed',
        actorLabel: email,
        detail: { reason: 'code' },
        ip,
      });
      await client.query('COMMIT');
      const error = attempts >= CODE_TRIES
        ? 'That code has been tried too many times. Use the link in the email, or ask for a new one.'
        : 'That code is not valid, or it has expired.';
      return { ok: false, status: 401, error };
    }
    await client.query(`UPDATE login_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    const result = row.purpose === 'signup'
      ? await finishSignup(client, row, ip)
      : await finishSignin(client, row.email, ip);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

async function createInvite({ userId, note }) {
  const code = newInviteCode();
  const hint = code.slice(-4);
  const cleanNote = String(note || '').trim().slice(0, 200);
  const { rows } = await db.query(
    `INSERT INTO invite_codes (code_hash, hint, note, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, hint, note, expires_at, created_at`,
    [sha256(code), hint, cleanNote, userId, new Date(Date.now() + INVITE_TTL_MS).toISOString()]
  );
  await recordAudit(db, {
    userId,
    actorLabel: 'superadmin',
    action: 'invite_created',
    targetType: 'invite',
    targetId: rows[0].id,
    detail: { hint, note: cleanNote },
  });
  return { code, invite: rows[0] };
}

async function listInvites() {
  const { rows } = await db.query(
    `SELECT id, hint, note, expires_at, revoked_at, used_at, created_at
     FROM invite_codes
     ORDER BY created_at DESC
     LIMIT 100`
  );
  return rows;
}

async function revokeInvite(id, userId) {
  const { rows } = await db.query(
    `UPDATE invite_codes
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1
     RETURNING id, hint, revoked_at, used_at`,
    [id]
  );
  if (!rows[0]) return null;
  await recordAudit(db, {
    userId,
    actorLabel: 'superadmin',
    action: 'invite_revoked',
    targetType: 'invite',
    targetId: id,
    detail: { hint: rows[0].hint },
  });
  return rows[0];
}

module.exports = {
  TERMS_VERSION,
  LINK_SENT,
  TOKEN_TTL_MS,
  normaliseEmail,
  customerHost,
  normaliseInviteCode,
  requestSignIn,
  requestSignup,
  consumeLink,
  consumeCode,
  createInvite,
  listInvites,
  revokeInvite,
  inviteUsable,
};
