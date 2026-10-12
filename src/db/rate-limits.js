// Migration 008. The rate_limits table already exists (migration 002). This
// version only adds an index on window_start so old windows can be found
// without reading every bucket. It does not change hits, windows or lockouts,
// and it does not delete rows. schema.sql is left alone: version 000 is
// already recorded on the live database and does not run again.

async function applyRateLimits(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
      ON rate_limits (window_start)
  `);
}

module.exports = { applyRateLimits };
