// Migration 006. Lets the owner setup screen say when a visit from the site's
// domain arrived without this site's key. Not added to schema.sql: version 000
// is already recorded on the live database and does not run again. Existing
// sites stay as they are, including the verified cantsaythat.co.uk site, so the
// installed tag is not rewritten and keyless reads keep working.

async function applyInstallCheck(client) {
  await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS install_note TEXT`);
  await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS install_note_host TEXT`);
  await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS install_note_at TIMESTAMPTZ`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sites_unverified
      ON sites (id)
      WHERE verified_at IS NULL
  `);
}

module.exports = { applyInstallCheck };
