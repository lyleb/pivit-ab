// Migration 016. Suspended, archived and deleted marks for users and viewers
// (the clients table), plus the moment a membership was removed.
// Nullable, so every existing person stays active. Nothing is backfilled.
// schema.sql is left alone: version 000 is already recorded and does not run again.
// Session lookup indexes already exist (migration 007).

async function applyPeopleState(client) {
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE memberships ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`);
}

module.exports = { applyPeopleState };
