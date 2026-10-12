// Migration 007. The session store already lives in Postgres (connect-pg-simple
// creates "session" on first use). This version records that table in the
// migration list and adds lookup indexes so "sign out everywhere" and a
// password change can revoke rows without a sequential scan.
//
// Additive only. It does not rewrite sess or remove rows, and it does not
// change expire. A database that already has the table only gains indexes.
// schema.sql is left alone: version 000 is already recorded on the live
// database and does not run again.

async function applySessions(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      PRIMARY KEY ("sid")
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session" ((sess->>'userId'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS session_client_id_idx ON "session" ((sess->>'clientId'))
  `);
}

module.exports = { applySessions };
