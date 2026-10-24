// Migration 021. Per-site opt-in for counting dataLayer events as custom
// goals. Off by default, so an existing site does not start watching
// dataLayer. Nothing is removed. schema.sql and migration 000 are left
// alone. Version 000 is already recorded on the live database and does
// not run again. Re-running this is safe.

async function applyDatalayerEvents(client) {
  await client.query(`
    ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS datalayer_events BOOLEAN NOT NULL DEFAULT false
  `);
}

module.exports = { applyDatalayerEvents };
