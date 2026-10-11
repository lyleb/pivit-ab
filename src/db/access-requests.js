// Migration 004. Access requests from the public landing page, stored next
// to invite codes. Version 003 is the url_match_type hotfix, so this table
// is not added to schema.sql (version 000 is already recorded and would not
// run). Safe to run again: the table and index use IF NOT EXISTS.
// The caller wraps this in a transaction.

async function applyAccessRequests(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      website TEXT NOT NULL,
      request_ip TEXT,
      invite_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_created
      ON access_requests (created_at DESC)
  `);
}

module.exports = { applyAccessRequests };
