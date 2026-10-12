const db = require('./db');

async function recordAudit(queryable, entry) {
  const query = (queryable && queryable.query ? queryable : db).query.bind(queryable && queryable.query ? queryable : db);
  try {
    await writeAudit(query, entry);
  } catch (err) {
    // A database that has not applied migration 002 has no audit_log yet.
    // Sign-in and sign-out still proceed. Any other error is real.
    if (err && err.code === '42P01') return;
    throw err;
  }
}

async function writeAudit(query, entry) {
  await query(
    `INSERT INTO audit_log
       (account_id, actor_user_id, actor_label, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      entry.accountId || null,
      entry.userId || null,
      entry.actorLabel || null,
      entry.action,
      entry.targetType || null,
      entry.targetId == null ? null : String(entry.targetId),
      JSON.stringify(entry.detail || {}),
      entry.ip ? String(entry.ip).slice(0, 64) : null,
    ]
  );
}

async function endUserSessions(userId) {
  if (!userId) return;
  await db.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(userId)]);
}

async function endClientSessions(clientId) {
  if (!clientId) return;
  await db.query(`DELETE FROM "session" WHERE sess->>'clientId' = $1`, [String(clientId)]);
}

module.exports = { recordAudit, endUserSessions, endClientSessions };
