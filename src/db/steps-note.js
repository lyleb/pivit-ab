// Migration 020. A short steps note on a variant, such as "Click Continue twice".
// Empty string is the default, so a variant saved before this has no note.
// Nothing is removed. schema.sql and migration 000 are left alone. Version
// 000 is already recorded on the live database and does not run again.
// Re-running this is safe.

async function applyStepsNote(client) {
  await client.query(`
    ALTER TABLE variants
      ADD COLUMN IF NOT EXISTS steps_note TEXT NOT NULL DEFAULT ''
  `);
}

module.exports = { applyStepsNote };
