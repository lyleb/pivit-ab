// Migration 019. When a test starts counting a visitor.
// activation_type defaults to page_load, so a test saved before this still
// starts when the address matches. activation_value is the CSS selector for
// the element start, and stays null otherwise. Nothing is removed.
// schema.sql and migration 000 are left alone. Version 000 is already
// recorded on the live database and does not run again. Re-running this is safe.

async function applyActivation(client) {
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS activation_type TEXT NOT NULL DEFAULT 'page_load'
  `);
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS activation_value TEXT
  `);
}

module.exports = { applyActivation };
