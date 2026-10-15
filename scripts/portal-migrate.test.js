// A database that already recorded 000 through 004 must still receive the
// portal objects. They live in migration 005, not in schema.sql. Version 000
// is already recorded on the live database, so editing schema.sql would not
// create them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pg = require('./test-postgres');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function assertMigrationRegistered() {
  const schema = read('src/db/schema.sql');
  const migrateSrc = read('src/db/migrate.js');
  const migration = read('src/db/portal.js');
  assert.ok(!schema.includes('status_snapshots'), 'status_snapshots must not be added in schema.sql');
  assert.ok(!schema.includes('review_requests'), 'review_requests must not be added in schema.sql');
  assert.ok(!schema.includes('hypothesis'), 'hypothesis must not be added in schema.sql');
  assert.ok(migrateSrc.includes("{ version: '005', name: 'portal', run: applyPortal }"));
  assert.ok(!migrateSrc.includes("name: 'portal', run: applyPortal }") || migrateSrc.includes("version: '005'"));
  assert.ok(!/version: '003'[\s\S]{0,80}portal/.test(migrateSrc));
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS hypothesis TEXT'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS status_snapshots'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS review_requests'));
}

async function main() {
  assertMigrationRegistered();
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('portal migrate tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_portal_mig_' + Date.now().toString(36);
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
    await db.query(read('src/db/schema.sql'));
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
    await db.query(
      `INSERT INTO schema_migrations (version) VALUES ('000'), ('001'), ('002'), ('003'), ('004')`
    );

    const applied = await migrate();
    assert.deepStrictEqual(applied, ['005', '006', '007', '008', '009', '010', '011']);

    const column = await db.query(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'experiments' AND column_name = 'hypothesis'`
    );
    assert.strictEqual(column.rows[0].data_type, 'text');
    assert.strictEqual(column.rows[0].is_nullable, 'YES');
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('status_snapshots', 'review_requests')
       ORDER BY table_name`
    );
    assert.deepStrictEqual(tables.rows.map((row) => row.table_name), ['review_requests', 'status_snapshots']);

    const again = await migrate();
    assert.deepStrictEqual(again, []);
    console.log('portal migrate tests passed');
  } finally {
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
