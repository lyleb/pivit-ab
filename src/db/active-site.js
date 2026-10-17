// Migration 015. The account can remember which site the setup screens use.
// Nullable, so existing accounts stay unset and nothing is backfilled.
// schema.sql is left alone: version 000 is already recorded and does not run again.

async function applyActiveSite(client) {
  await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active_site_id UUID`);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE accounts
        ADD CONSTRAINT accounts_active_site_id_fkey
        FOREIGN KEY (active_site_id) REFERENCES sites(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$
  `);
}

module.exports = { applyActiveSite };
