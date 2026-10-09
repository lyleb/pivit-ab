// pg_dump a migrated database and restore it into a scratch database.
// Skips when pg_dump is missing and TEST_DATABASE_URL is unset. Fails in CI
// when the client tools are missing, so a green run has actually restored.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const pg = require('./test-postgres');
const { dumpDatabase, pgDumpAvailable } = require('./backup');
const { restoreAndCompare, restoreDump } = require('./restore-check');

const PASSWORD_HASH = 'hash-kept-9f3a';

async function main() {
  if (!pgDumpAvailable()) {
    if (pg.usingTestDatabaseUrl()) {
      throw new Error('pg_dump is required when TEST_DATABASE_URL is set');
    }
    console.log('backup restore tests skipped: pg_dump is not installed');
    return;
  }
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('backup restore tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_backup_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.PIVIT_TENANCY_FAULT;
  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const dumpFile = path.join(os.tmpdir(), dbName + '.dump');
  let closed = false;

  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    await db.query(
      `INSERT INTO experiments (name, url_match, status, allowed_hosts, account_id)
       VALUES ('Kept', '/kept', 'draft', '{}'::text[], $1)`,
      [account.rows[0].id]
    );
    await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Kept client', 'kept-client', $2, $1)`,
      [account.rows[0].id, PASSWORD_HASH]
    );
    await db.pool.end();
    closed = true;

    dumpDatabase(process.env.DATABASE_URL, dumpFile);
    const scratchName = 'pivit_restored_' + Date.now().toString(36);
    const result = await restoreAndCompare({
      dumpFile,
      sourceUrl: process.env.DATABASE_URL,
      adminUrl: pg.adminUrl(),
      scratchName,
    });
    assert.strictEqual(result.ok, true, result.lines.join('; '));
    assert.strictEqual(Number(result.restored.clients), 1);

    const checkName = 'pivit_restored_hash_' + Date.now().toString(36);
    const checkAdmin = new Client({ connectionString: pg.adminUrl() });
    await checkAdmin.connect();
    try {
      await checkAdmin.query(`CREATE DATABASE ${checkName}`);
      restoreDump(pg.databaseUrl(checkName), dumpFile);
      const check = new Client({ connectionString: pg.databaseUrl(checkName) });
      await check.connect();
      try {
        const { rows } = await check.query(
          `SELECT username, password_hash FROM clients WHERE username = 'kept-client'`
        );
        assert.strictEqual(rows[0].password_hash, PASSWORD_HASH);
        const accountRow = await check.query(`SELECT name, legacy FROM accounts WHERE legacy IS TRUE`);
        assert.strictEqual(accountRow.rows[0].name, 'Heclr');
      } finally {
        await check.end();
      }
    } finally {
      await checkAdmin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [checkName]
      );
      await checkAdmin.query(`DROP DATABASE IF EXISTS ${checkName}`);
      await checkAdmin.end();
    }

    console.log('backup restore tests passed');
  } finally {
    if (!closed) await db.pool.end().catch(() => {});
    fs.rmSync(dumpFile, { force: true });
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
