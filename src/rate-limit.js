// Fixed-window counters and the login lockout, stored in Postgres so a
// redeploy does not clear them.

const db = require('./db');

async function hit(bucket, limit, windowMs, queryable) {
  const query = (queryable || db).query.bind(queryable || db);
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const { rows } = await query(
    `INSERT INTO rate_limits (bucket, hits, window_start)
     VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE
       SET hits = CASE
             WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.hits + 1
             ELSE 1
           END,
           window_start = EXCLUDED.window_start,
           locked_until = NULL
     RETURNING hits`,
    [bucket, windowStart.toISOString()]
  );
  const hits = Number(rows[0].hits);
  if (hits > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000));
    return { ok: false, retryAfter, hits };
  }
  return { ok: true, hits };
}

// Same shape as the previous in-memory lockout: 5 failures, then 60 seconds.
// After the lock ends, one more failure locks again. Success clears the row.
async function loginLocked(bucket) {
  const { rows } = await db.query(
    `SELECT locked_until FROM rate_limits WHERE bucket = $1`,
    [bucket]
  );
  if (!rows[0] || !rows[0].locked_until) return 0;
  const until = new Date(rows[0].locked_until).getTime();
  if (until <= Date.now()) return 0;
  return Math.max(1, Math.ceil((until - Date.now()) / 1000));
}

async function loginFailure(bucket) {
  await db.query(
    `INSERT INTO rate_limits (bucket, hits, window_start, locked_until)
     VALUES ($1, 1, now(), NULL)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = rate_limits.hits + 1,
       locked_until = CASE
         WHEN rate_limits.hits + 1 >= 5 THEN now() + interval '60 seconds'
         ELSE NULL
       END`,
    [bucket]
  );
}

async function loginSuccess(bucket) {
  await db.query(`DELETE FROM rate_limits WHERE bucket = $1`, [bucket]);
}

module.exports = { hit, loginLocked, loginFailure, loginSuccess };
