// Migration 003. url_match_type was appended to schema.sql after version 000
// had already been recorded on the live database, so startup never ran that
// ALTER and creating an experiment failed. This version adds the column.
// The default fills existing rows with contains. Nothing is rewritten to
// exact, and a row an owner has already set is left alone on a re-run.
// The caller wraps this in a transaction.

async function applyUrlMatchType(client) {
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS url_match_type TEXT NOT NULL DEFAULT 'contains'
  `);
}

module.exports = { applyUrlMatchType };
