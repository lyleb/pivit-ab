// Migration 010. Conclusion PDFs and click-to-approve records.
// Additive only: new tables and indexes. Existing rows, schema.sql and
// migration 000 are left alone. Version 000 is already recorded on the live
// database and does not run again. Re-running this is safe.

async function applyConclusion(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS conclusion_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft',
      snapshot_date DATE,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT,
      released_at TIMESTAMPTZ,
      released_by TEXT
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conclusion_reports_one_per_experiment
      ON conclusion_reports (account_id, experiment_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conclusion_reports_account
      ON conclusion_reports (account_id, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS conclusion_approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      report_id UUID NOT NULL REFERENCES conclusion_reports(id) ON DELETE CASCADE,
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      approver_name TEXT NOT NULL,
      approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conclusion_approvals_one_per_client
      ON conclusion_approvals (report_id, client_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conclusion_approvals_account
      ON conclusion_approvals (account_id, approved_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS owner_notices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      experiment_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_owner_notices_unread
      ON owner_notices (account_id, created_at DESC)
      WHERE read_at IS NULL
  `);
}

module.exports = { applyConclusion };
