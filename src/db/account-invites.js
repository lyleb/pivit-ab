// Migration 017. Invites that add a Member or an Owner to an existing agency.
// The token is stored only as a hash. Nothing here creates an agency.
// Nullable timestamps, so a new row is simply unused. Stays out of schema.sql:
// version 000 is already recorded and does not run again.

async function applyAccountInvites(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS account_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by UUID REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      used_by UUID REFERENCES users(id),
      last_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_account_invites_account
      ON account_invites (account_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_account_invites_email
      ON account_invites (email)
  `);
}

module.exports = { applyAccountInvites };
