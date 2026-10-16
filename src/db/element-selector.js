// Migration 012. An experiment can name a CSS selector and run only when that
// element is on the page. Additive only: one nullable column. NULL means no
// element rule, so a test saved before this still runs on the URL rule alone.
// schema.sql and migration 000 are left alone. Version 000 is already
// recorded on the live database and does not run again. Re-running this is safe.

async function applyElementSelector(client) {
  await client.query(`
    ALTER TABLE experiments ADD COLUMN IF NOT EXISTS element_selector TEXT
  `);
}

module.exports = { applyElementSelector };
