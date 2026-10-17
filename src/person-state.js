// Suspended and archived people. Suspension blocks sign-in and existing
// sessions. Archive hides someone from lists and dropdowns. Hard delete is
// rare, and only for someone already suspended or archived. It anonymises
// their personal details, removes sessions, sign-in tokens and memberships,
// and keeps the audit log under a stable label. A platform admin does this.
// The last platform admin, the last owner of an agency, and you yourself
// cannot be suspended, archived or deleted.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { recordAudit, endUserSessions, endClientSessions } = require('./audit');
const { clearSessionCookie } = require('./session-cookie');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIGN_IN_CLOSED = "That sign-in isn't available.";
const LAST_PLATFORM_ADMIN = 'pivitlab needs at least one Platform admin.';
const LAST_ACCOUNT_OWNER = 'This agency needs at least one Owner.';
const NOT_YOURSELF = "You can't change your own access.";
const DELETE_CLOSED = 'Suspend or archive this person before deleting them.';
const DELETE_CONFIRM = 'Type their email or username to confirm.';
const DELETE_MISMATCH = "That doesn't match their email or username.";
const DELETED_LABEL_PREFIX = 'Deleted user ';

const SIGN_IN_POSTS = new Set([
  '/api/auth/login',
  '/api/auth/client-login',
  '/api/auth/magic',
  '/api/auth/code',
  '/api/auth/email',
  '/api/auth/signup',
]);

function personClosed(row) {
  return !!(row && (row.suspended_at || row.deleted_at));
}

function sameId(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function requestPath(req) {
  const raw = (req && (req.originalUrl || req.url || req.path)) || '';
  return String(raw).split('?')[0];
}

function parseAccessBody(body) {
  const source = body || {};
  const hasSuspended = Object.prototype.hasOwnProperty.call(source, 'suspended');
  const hasArchived = Object.prototype.hasOwnProperty.call(source, 'archived');
  if (!hasSuspended && !hasArchived) {
    return { ok: false, status: 400, error: 'Nothing to change.' };
  }
  if (hasSuspended && typeof source.suspended !== 'boolean') {
    return { ok: false, status: 400, error: 'Suspended must be true or false.' };
  }
  if (hasArchived && typeof source.archived !== 'boolean') {
    return { ok: false, status: 400, error: 'Archived must be true or false.' };
  }
  return {
    ok: true,
    suspended: hasSuspended ? source.suspended : null,
    archived: hasArchived ? source.archived : null,
  };
}

function nextMark(flag, current) {
  if (flag == null) return current != null;
  return flag === true;
}

function accessChanges(row, suspended, archived) {
  const changes = [];
  if (suspended === true && !row.suspended_at) changes.push('suspend');
  if (suspended === false && row.suspended_at) changes.push('unsuspend');
  if (archived === true && !row.archived_at) changes.push('archive');
  if (archived === false && row.archived_at) changes.push('restore');
  return changes;
}

const USER_ACTIONS = {
  suspend: 'user.suspended',
  unsuspend: 'user.unsuspended',
  archive: 'user.archived',
  restore: 'user.restored',
};

function activeAdmin(row) {
  return row.is_superadmin === true && !row.suspended_at && !row.archived_at && !row.deleted_at;
}

function wasActive(row) {
  return !row.suspended_at && !row.archived_at && !row.deleted_at;
}

async function sessionAllows(session) {
  if (!session) return true;
  const userId = session.userId || null;
  const clientId = session.role === 'client' ? (session.clientId || null) : null;
  if (!userId && !clientId) return true;
  if (userId) {
    if (!UUID_RE.test(String(userId))) return false;
    const { rows } = await db.query(
      `SELECT suspended_at, deleted_at FROM users WHERE id = $1`,
      [userId]
    );
    if (personClosed(rows[0])) return false;
  }
  if (clientId) {
    if (!UUID_RE.test(String(clientId))) return false;
    const { rows } = await db.query(
      `SELECT suspended_at, deleted_at FROM clients WHERE id = $1`,
      [clientId]
    );
    if (personClosed(rows[0])) return false;
  }
  return true;
}

function closeSession(req, res) {
  const session = req && req.session;
  if (session) req.personChecked = false;
  return new Promise((resolve) => {
    const done = () => {
      clearSessionCookie(res);
      resolve();
    };
    if (session && typeof session.destroy === 'function') {
      session.destroy(() => done());
      return;
    }
    done();
  });
}

function reopenSession(req) {
  const session = req && req.session;
  return new Promise((resolve, reject) => {
    if (!session || typeof session.regenerate !== 'function') {
      resolve();
      return;
    }
    session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// Runs after the session is loaded. A suspended or deleted person is signed
// out before the route. Sign-in posts keep going on a fresh session so a new
// attempt can replace the old cookie.
function personAccess(req, res, next) {
  const session = req.session;
  const userId = session && session.userId;
  const clientId = session && session.role === 'client' && session.clientId;
  if (!userId && !clientId) {
    if (req) req.personChecked = true;
    return next();
  }
  sessionAllows(session).then((open) => {
    if (open) {
      req.personChecked = true;
      return next();
    }
    const path = requestPath(req);
    if (req.method === 'POST' && SIGN_IN_POSTS.has(path)) {
      return reopenSession(req).then(() => {
        req.personChecked = true;
        return next();
      }).catch(next);
    }
    return closeSession(req, res).then(() => {
      if (path.startsWith('/api/')) {
        return res.status(401).json({ error: 'not authenticated' });
      }
      return next();
    });
  }).catch((err) => {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  });
}

// requireAuth and /api/auth/me call this when the access middleware did not.
// Returns true when the response is already sent.
async function refuseClosedSession(req, res) {
  if (req && req.personChecked) return false;
  const open = await sessionAllows(req && req.session);
  if (open) {
    if (req) req.personChecked = true;
    return false;
  }
  await closeSession(req, res);
  res.status(401).json({ error: 'not authenticated' });
  return true;
}

function rollback(client) {
  return client.query('ROLLBACK').catch(() => {});
}

async function writeUserAudits(client, { accountIds, actorUserId, actorEmail, target, changes, ip }) {
  const accounts = accountIds.length ? accountIds : [null];
  for (const change of changes) {
    for (const accountId of accounts) {
      await recordAudit(client, {
        accountId,
        userId: actorUserId,
        actorLabel: actorEmail,
        action: USER_ACTIONS[change],
        targetType: 'user',
        targetId: target.id,
        detail: { email: target.email, kind: 'user' },
        ip,
      });
    }
  }
}

async function setUserAccess({ actorUserId, actorEmail, userId, suspended, archived, ip }) {
  const actorId = String(actorUserId || '');
  const targetId = String(userId || '');
  if (!UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const lockedUsers = await client.query(
      `SELECT id, email, is_superadmin, suspended_at, archived_at, deleted_at
       FROM users
       WHERE is_superadmin IS TRUE OR id = $1
       ORDER BY id
       FOR UPDATE`,
      [targetId]
    );
    const target = lockedUsers.rows.find((row) => sameId(row.id, targetId));
    if (!target || target.deleted_at) {
      await rollback(client);
      return { ok: false, status: 404, error: 'not found' };
    }

    const nextSuspended = nextMark(suspended, target.suspended_at);
    const nextArchived = nextMark(archived, target.archived_at);
    const staysActive = !nextSuspended && !nextArchived;
    const targetActiveAdmin = activeAdmin(target);
    if (targetActiveAdmin && !staysActive) {
      const others = lockedUsers.rows.filter((row) => !sameId(row.id, target.id) && activeAdmin(row));
      if (others.length < 1) {
        await rollback(client);
        return { ok: false, status: 400, error: LAST_PLATFORM_ADMIN };
      }
    }

    const owned = await client.query(
      `SELECT account_id
       FROM memberships
       WHERE user_id = $1 AND role = 'owner' AND removed_at IS NULL
       ORDER BY account_id
       FOR UPDATE`,
      [target.id]
    );
    const accountIds = owned.rows.map((row) => row.account_id);
    if (wasActive(target) && !staysActive && accountIds.length) {
      await client.query(
        `SELECT account_id, user_id
         FROM memberships
         WHERE account_id = ANY($1::uuid[])
         ORDER BY account_id, user_id
         FOR UPDATE`,
        [accountIds]
      );
      const peers = await client.query(
        `SELECT DISTINCT m.account_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.account_id = ANY($1::uuid[])
           AND m.role = 'owner'
           AND m.removed_at IS NULL
           AND m.user_id <> $2
           AND u.suspended_at IS NULL
           AND u.archived_at IS NULL
           AND u.deleted_at IS NULL`,
        [accountIds, target.id]
      );
      const covered = new Set(peers.rows.map((row) => String(row.account_id)));
      if (accountIds.some((id) => !covered.has(String(id)))) {
        await rollback(client);
        return { ok: false, status: 400, error: LAST_ACCOUNT_OWNER };
      }
    }

    const closingSelf = sameId(actorId, target.id)
      && ((suspended === true && !target.suspended_at) || (archived === true && !target.archived_at));
    if (closingSelf) {
      await rollback(client);
      return { ok: false, status: 400, error: NOT_YOURSELF };
    }

    const changes = accessChanges(target, suspended, archived);
    if (changes.length) {
      await client.query(
        `UPDATE users
         SET suspended_at = CASE
               WHEN $2::boolean IS NULL THEN suspended_at
               WHEN $2::boolean THEN COALESCE(suspended_at, now())
               ELSE NULL
             END,
             archived_at = CASE
               WHEN $3::boolean IS NULL THEN archived_at
               WHEN $3::boolean THEN COALESCE(archived_at, now())
               ELSE NULL
             END
         WHERE id = $1`,
        [target.id, suspended, archived]
      );
    }
    if (nextSuspended) await endUserSessions(target.id, client);

    const memberAccounts = await client.query(
      `SELECT account_id FROM memberships WHERE user_id = $1 AND removed_at IS NULL ORDER BY account_id`,
      [target.id]
    );
    await writeUserAudits(client, {
      accountIds: memberAccounts.rows.map((row) => row.account_id),
      actorUserId: actorId,
      actorEmail,
      target,
      changes,
      ip,
    });
    await client.query('COMMIT');
    return {
      ok: true,
      id: target.id,
      kind: 'user',
      email: target.email,
      suspended: nextSuspended,
      archived: nextArchived,
      changed: changes.length > 0,
    };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

async function setViewerAccess({ actorUserId, actorEmail, clientId, suspended, archived, ip, accountId }) {
  const actorId = String(actorUserId || '');
  const targetId = String(clientId || '');
  if (!UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const scopedAccount = accountId == null || accountId === '' ? null : String(accountId);
  if (scopedAccount && !UUID_RE.test(scopedAccount)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let actorLabel = actorEmail;
    if (scopedAccount) {
      // An agency Owner can change only Viewers in their own agency.
      // Anyone else, including an Owner of another agency, gets the same 404.
      const owner = await client.query(
        `SELECT m.role, m.removed_at, u.email, u.suspended_at, u.deleted_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.account_id = $1 AND m.user_id = $2
         FOR UPDATE OF m`,
        [scopedAccount, actorId]
      );
      const actor = owner.rows[0];
      if (!actor || actor.role !== 'owner' || actor.removed_at || actor.suspended_at || actor.deleted_at) {
        await rollback(client);
        return { ok: false, status: 404, error: 'not found' };
      }
      actorLabel = actor.email;
    }
    const params = [targetId];
    let where = 'id = $1';
    if (scopedAccount) {
      params.push(scopedAccount);
      where += ' AND account_id = $2';
    }
    const locked = await client.query(
      `SELECT id, name, username, account_id, suspended_at, archived_at, deleted_at
       FROM clients
       WHERE ${where}
       FOR UPDATE`,
      params
    );
    const target = locked.rows[0];
    if (!target || target.deleted_at) {
      await rollback(client);
      return { ok: false, status: 404, error: 'not found' };
    }
    const nextSuspended = nextMark(suspended, target.suspended_at);
    const nextArchived = nextMark(archived, target.archived_at);
    const changes = accessChanges(target, suspended, archived);
    if (changes.length) {
      await client.query(
        `UPDATE clients
         SET suspended_at = CASE
               WHEN $2::boolean IS NULL THEN suspended_at
               WHEN $2::boolean THEN COALESCE(suspended_at, now())
               ELSE NULL
             END,
             archived_at = CASE
               WHEN $3::boolean IS NULL THEN archived_at
               WHEN $3::boolean THEN COALESCE(archived_at, now())
               ELSE NULL
             END
         WHERE id = $1`,
        [target.id, suspended, archived]
      );
    }
    if (nextSuspended) await endClientSessions(target.id, client);
    for (const change of changes) {
      await recordAudit(client, {
        accountId: target.account_id,
        userId: actorId,
        actorLabel: actorLabel,
        action: USER_ACTIONS[change],
        targetType: 'client',
        targetId: target.id,
        detail: { username: target.username, name: target.name, kind: 'viewer' },
        ip,
      });
    }
    await client.query('COMMIT');
    return {
      ok: true,
      id: target.id,
      kind: 'viewer',
      username: target.username,
      suspended: nextSuspended,
      archived: nextArchived,
      changed: changes.length > 0,
    };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

function personShape(row) {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email || null,
    username: row.username || null,
    name: row.name || null,
    account_id: row.account_id || null,
    account_name: row.account_name || null,
    role: row.role,
    superadmin: row.superadmin === true,
    suspended: row.suspended_at != null,
    archived: row.archived_at != null,
    last_sign_in: row.last_sign_in || null,
    created_at: row.created_at || null,
  };
}

async function listPeople() {
  const [users, viewers] = await Promise.all([
    db.query(
      `SELECT u.id, u.email, u.is_superadmin, u.suspended_at, u.archived_at, u.created_at,
              m.role, m.account_id, a.name AS account_name,
              (SELECT MAX(l.created_at) FROM audit_log l
               WHERE l.actor_user_id = u.id AND l.action = 'signin') AS last_sign_in
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.removed_at IS NULL
       LEFT JOIN accounts a ON a.id = m.account_id
       WHERE u.deleted_at IS NULL`
    ),
    db.query(
      `SELECT c.id, c.name, c.username, c.suspended_at, c.archived_at, c.created_at,
              c.account_id, a.name AS account_name,
              (SELECT MAX(l.created_at) FROM audit_log l
               WHERE l.target_type = 'client' AND l.target_id = c.id::text AND l.action = 'signin') AS last_sign_in
       FROM clients c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.deleted_at IS NULL`
    ),
  ]);
  const people = users.rows.map((row) => personShape({
    id: row.id,
    kind: 'user',
    email: row.email,
    role: row.role || null,
    account_id: row.account_id,
    account_name: row.account_name,
    superadmin: row.is_superadmin === true,
    suspended_at: row.suspended_at,
    archived_at: row.archived_at,
    last_sign_in: row.last_sign_in,
    created_at: row.created_at,
  })).concat(viewers.rows.map((row) => personShape({
    id: row.id,
    kind: 'viewer',
    username: row.username,
    name: row.name,
    role: 'viewer',
    account_id: row.account_id,
    account_name: row.account_name,
    superadmin: false,
    suspended_at: row.suspended_at,
    archived_at: row.archived_at,
    last_sign_in: row.last_sign_in,
    created_at: row.created_at,
  })));
  people.sort((a, b) => {
    const labelA = a.email || a.username || '';
    const labelB = b.email || b.username || '';
    const byLabel = labelA.localeCompare(labelB, 'en-GB');
    if (byLabel) return byLabel;
    const byAccount = String(a.account_name || '').localeCompare(String(b.account_name || ''), 'en-GB');
    if (byAccount) return byAccount;
    return String(a.id).localeCompare(String(b.id));
  });
  return people;
}

// Stable, readable stand-in. The same person always gets the same label, and
// two deleted people do not share one, so the audit log stays readable.
function deletedLabel(id) {
  const compact = String(id || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(compact)) return 'Deleted user';
  return DELETED_LABEL_PREFIX + compact.slice(0, 8);
}

function deletedLabelSql(idExpr) {
  if (!/^[a-z]+\.id$/.test(idExpr)) throw new Error('unsafe id expression');
  return `('${DELETED_LABEL_PREFIX}' || left(replace(${idExpr}::text, '-', ''), 8))`;
}

function deletedEmail(id) {
  return `deleted-${String(id).toLowerCase()}@invalid`;
}

function deletedUsername(id) {
  return `deleted-${String(id).toLowerCase()}`;
}

function parseDeleteBody(body) {
  const source = body || {};
  if (!Object.prototype.hasOwnProperty.call(source, 'confirm') || typeof source.confirm !== 'string') {
    return { ok: false, status: 400, error: DELETE_CONFIRM };
  }
  const confirm = source.confirm.trim();
  if (!confirm || confirm.length > 320) {
    return { ok: false, status: 400, error: DELETE_CONFIRM };
  }
  return { ok: true, confirm };
}

function confirmMatches(confirm, identifiers) {
  const typed = String(confirm || '').trim().toLowerCase();
  if (!typed) return false;
  return (identifiers || []).some((value) => {
    if (value == null) return false;
    const text = String(value).trim().toLowerCase();
    return text !== '' && text === typed;
  });
}

function uniqueAccountIds(rows) {
  const seen = new Set();
  const ids = [];
  for (const row of rows || []) {
    if (!row || !row.account_id) continue;
    const key = String(row.account_id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(row.account_id);
  }
  return ids;
}

async function anonymiseAuditRows(client, spec) {
  const label = spec.label;
  await client.query(
    `UPDATE audit_log
     SET actor_label = CASE
           WHEN ($1::uuid IS NOT NULL AND actor_user_id = $1::uuid) THEN $7
           WHEN ($2::text IS NOT NULL AND lower(actor_label) = lower($2::text)) THEN $7
           WHEN ($3::text IS NOT NULL AND lower(actor_label) = lower($3::text)) THEN $7
           WHEN (
             $4::text IS NOT NULL
             AND actor_label = $4::text
             AND ($6::uuid IS NULL OR account_id = $6::uuid)
           ) THEN $7
           ELSE actor_label
         END,
         detail = CASE
           WHEN jsonb_typeof(detail) = 'object' THEN detail
             || CASE
                  WHEN $2::text IS NOT NULL AND lower(detail->>'email') = lower($2::text)
                  THEN jsonb_build_object('email', $7::text)
                  ELSE '{}'::jsonb
                END
             || CASE
                  WHEN $3::text IS NOT NULL AND lower(detail->>'username') = lower($3::text)
                  THEN jsonb_build_object('username', $7::text)
                  ELSE '{}'::jsonb
                END
             || CASE
                  WHEN $4::text IS NOT NULL AND detail->>'name' = $4::text
                  THEN jsonb_build_object('name', $7::text)
                  ELSE '{}'::jsonb
                END
           ELSE detail
         END
     WHERE ($1::uuid IS NOT NULL AND actor_user_id = $1::uuid)
        OR ($2::text IS NOT NULL AND (
              lower(actor_label) = lower($2::text)
              OR lower(detail->>'email') = lower($2::text)
            ))
        OR ($3::text IS NOT NULL AND (
              lower(actor_label) = lower($3::text)
              OR lower(detail->>'username') = lower($3::text)
            ))
        OR (
          $4::text IS NOT NULL
          AND actor_label = $4::text
          AND ($6::uuid IS NULL OR account_id = $6::uuid)
        )
        OR (target_type = $5 AND target_id = $8)`,
    [
      spec.userId || null,
      spec.email || null,
      spec.username || null,
      spec.name || null,
      spec.targetType,
      spec.accountId || null,
      label,
      String(spec.targetId),
    ]
  );
}

async function writeDeletedAudit(client, { accountIds, actorUserId, actorEmail, targetId, kind, label, ip }) {
  const accounts = accountIds.length ? accountIds : [null];
  for (const accountId of accounts) {
    await recordAudit(client, {
      accountId,
      userId: actorUserId,
      actorLabel: actorEmail,
      action: 'user.deleted',
      targetType: kind === 'viewer' ? 'client' : 'user',
      targetId,
      detail: { kind, label },
      ip,
    });
  }
}

async function refuseUserDelete(client, actorId, target) {
  if (target.is_superadmin) {
    const { rows } = await client.query(
      `SELECT id FROM users
       WHERE is_superadmin IS TRUE AND deleted_at IS NULL AND id <> $1`,
      [target.id]
    );
    if (!rows.length) return LAST_PLATFORM_ADMIN;
  }
  const owned = await client.query(
    `SELECT account_id
     FROM memberships
     WHERE user_id = $1 AND role = 'owner' AND removed_at IS NULL
     ORDER BY account_id
     FOR UPDATE`,
    [target.id]
  );
  const accountIds = owned.rows.map((row) => row.account_id);
  if (accountIds.length) {
    await client.query(
      `SELECT account_id, user_id
       FROM memberships
       WHERE account_id = ANY($1::uuid[])
       ORDER BY account_id, user_id
       FOR UPDATE`,
      [accountIds]
    );
    const peers = await client.query(
      `SELECT DISTINCT m.account_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.account_id = ANY($1::uuid[])
         AND m.role = 'owner'
         AND m.removed_at IS NULL
         AND m.user_id <> $2
         AND u.deleted_at IS NULL`,
      [accountIds, target.id]
    );
    const covered = new Set(peers.rows.map((row) => String(row.account_id)));
    if (accountIds.some((id) => !covered.has(String(id)))) return LAST_ACCOUNT_OWNER;
  }
  if (sameId(actorId, target.id)) return NOT_YOURSELF;
  if (!target.suspended_at && !target.archived_at) return DELETE_CLOSED;
  return '';
}

async function deleteUser({ actorUserId, actorEmail, userId, body, ip }) {
  const actorId = String(actorUserId || '');
  const targetId = String(userId || '');
  if (!UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const lockedUsers = await client.query(
      `SELECT id, email, is_superadmin, suspended_at, archived_at, deleted_at
       FROM users
       WHERE is_superadmin IS TRUE OR id = $1
       ORDER BY id
       FOR UPDATE`,
      [targetId]
    );
    const target = lockedUsers.rows.find((row) => sameId(row.id, targetId));
    if (!target || target.deleted_at) {
      await rollback(client);
      return { ok: false, status: 404, error: 'not found' };
    }
    const blocked = await refuseUserDelete(client, actorId, target);
    if (blocked) {
      await rollback(client);
      return { ok: false, status: 400, error: blocked };
    }
    const typed = parseDeleteBody(body);
    if (!typed.ok) {
      await rollback(client);
      return typed;
    }
    if (!confirmMatches(typed.confirm, [target.email])) {
      await rollback(client);
      return { ok: false, status: 400, error: DELETE_MISMATCH };
    }

    const label = deletedLabel(target.id);
    const email = target.email;
    const { revokePendingForEmail } = require('./account-invite');
    await revokePendingForEmail(client, email, {
      userId: actorId,
      actorLabel: actorEmail,
      ip,
    });
    const memberships = await client.query(
      `SELECT account_id FROM memberships WHERE user_id = $1 ORDER BY account_id`,
      [target.id]
    );
    const accountIds = uniqueAccountIds(memberships.rows);
    await anonymiseAuditRows(client, {
      userId: target.id,
      email,
      targetType: 'user',
      targetId: target.id,
      label,
    });
    await client.query(`DELETE FROM memberships WHERE user_id = $1`, [target.id]);
    await client.query(
      `UPDATE users
       SET email = $2, is_superadmin = false, deleted_at = COALESCE(deleted_at, now())
       WHERE id = $1`,
      [target.id, deletedEmail(target.id)]
    );
    await client.query(`DELETE FROM login_tokens WHERE lower(email) = lower($1)`, [email]);
    await endUserSessions(target.id, client);
    await writeDeletedAudit(client, {
      accountIds,
      actorUserId: actorId,
      actorEmail,
      targetId: target.id,
      kind: 'user',
      label,
      ip,
    });
    await client.query('COMMIT');
    return { ok: true, id: target.id, kind: 'user', deleted: true, label };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

async function deleteViewer({ actorUserId, actorEmail, clientId, body, ip }) {
  const actorId = String(actorUserId || '');
  const targetId = String(clientId || '');
  if (!UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, name, username, password_hash, account_id, suspended_at, archived_at, deleted_at
       FROM clients
       WHERE id = $1
       FOR UPDATE`,
      [targetId]
    );
    const target = locked.rows[0];
    if (!target || target.deleted_at) {
      await rollback(client);
      return { ok: false, status: 404, error: 'not found' };
    }
    if (!target.suspended_at && !target.archived_at) {
      await rollback(client);
      return { ok: false, status: 400, error: DELETE_CLOSED };
    }
    const typed = parseDeleteBody(body);
    if (!typed.ok) {
      await rollback(client);
      return typed;
    }
    if (!confirmMatches(typed.confirm, [target.username])) {
      await rollback(client);
      return { ok: false, status: 400, error: DELETE_MISMATCH };
    }

    const label = deletedLabel(target.id);
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    await anonymiseAuditRows(client, {
      username: target.username,
      name: target.name,
      accountId: target.account_id,
      targetType: 'client',
      targetId: target.id,
      label,
    });
    await client.query(
      `UPDATE clients
       SET name = $2, username = $3, password_hash = $4, deleted_at = COALESCE(deleted_at, now())
       WHERE id = $1`,
      [target.id, label, deletedUsername(target.id), passwordHash]
    );
    await endClientSessions(target.id, client);
    await writeDeletedAudit(client, {
      accountIds: target.account_id ? [target.account_id] : [],
      actorUserId: actorId,
      actorEmail,
      targetId: target.id,
      kind: 'viewer',
      label,
      ip,
    });
    await client.query('COMMIT');
    return { ok: true, id: target.id, kind: 'viewer', deleted: true, label };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  SIGN_IN_CLOSED,
  LAST_PLATFORM_ADMIN,
  LAST_ACCOUNT_OWNER,
  NOT_YOURSELF,
  DELETE_CLOSED,
  DELETE_CONFIRM,
  DELETE_MISMATCH,
  personClosed,
  parseAccessBody,
  parseDeleteBody,
  confirmMatches,
  deletedLabel,
  deletedLabelSql,
  deletedEmail,
  deletedUsername,
  sessionAllows,
  personAccess,
  refuseClosedSession,
  setUserAccess,
  setViewerAccess,
  deleteUser,
  deleteViewer,
  listPeople,
};
