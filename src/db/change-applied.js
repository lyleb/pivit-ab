// Migration 011. A view can say whether the variant's element changes were
// actually on the page. Additive only: one nullable column. Existing events
// stay NULL, which means "not reported", so they are not counted as misses.
// schema.sql and migration 000 are left alone. Version 000 is already
// recorded on the live database and does not run again. Re-running this is safe.

async function applyChangeApplied(client) {
  await client.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS change_applied BOOLEAN
  `);
}

module.exports = { applyChangeApplied };
