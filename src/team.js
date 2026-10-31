// The agency Team list, and the changes an Owner can make to their own people.
// Members may read the list. Owners may change a role (elsewhere), remove a
// membership, and manage Viewers in this agency. Removing a membership does
// not delete the user and does not suspend them: a person can belong to
// several agencies. A Viewer belongs to one agency, so the Owner may suspend
// or archive that Viewer. Another agency's person is missing.

const db = require('./db');
const { recordAudit, endUserSessions, endAccountUserSessions } = require('./audit');
const { LAST_ACCOUNT_OWNER, NOT_YOURSELF } = require('./person-state');
const { VIEW_ONLY_MESSAGE } = require('./membership-access');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  return { ok: false, status: 404, error: 'not found' };
}

function sameId(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function activeOwner(row) {
  return row.role === 'owner'
    && !row.removed_at
    && !row.suspended_at
    && !row.archived_at
    && !row.deleted_at;
}

function remainingOwner(row) {
  return row.role === 'owner' && !row.removed_at && !row.deleted_at;
}

function personLabel(person) {
  return person.email || person.name || person.username || '';
}

function roleRank(person) {
  if (person.role === 'owner') return 0;
  if (person.role === 'member') return 1;
  return 2;
}

// Legacy password sessions have no user id. Everyone else must still belong
// to this agency. A Member and an Owner may both read the list.
async function actorMayRead(accountId, actorUserId) {
  if (!actorUserId) return true;
  if (!UUID_RE.test(String(actorUserId))) return false;
  const { rows } = await db.query(
    `SELECT m.role
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.account_id = $1 AND m.user_id = $2
       AND m.removed_at IS NULL
       AND u.deleted_at IS NULL
       AND u.suspended_at IS NULL`,
    [accountId, actorUserId]
  );
  return !!(rows[0] && (rows[0].role === 'owner' || rows[0].role === 'member'));
}

async function assertAgencyOwner(accountId, userId) {
  if (!userId) return { ok: true, email: 'owner', userId: null };
  const actorId = String(userId);
  if (!accountId || !UUID_RE.test(actorId)) return notFound();
  const { rows } = await db.query(
    `SELECT u.email
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.account_id = $1 AND m.user_id = $2
       AND m.role = 'owner'
       AND m.removed_at IS NULL
       AND u.suspended_at IS NULL
       AND u.deleted_at IS NULL`,
    [accountId, actorId]
  );
  if (!rows[0]) return notFound();
  return { ok: true, email: rows[0].email, userId: actorId };
}

async function listTeam({ accountId, actorUserId }) {
  if (!accountId || !UUID_RE.test(String(accountId))) return notFound();
  if (!(await actorMayRead(accountId, actorUserId))) return notFound();

  const [users, viewers] = await Promise.all([
    db.query(
      `SELECT u.id, u.email, m.role, u.suspended_at, u.archived_at, u.created_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.account_id = $1
         AND m.removed_at IS NULL
         AND u.deleted_at IS NULL`,
      [accountId]
    ),
    db.query(
      `SELECT c.id, c.name, c.username, c.suspended_at, c.archived_at, c.created_at,
              COUNT(e.id)::int AS experiment_count
       FROM clients c
       LEFT JOIN experiments e ON e.client_id = c.id AND e.account_id = c.account_id
       WHERE c.account_id = $1
         AND c.deleted_at IS NULL
       GROUP BY c.id`,
      [accountId]
    ),
  ]);

  const people = users.rows.map((row) => ({
    id: row.id,
    kind: 'user',
    email: row.email,
    role: row.role,
    suspended: row.suspended_at != null,
    archived: row.archived_at != null,
    created_at: row.created_at,
  })).concat(viewers.rows.map((row) => ({
    id: row.id,
    kind: 'viewer',
    name: row.name,
    username: row.username,
    role: 'viewer',
    suspended: row.suspended_at != null,
    archived: row.archived_at != null,
    experiment_count: row.experiment_count,
    created_at: row.created_at,
  })));

  people.sort((a, b) => {
    const byRole = roleRank(a) - roleRank(b);
    if (byRole) return byRole;
    const byLabel = personLabel(a).localeCompare(personLabel(b), 'en-GB');
    if (byLabel) return byLabel;
    return String(a.id).localeCompare(String(b.id));
  });
  return { ok: true, people };
}

async function removeMembership({ accountId, actorUserId, targetUserId, ip }) {
  const actorId = String(actorUserId || '').toLowerCase();
  const targetId = String(targetUserId || '').toLowerCase();
  if (!accountId || !UUID_RE.test(String(accountId)) || !UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return notFound();
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT m.user_id, m.role, m.removed_at, u.email,
              u.suspended_at, u.archived_at, u.deleted_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.account_id = $1
       FOR UPDATE`,
      [accountId]
    );
    const actor = locked.rows.find((row) => sameId(row.user_id, actorId));
    const target = locked.rows.find((row) => sameId(row.user_id, targetId));
    if (!target || target.removed_at || target.deleted_at) {
      await client.query('ROLLBACK');
      return notFound();
    }
    if (!actor || actor.removed_at || actor.suspended_at || actor.deleted_at) {
      await client.query('ROLLBACK');
      return notFound();
    }
    if (actor.role !== 'owner') {
      await client.query('ROLLBACK');
      return { ok: false, status: 403, error: VIEW_ONLY_MESSAGE };
    }
    if (remainingOwner(target)) {
      const others = locked.rows.filter((row) => remainingOwner(row) && !sameId(row.user_id, targetId));
      if (!others.length || (activeOwner(target) && !others.some((row) => activeOwner(row)))) {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error: LAST_ACCOUNT_OWNER };
      }
    }
    if (sameId(actorId, targetId)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: NOT_YOURSELF };
    }

    await client.query(
      `UPDATE memberships
       SET removed_at = COALESCE(removed_at, now())
       WHERE account_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [accountId, targetId]
    );
    await endAccountUserSessions(targetId, accountId, client);
    const elsewhere = await client.query(
      `SELECT 1 FROM memberships WHERE user_id = $1 AND removed_at IS NULL LIMIT 1`,
      [targetId]
    );
    if (!elsewhere.rows.length) await endUserSessions(targetId, client);
    await recordAudit(client, {
      accountId,
      userId: actorId,
      actorLabel: actor.email,
      action: 'membership.removed',
      targetType: 'user',
      targetId,
      detail: { email: target.email, role: target.role, kind: 'user' },
      ip,
    });
    await client.query('COMMIT');
    return { ok: true, id: targetId, email: target.email, role: target.role };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

async function recordViewerAudit(entry) {
  await recordAudit(db, entry);
}

module.exports = {
  listTeam,
  removeMembership,
  assertAgencyOwner,
  recordViewerAudit,
};
