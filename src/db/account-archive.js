// Migration 026. A timestamp for an archived agency.
// Nullable, so every existing agency stays active. Nothing is backfilled
// and nothing is removed. schema.sql is left alone: version 000 is already
// recorded on the live database and does not run again. Re-running this is safe.

async function applyAccountArchive(client) {
  await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
}

module.exports = { applyAccountArchive };
