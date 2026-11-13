// Migration 025. A revision number for variant content.
// Existing variants and experiments become revision 1. Existing events stay
// null and count as revision 1, so older results are left as they are.
// Nothing is removed. schema.sql and migration 000 are left alone. Version
// 000 is already recorded on the live database and does not run again.
// Re-running this is safe.

async function applyContentRevision(client) {
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS content_revision INTEGER NOT NULL DEFAULT 1
  `);
  await client.query(`
    ALTER TABLE variants
      ADD COLUMN IF NOT EXISTS content_revision INTEGER NOT NULL DEFAULT 1
  `);
  await client.query(`
    ALTER TABLE events
      ADD COLUMN IF NOT EXISTS content_revision INTEGER
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_revisions (
      id BIGSERIAL PRIMARY KEY,
      experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      variant_id UUID REFERENCES variants(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      while_running BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (experiment_id, revision)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_content_revisions_experiment
      ON content_revisions (experiment_id, saved_at)
  `);
}

module.exports = { applyContentRevision };
