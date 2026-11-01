// Migration 024. Per-experiment Send to GA4 and Count dataLayer events.
// Both default on, so an experiment saved before this column keeps today's
// behaviour: the site switches still decide. Nothing is removed.
// schema.sql and migration 000 are left alone. Version 000 is already
// recorded on the live database and does not run again. Re-running this
// is safe.

async function applyExperimentIntegrations(client) {
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS ga4_enabled BOOLEAN NOT NULL DEFAULT true
  `);
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS datalayer_events BOOLEAN NOT NULL DEFAULT true
  `);
}

module.exports = { applyExperimentIntegrations };
