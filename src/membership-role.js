// Change a membership role on one account and write it to the audit log.
// The account comes from the caller. A user on another account is missing.

const db = require('./db');
const { recordAudit } = require('./audit');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['owner', 'member']);

function activeOwner(row) {
  return row.role === 'owner'
    && !row.removed_at
    && !row.suspended_at
    && !row.archived_at
    && !row.deleted_at;
}

async function setMembershipRole({ accountId, actorUserId, targetUserId, role, ip }) {
  const actorId = String(actorUserId || '').toLowerCase();
  const targetId = String(targetUserId || '').toLowerCase();
  if (!accountId || !UUID_RE.test(actorId) || !UUID_RE.test(targetId)) {
    return { ok: false, status: 404, error: 'not found' };
  }
  if (!ROLES.has(role)) {
    return { ok: false, status: 400, error: 'Role must be owner or member.' };
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
    const actor = locked.rows.find((row) => String(row.user_id).toLowerCase() === actorId);
    if (!actor || actor.role !== 'owner' || actor.removed_at || actor.suspended_at || actor.deleted_at) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'not found' };
    }
    const target = locked.rows.find((row) => String(row.user_id).toLowerCase() === targetId);
    if (!target || target.removed_at || target.deleted_at) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'no user found with that id' };
    }
    if (target.role === role) {
      await client.query('COMMIT');
      return { ok: true, changed: false, role, email: target.email };
    }
    if (target.role === 'owner' && role !== 'owner' && activeOwner(target)) {
      const owners = locked.rows.filter((row) => activeOwner(row) && String(row.user_id).toLowerCase() !== targetId).length;
      if (owners < 1) {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error: 'This account needs at least one owner.' };
      }
    }
    await client.query(
      `UPDATE memberships SET role = $3 WHERE account_id = $1 AND user_id = $2`,
      [accountId, targetId, role]
    );
    await recordAudit(client, {
      accountId,
      userId: actorId,
      actorLabel: actor.email,
      action: 'role_change',
      targetType: 'user',
      targetId: targetId,
      detail: {
        from_role: target.role,
        to_role: role,
        email: target.email,
      },
      ip,
    });
    await client.query('COMMIT');
    return { ok: true, changed: true, role, email: target.email, from_role: target.role };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { setMembershipRole };
