// An Owner invites a Member or another Owner into the agency they already
// belong to. The link is single-use, expires after 7 days, and can be revoked.
// Accepting creates a user when the email is new, or adds a membership when
// the person already uses pivitlab. It does not create an agency or a site.
// Platform-admin invite codes stay on invite_codes and are not used here.

const crypto = require('crypto');
const db = require('./db');
const { sha256 } = require('./timing');
const { recordAudit } = require('./audit');
const { normaliseEmail, requestIp, TERMS_VERSION } = require('./auth-flow');
const { personClosed, SIGN_IN_CLOSED } = require('./person-state');
const { hit, LIMITED_MESSAGE } = require('./rate-limit');
const { sendEmail } = require('./mailer');
const { appUrl } = require('./app-origin');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const EMAIL_LIMIT = 5;
const ACTOR_LIMIT = 20;
const IP_LIMIT = 20;
const ACCEPT_LIMIT = 20;
const PREVIEW_LIMIT = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVITE_INVALID = "That invite isn't valid. It may have expired, or it may already have been used.";
const CANNOT_INVITE = "That email address can't be invited.";
const ALREADY_PENDING = "There's already a pending invite for that email. Revoke it, or resend it.";
const ALREADY_MEMBER = 'That person is already in this agency.';
const ROLE_INVALID = 'Choose Member or Owner.';
const EMAIL_INVALID = 'Enter a work email.';
const NOT_PENDING = 'That invite is no longer pending.';
const EXPIRED = 'That invite has expired. Create a new one.';
const COOLDOWN = 'Wait a minute before sending that invite again.';
const EMAIL_FAILED = 'The email was not sent. Copy the link instead.';

function oneLine(value, max) {
  return String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'owner' || role === 'member') return role;
  return '';
}

function rolePhrase(role) {
  return role === 'owner' ? 'an Owner' : 'a Member';
}

function inviteLink(token) {
  return appUrl(`/join.html?token=${encodeURIComponent(token)}`);
}

function inviteEmailText({ agencyName, role, link }) {
  const agency = oneLine(agencyName, 120) || 'an agency';
  return [
    'Hello,',
    '',
    `You have been invited to join ${agency} on pivitlab as ${rolePhrase(role)}.`,
    '',
    'Use this link to join that agency. It works once and expires in 7 days. Joining does not create a new agency.',
    '',
    link,
    '',
    'Opening the link does not use it up. Press Join this agency on that page.',
    '',
    'If you did not expect this, you can ignore this email.',
    '',
    'pivitlab',
  ].join('\n');
}

function inviteOpen(row, now = Date.now()) {
  if (!row) return false;
  if (row.revoked_at) return false;
  if (row.used_at) return false;
  if (new Date(row.expires_at).getTime() <= now) return false;
  return true;
}

function publicInvite(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expires_at: row.expires_at,
    created_at: row.created_at,
    last_sent_at: row.last_sent_at || null,
  };
}

function limitedResult(limited) {
  return {
    ok: false,
    status: 429,
    error: LIMITED_MESSAGE,
    retryAfter: limited.retryAfter,
  };
}

function notFound() {
  return { ok: false, status: 404, error: 'not found' };
}

async function limitBuckets(checks) {
  for (const check of checks) {
    const decision = await hit(check.bucket, check.limit, HOUR_MS);
    if (!decision.ok) return decision;
  }
  return { ok: true };
}

function mutationLimits(email, actorId, ip) {
  return [
    { bucket: `account-invite-email:${email}`, limit: EMAIL_LIMIT },
    { bucket: `account-invite-actor:${actorId || 'unknown'}`, limit: ACTOR_LIMIT },
    { bucket: `account-invite-ip:${ip || 'unknown'}`, limit: IP_LIMIT },
  ];
}

async function withClient(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    if (!result || result.ok === false) {
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

async function lockAgency(client, accountId, userId) {
  const actorId = String(userId || '').toLowerCase();
  if (!UUID_RE.test(String(accountId || '')) || !UUID_RE.test(actorId)) return null;
  const account = await client.query(
    `SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE`,
    [accountId]
  );
  if (!account.rows[0]) return null;
  const { rows } = await client.query(
    `SELECT m.role, m.removed_at, u.email, u.suspended_at, u.deleted_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.account_id = $1 AND m.user_id = $2`,
    [accountId, actorId]
  );
  const actor = rows[0];
  if (!actor || actor.role !== 'owner' || actor.removed_at || actor.suspended_at || actor.deleted_at) {
    return null;
  }
  return { email: actor.email, accountName: account.rows[0].name };
}

async function refuseTarget(client, accountId, email) {
  const users = await client.query(
    `SELECT id, suspended_at, deleted_at FROM users WHERE email = $1 FOR UPDATE`,
    [email]
  );
  const user = users.rows[0];
  if (user && personClosed(user)) return { ok: false, status: 400, error: CANNOT_INVITE };
  if (!user) return null;
  const membership = await client.query(
    `SELECT removed_at FROM memberships WHERE account_id = $1 AND user_id = $2 FOR UPDATE`,
    [accountId, user.id]
  );
  if (membership.rows[0] && !membership.rows[0].removed_at) {
    return { ok: false, status: 400, error: ALREADY_MEMBER };
  }
  return null;
}

async function deliverInvite({ to, agencyName, role, token }) {
  const link = inviteLink(token);
  const agency = oneLine(agencyName, 120) || 'an agency';
  try {
    const sent = await sendEmail({
      to,
      subject: `Join ${agency} on pivitlab`,
      text: inviteEmailText({ agencyName: agency, role, link }),
      tag: 'agency-invite',
      buttonLabel: 'Join this agency',
      href: link,
    });
    if (!sent || sent.error) return { emailed: false, emailError: EMAIL_FAILED, link };
    return { emailed: sent.sent === true || sent.logged === true, emailError: null, link };
  } catch (err) {
    console.error('[email] agency invite was not sent', err && err.message);
    return { emailed: false, emailError: EMAIL_FAILED, link };
  }
}

async function stampSent(id) {
  const { rows } = await db.query(
    `UPDATE account_invites SET last_sent_at = now() WHERE id = $1 RETURNING last_sent_at`,
    [id]
  );
  return rows[0] ? rows[0].last_sent_at : null;
}

async function createAccountInvite({ accountId, actorUserId, email, role, send, ip }) {
  const normalised = normaliseEmail(email);
  if (!normalised) return { ok: false, status: 400, error: EMAIL_INVALID };
  const clean = cleanRole(role);
  if (!clean) return { ok: false, status: 400, error: ROLE_INVALID };
  const limited = await limitBuckets(mutationLimits(normalised, actorUserId, ip));
  if (!limited.ok) return limitedResult(limited);

  const token = crypto.randomBytes(32).toString('base64url');
  const created = await withClient(async (client) => {
    const owner = await lockAgency(client, accountId, actorUserId);
    if (!owner) return notFound();
    const refusal = await refuseTarget(client, accountId, normalised);
    if (refusal) return refusal;
    const pending = await client.query(
      `SELECT id FROM account_invites
       WHERE account_id = $1 AND email = $2
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [accountId, normalised]
    );
    if (pending.rows[0]) return { ok: false, status: 400, error: ALREADY_PENDING };
    const inserted = await client.query(
      `INSERT INTO account_invites
         (account_id, email, role, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, role, expires_at, created_at, last_sent_at`,
      [
        accountId,
        normalised,
        clean,
        sha256(token),
        actorUserId,
        new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      ]
    );
    await recordAudit(client, {
      accountId,
      userId: actorUserId,
      actorLabel: owner.email,
      action: 'account_invite_created',
      targetType: 'account_invite',
      targetId: inserted.rows[0].id,
      detail: { email: normalised, role: clean, delivery: send === true ? 'email' : 'link' },
      ip,
    });
    return { ok: true, invite: inserted.rows[0], agencyName: owner.accountName };
  });
  if (!created || !created.ok) return created;

  let emailed = false;
  let emailError = null;
  if (send === true) {
    const mail = await deliverInvite({
      to: normalised,
      agencyName: created.agencyName,
      role: clean,
      token,
    });
    emailed = mail.emailed;
    emailError = mail.emailError;
    if (emailed) created.invite.last_sent_at = await stampSent(created.invite.id);
  }
  return {
    ok: true,
    status: 201,
    invite: publicInvite(created.invite),
    link: inviteLink(token),
    emailed,
    emailError,
  };
}

async function listAccountInvites({ accountId, actorUserId }) {
  return withClient(async (client) => {
    const owner = await lockAgency(client, accountId, actorUserId);
    if (!owner) return notFound();
    const { rows } = await client.query(
      `SELECT id, email, role, expires_at, created_at, last_sent_at
       FROM account_invites
       WHERE account_id = $1
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 100`,
      [accountId]
    );
    return { ok: true, status: 200, invites: rows.map(publicInvite) };
  });
}

async function loadOwnInvite(client, accountId, id) {
  if (!UUID_RE.test(String(id || ''))) return { missing: true };
  const { rows } = await client.query(
    `SELECT * FROM account_invites WHERE id = $1 AND account_id = $2 FOR UPDATE`,
    [id, accountId]
  );
  if (!rows[0]) return { missing: true };
  return { invite: rows[0] };
}

async function revokeAccountInvite({ accountId, actorUserId, inviteId, ip }) {
  const limited = await limitBuckets([
    { bucket: `account-invite-actor:${actorUserId || 'unknown'}`, limit: ACTOR_LIMIT },
    { bucket: `account-invite-ip:${ip || 'unknown'}`, limit: IP_LIMIT },
  ]);
  if (!limited.ok) return limitedResult(limited);
  return withClient(async (client) => {
    const owner = await lockAgency(client, accountId, actorUserId);
    if (!owner) return notFound();
    const loaded = await loadOwnInvite(client, accountId, inviteId);
    if (loaded.missing) return notFound();
    const invite = loaded.invite;
    if (invite.used_at || invite.revoked_at) return { ok: false, status: 400, error: NOT_PENDING };
    const { rows } = await client.query(
      `UPDATE account_invites
       SET revoked_at = now()
       WHERE id = $1
       RETURNING id, email, role, revoked_at`,
      [invite.id]
    );
    await recordAudit(client, {
      accountId,
      userId: actorUserId,
      actorLabel: owner.email,
      action: 'account_invite_revoked',
      targetType: 'account_invite',
      targetId: invite.id,
      detail: { email: invite.email, role: invite.role },
      ip,
    });
    return { ok: true, status: 200, invite: rows[0] };
  });
}

async function resendAccountInvite({ accountId, actorUserId, inviteId, ip }) {
  const limited = await limitBuckets([
    { bucket: `account-invite-actor:${actorUserId || 'unknown'}`, limit: ACTOR_LIMIT },
    { bucket: `account-invite-ip:${ip || 'unknown'}`, limit: IP_LIMIT },
  ]);
  if (!limited.ok) return limitedResult(limited);

  const token = crypto.randomBytes(32).toString('base64url');
  const rotated = await withClient(async (client) => {
    const owner = await lockAgency(client, accountId, actorUserId);
    if (!owner) return notFound();
    const loaded = await loadOwnInvite(client, accountId, inviteId);
    if (loaded.missing) return notFound();
    const invite = loaded.invite;
    if (invite.used_at || invite.revoked_at) return { ok: false, status: 400, error: NOT_PENDING };
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      return { ok: false, status: 400, error: EXPIRED };
    }
    if (invite.last_sent_at && Date.now() - new Date(invite.last_sent_at).getTime() < RESEND_COOLDOWN_MS) {
      return { ok: false, status: 400, error: COOLDOWN };
    }
    const emailHit = await hit(`account-invite-email:${invite.email}`, EMAIL_LIMIT, HOUR_MS);
    if (!emailHit.ok) return limitedResult(emailHit);
    const { rows } = await client.query(
      `UPDATE account_invites
       SET token_hash = $2, expires_at = $3
       WHERE id = $1
       RETURNING id, email, role, expires_at, created_at, last_sent_at`,
      [invite.id, sha256(token), new Date(Date.now() + INVITE_TTL_MS).toISOString()]
    );
    await recordAudit(client, {
      accountId,
      userId: actorUserId,
      actorLabel: owner.email,
      action: 'account_invite_resent',
      targetType: 'account_invite',
      targetId: invite.id,
      detail: { email: invite.email, role: invite.role },
      ip,
    });
    return { ok: true, invite: rows[0], agencyName: owner.accountName };
  });
  if (!rotated || !rotated.ok) return rotated;

  const mail = await deliverInvite({
    to: rotated.invite.email,
    agencyName: rotated.agencyName,
    role: rotated.invite.role,
    token,
  });
  if (mail.emailed) rotated.invite.last_sent_at = await stampSent(rotated.invite.id);
  return {
    ok: true,
    status: 200,
    invite: publicInvite(rotated.invite),
    link: inviteLink(token),
    emailed: mail.emailed,
    emailError: mail.emailError,
    resent: true,
  };
}

async function previewAccountInvite(rawToken, req) {
  const ip = requestIp(req);
  const limited = await limitBuckets([
    { bucket: `account-invite-preview:${ip || 'unknown'}`, limit: PREVIEW_LIMIT },
  ]);
  if (!limited.ok) return limitedResult(limited);
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, status: 400, error: INVITE_INVALID };
  const { rows } = await db.query(
    `SELECT i.email, i.role, i.expires_at, i.revoked_at, i.used_at, a.name AS agency_name
     FROM account_invites i
     JOIN accounts a ON a.id = i.account_id
     WHERE i.token_hash = $1`,
    [sha256(token)]
  );
  const row = rows[0];
  if (!inviteOpen(row)) return { ok: false, status: 400, error: INVITE_INVALID };
  const user = await db.query(
    `SELECT suspended_at, deleted_at FROM users WHERE email = $1`,
    [row.email]
  );
  if (personClosed(user.rows[0])) return { ok: false, status: 401, error: SIGN_IN_CLOSED };
  return {
    ok: true,
    agencyName: row.agency_name,
    role: row.role,
    email: row.email,
  };
}

async function acceptAccountInvite(rawToken, req) {
  const ip = requestIp(req);
  const limited = await limitBuckets([
    { bucket: `account-invite-accept:${ip || 'unknown'}`, limit: ACCEPT_LIMIT },
  ]);
  if (!limited.ok) return limitedResult(limited);
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, status: 400, error: INVITE_INVALID };

  return withClient(async (client) => {
    const found = await client.query(
      `SELECT * FROM account_invites WHERE token_hash = $1 FOR UPDATE`,
      [sha256(token)]
    );
    const invite = found.rows[0];
    if (!inviteOpen(invite)) return { ok: false, status: 400, error: INVITE_INVALID };
    const account = await client.query(`SELECT id, name FROM accounts WHERE id = $1`, [invite.account_id]);
    if (!account.rows[0]) return { ok: false, status: 400, error: INVITE_INVALID };

    const existing = await client.query(
      `SELECT id, is_superadmin, suspended_at, deleted_at, verified_at
       FROM users WHERE email = $1 FOR UPDATE`,
      [invite.email]
    );
    let user = existing.rows[0];
    if (user && personClosed(user)) return { ok: false, status: 401, error: SIGN_IN_CLOSED };

    let createdUser = false;
    if (!user) {
      const inserted = await client.query(
        `INSERT INTO users (email, verified_at, terms_version, terms_accepted_at)
         VALUES ($1, now(), $2, now())
         RETURNING id, is_superadmin`,
        [invite.email, TERMS_VERSION]
      );
      user = inserted.rows[0];
      createdUser = true;
    } else if (!user.verified_at) {
      await client.query(`UPDATE users SET verified_at = now() WHERE id = $1`, [user.id]);
    }

    const membership = await client.query(
      `SELECT role, removed_at FROM memberships
       WHERE account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [invite.account_id, user.id]
    );
    let rejoined = false;
    if (!membership.rows[0]) {
      await client.query(
        `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, $3)`,
        [invite.account_id, user.id, invite.role]
      );
    } else if (membership.rows[0].removed_at) {
      await client.query(
        `UPDATE memberships SET role = $3, removed_at = NULL
         WHERE account_id = $1 AND user_id = $2`,
        [invite.account_id, user.id, invite.role]
      );
      rejoined = true;
    }

    await client.query(
      `UPDATE account_invites SET used_at = now(), used_by = $2 WHERE id = $1`,
      [invite.id, user.id]
    );
    await recordAudit(client, {
      accountId: invite.account_id,
      userId: user.id,
      actorLabel: invite.email,
      action: 'account_invite_accepted',
      targetType: 'account_invite',
      targetId: invite.id,
      detail: {
        email: invite.email,
        role: invite.role,
        created_user: createdUser,
        rejoined,
      },
      ip,
    });
    return {
      ok: true,
      userId: user.id,
      accountId: invite.account_id,
      superadmin: user.is_superadmin === true,
      email: invite.email,
    };
  });
}

// Called while a person is being deleted, before their email is anonymised.
// Outstanding invites for that address stop working. A missing table (the
// migration has not been applied) does not block the delete.
async function revokePendingForEmail(queryable, email, audit) {
  const source = queryable && queryable.query ? queryable : db;
  const query = source.query.bind(source);
  let rows;
  try {
    const result = await query(
      `UPDATE account_invites
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE lower(email) = lower($1)
         AND used_at IS NULL
         AND revoked_at IS NULL
       RETURNING id, account_id, email, role`,
      [email]
    );
    rows = result.rows;
  } catch (err) {
    if (err && err.code === '42P01') return;
    throw err;
  }
  for (const row of rows) {
    await recordAudit(queryable, {
      accountId: row.account_id,
      userId: audit && audit.userId,
      actorLabel: (audit && audit.actorLabel) || null,
      action: 'account_invite_revoked',
      targetType: 'account_invite',
      targetId: row.id,
      detail: { email: row.email, role: row.role, reason: 'user_deleted' },
      ip: audit && audit.ip,
    });
  }
}

module.exports = {
  INVITE_TTL_MS,
  INVITE_INVALID,
  CANNOT_INVITE,
  ALREADY_PENDING,
  ALREADY_MEMBER,
  ROLE_INVALID,
  EMAIL_INVALID,
  NOT_PENDING,
  EXPIRED,
  COOLDOWN,
  EMAIL_FAILED,
  inviteEmailText,
  inviteLink,
  createAccountInvite,
  listAccountInvites,
  revokeAccountInvite,
  resendAccountInvite,
  previewAccountInvite,
  acceptAccountInvite,
  revokePendingForEmail,
};
