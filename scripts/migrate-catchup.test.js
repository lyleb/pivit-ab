// A database that already recorded 000, 001 and 002 must still receive
// columns added after those versions. Production recorded 000 before
// url_match_type was appended to schema.sql, so re-running 000 does nothing.
// Existing experiment rows stay contains. A later exact value is not reset.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pg = require('./test-postgres');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function baselineSchema() {
  const schema = read('src/db/schema.sql');
  const statement = "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS url_match_type TEXT NOT NULL DEFAULT 'contains';\n";
  assert.strictEqual(schema.split(statement).length, 2, 'schema.sql should contain the column once');
  const baseline = schema.replace(statement, '');
  assert.ok(!baseline.includes('ADD COLUMN IF NOT EXISTS url_match_type'));
  return baseline;
}

function assertMigrationRegistered() {
  const migrateSrc = read('src/db/migrate.js');
  const migration = read('src/db/url-match-type.js');
  assert.ok(migrateSrc.includes("{ version: '003', name: 'url-match-type', run: applyUrlMatchType }"));
  assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS url_match_type TEXT NOT NULL DEFAULT 'contains'"));
  assert.ok(!/UPDATE\s+experiments/i.test(migration));
}

async function columnInfo(db) {
  const { rows } = await db.query(
    `SELECT column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'experiments'
       AND column_name = 'url_match_type'`
  );
  return rows[0] || null;
}

async function main() {
  assertMigrationRegistered();
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('migrate catch-up tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_migrate_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyTenancy } = require('../src/db/tenancy');
  const { applySignup } = require('../src/db/signup');

  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query(baselineSchema());
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenancy(client);
      await applySignup(client);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
      throw err;
    } finally {
      client.release();
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.query(`INSERT INTO schema_migrations (version) VALUES ('000'), ('001'), ('002')`);

    const { rows: seeded } = await db.query(
      `INSERT INTO experiments (name, url_match, status, allowed_hosts, account_id)
       SELECT 'Home - Winter Sale', 'https://cantsaythat.co.uk/', 'running', ARRAY['cantsaythat.co.uk'], id
       FROM accounts WHERE legacy IS TRUE
       RETURNING id`
    );
    assert.strictEqual(seeded.length, 1);
    const experimentId = seeded[0].id;
    assert.strictEqual(await columnInfo(db), null);

    const applied = await migrate();
    assert.deepStrictEqual(applied, ['003']);

    const column = await columnInfo(db);
    assert.ok(column, 'url_match_type should exist after 003');
    assert.strictEqual(column.is_nullable, 'NO');
    assert.ok(String(column.column_default).includes('contains'));

    const filled = await db.query(
      `SELECT url_match_type FROM experiments WHERE id = $1`,
      [experimentId]
    );
    assert.strictEqual(filled.rows[0].url_match_type, 'contains');

    await db.query(
      `UPDATE experiments SET url_match_type = 'exact' WHERE id = $1`,
      [experimentId]
    );
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    const kept = await db.query(
      `SELECT url_match_type FROM experiments WHERE id = $1`,
      [experimentId]
    );
    assert.strictEqual(kept.rows[0].url_match_type, 'exact');

    const versions = await db.query(`SELECT version FROM schema_migrations ORDER BY version`);
    assert.deepStrictEqual(versions.rows.map((row) => row.version), ['000', '001', '002', '003']);

    console.log('migrate catch-up tests passed');
  } finally {
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
