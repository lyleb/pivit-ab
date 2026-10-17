// Suspended and archived people. Suspension blocks sign-in and existing
// sessions. Archive hides someone from lists and dropdowns. Deleting a person
// is a later step; the column already blocks sign-in and the same lists.
// A platform admin changes the marks. The last platform admin, and the last
// owner of an account, cannot be suspended or archived.

const db = require('./db');
const { recordAudit, endUserSessions, endClientSessions } = require('./audit');
const { clearSessionCookie } = require('./session-cookie');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIGN_IN_CLOSED = "That sign-in isn't available.";
const LAST_PLATFORM_ADMIN = 'pivitlab needs at least one platform admin.';
const LAST_ACCOUNT_OWNER = 'This account needs at least one owner.';
const NOT_YOURSELF = "You can't change your own access.";

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

async function setViewerAccess({ actorUserId, actorEmail, clientId, suspended, archived, ip }) {
  const actorId = String(actorUserId || '');
  const targetId = String(clientId || '');
  if (!UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, name, username, account_id, suspended_at, archived_at, deleted_at
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
        actorLabel: actorEmail,
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
  };
}

async function listPeople() {
  const [users, viewers] = await Promise.all([
    db.query(
      `SELECT u.id, u.email, u.is_superadmin, u.suspended_at, u.archived_at,
              m.role, m.account_id, a.name AS account_name,
              (SELECT MAX(l.created_at) FROM audit_log l
               WHERE l.actor_user_id = u.id AND l.action = 'signin') AS last_sign_in
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.removed_at IS NULL
       LEFT JOIN accounts a ON a.id = m.account_id
       WHERE u.deleted_at IS NULL`
    ),
    db.query(
      `SELECT c.id, c.name, c.username, c.suspended_at, c.archived_at,
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

module.exports = {
  SIGN_IN_CLOSED,
  LAST_PLATFORM_ADMIN,
  LAST_ACCOUNT_OWNER,
  NOT_YOURSELF,
  personClosed,
  parseAccessBody,
  sessionAllows,
  personAccess,
  refuseClosedSession,
  setUserAccess,
  setViewerAccess,
  listPeople,
};
