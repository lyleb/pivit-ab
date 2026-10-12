// Migration 009. The first-run checklist can be hidden, and a site can remember
// the first snippet call that carried ?pivit_qa=1. Additive only: both columns
// are nullable, so existing accounts and sites are left unset. Nothing is
// backfilled. schema.sql is left alone, because version 000 is already
// recorded on the live database and does not run again.

async function applyFirstRun(client) {
  await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS checklist_dismissed_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS qa_seen_at TIMESTAMPTZ`);
}

module.exports = { applyFirstRun };
