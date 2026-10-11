// Migration 005. Daily status snapshots, an optional hypothesis, and a logged
// request for the owner to review a test. These objects are not in schema.sql:
// version 000 is already recorded on the live database and does not run again.
// Existing rows are kept. Re-running this is safe.

async function applyPortal(client) {
  await client.query(`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS hypothesis TEXT`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS status_snapshots (
      experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id),
      snapshot_date DATE NOT NULL,
      headline_code TEXT NOT NULL,
      progress_pct_band INTEGER,
      projected_end DATE,
      futility_band TEXT NOT NULL DEFAULT 'none',
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (experiment_id, snapshot_date)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_status_snapshots_account
      ON status_snapshots (account_id, snapshot_date DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS review_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      email_sent BOOLEAN NOT NULL DEFAULT false,
      email_error TEXT,
      decided_at TIMESTAMPTZ,
      decided_by TEXT
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_review_requests_account
      ON review_requests (account_id, created_at DESC)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS review_requests_one_open
      ON review_requests (experiment_id)
      WHERE decided_at IS NULL
  `);
}

module.exports = { applyPortal };
