// Migration 023. A 6-digit code on an agency invite, so joining proves the
// person can read the invited address. Nullable, so an invite that has not
// asked for a code yet is unchanged. Nothing is removed. schema.sql and
// migration 000 are left alone.

async function applyJoinCodes(client) {
  await client.query(`
    ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS code_hash TEXT
  `);
  await client.query(`
    ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS code_attempts INTEGER NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMPTZ
  `);
}

module.exports = { applyJoinCodes };
