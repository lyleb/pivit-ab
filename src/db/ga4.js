// Migration 018. Paid-plan gate and per-site GA4 settings.
// Nullable measurement id, and both switches default off, so existing
// agencies and sites stay as they are. Nothing here is removed.
// Stays out of schema.sql: version 000 is already recorded and does not run again.

async function applyGa4(client) {
  await client.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS paid_plan BOOLEAN NOT NULL DEFAULT false
  `);
  await client.query(`
    ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT
  `);
  await client.query(`
    ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS ga4_enabled BOOLEAN NOT NULL DEFAULT false
  `);
}

module.exports = { applyGa4 };
