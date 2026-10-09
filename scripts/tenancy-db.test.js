// Migration 001 against a database that looks like production before accounts
// existed: schema.sql applied, then rows inserted, then the versioned migrator.
// A totals mismatch rolls the tenancy step back. A second run applies nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pg = require('./test-postgres');

const PASSWORD_HASH = 'hash-do-not-log-9f3a';

async function columnExists(db, table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function seed(db) {
  const client = await db.query(
    `INSERT INTO clients (name, username, password_hash)
     VALUES ('Can not say', 'cst-owner', $1) RETURNING id`,
    [PASSWORD_HASH]
  );
  const clientId = client.rows[0].id;
  const shop = await db.query(
    `INSERT INTO experiments (name, url_match, status, allowed_hosts, client_id)
     VALUES ('Shop tag colours', 'https://cantsaythat.co.uk/shop', 'running', $1::text[], $2)
     RETURNING id`,
    [['cantsaythat.co.uk'], clientId]
  );
  const loose = await db.query(
    `INSERT INTO experiments (name, url_match, status, allowed_hosts)
     VALUES ('Needs a site', '/draft-only', 'draft', '{}'::text[])
     RETURNING id`
  );
  const other = await db.query(
    `INSERT INTO experiments (name, url_match, status, allowed_hosts)
     VALUES ('Other host', 'https://shop.example/page', 'paused', $1::text[])
     RETURNING id`,
    [['shop.example']]
  );
  const variant = await db.query(
    `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
    [shop.rows[0].id]
  );
  await db.query(
    `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test, excluded_at)
     VALUES ($1, $2, 'visitor-real', 'view', false, NULL),
            ($1, $2, 'visitor-test', 'view', true, NULL),
            ($1, $2, 'visitor-hidden', 'convert', false, now())`,
    [shop.rows[0].id, variant.rows[0].id]
  );
  await db.query(
    `INSERT INTO test_traffic_audit
       (experiment_id, action, actor, criteria, visitor_count, event_count)
     VALUES ($1, 'remove', 'owner', '{"mode":"test"}'::jsonb, 1, 1)`,
    [shop.rows[0].id]
  );
  await db.query(
    `INSERT INTO host_hits (day, host, referrer_origin, hit_count)
     VALUES ('2026-10-01', 'pivitlab.com', 'https://cantsaythat.co.uk', 12)`
  );
  return { clientId, shopId: shop.rows[0].id, looseId: loose.rows[0].id, otherId: other.rows[0].id };
}

async function identity(db) {
  const experiments = await db.query(
    `SELECT id::text, name, status, url_match, allowed_hosts, client_id::text AS client_id
     FROM experiments ORDER BY id`
  );
  const clients = await db.query(
    `SELECT id::text, name, username, password_hash FROM clients ORDER BY id`
  );
  const totals = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM experiments) AS experiments,
      (SELECT COUNT(*)::int FROM variants) AS variants,
      (SELECT COUNT(*)::int FROM events) AS events,
      (SELECT COUNT(*)::int FROM events WHERE is_test) AS test_events,
      (SELECT COUNT(*)::int FROM events WHERE excluded_at IS NOT NULL) AS excluded_events,
      (SELECT COUNT(*)::int FROM test_traffic_audit) AS audit_rows,
      (SELECT COUNT(*)::int FROM clients) AS clients,
      (SELECT COUNT(*)::int FROM host_hits) AS host_hits
  `);
  return { experiments: experiments.rows, clients: clients.rows, totals: totals.rows[0] };
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('tenancy db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_tenancy_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { LEGACY_ACCOUNT_NAME, SUPERADMIN_EMAIL, PRIMARY_SITE_HOST } = require('../src/db/tenancy');

  try {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query(schema);
    const seeded = await seed(db);
    const before = await identity(db);
    assert.strictEqual(before.clients[0].password_hash, PASSWORD_HASH);

    process.env.PIVIT_TENANCY_FAULT = 'totals';
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let faulted = null;
    try {
      await migrate();
    } catch (err) {
      faulted = err;
    } finally {
      console.log = originalLog;
    }
    assert.ok(faulted, 'totals mismatch should roll the migration back');
    assert.ok(faulted.message.includes('rolled back'));
    assert.strictEqual(faulted.cause && faulted.cause.code, 'TENANCY_MISMATCH');
    assert.ok(!faulted.message.includes(PASSWORD_HASH));
    assert.ok(logs.every((line) => !line.includes(PASSWORD_HASH)));
    assert.strictEqual(await columnExists(db, 'experiments', 'account_id'), false);
    const rolled = await identity(db);
    assert.deepStrictEqual(rolled.totals, before.totals);
    assert.deepStrictEqual(rolled.clients, before.clients);
    assert.deepStrictEqual(rolled.experiments, before.experiments);
    const versionsAfterFault = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepStrictEqual(versionsAfterFault.rows.map((row) => row.version), ['000']);

    delete process.env.PIVIT_TENANCY_FAULT;
    const applied = await migrate();
    assert.deepStrictEqual(applied, ['001', '002', '003']);
    const after = await identity(db);
    assert.deepStrictEqual(after.totals, before.totals);
    assert.deepStrictEqual(after.experiments, before.experiments);
    assert.strictEqual(after.clients[0].username, 'cst-owner');
    assert.strictEqual(after.clients[0].password_hash, PASSWORD_HASH);

    const account = await db.query(
      `SELECT a.id, a.name, a.legacy, u.email, u.is_superadmin, u.verified_at, m.role
       FROM accounts a
       JOIN memberships m ON m.account_id = a.id
       JOIN users u ON u.id = m.user_id
       WHERE a.legacy IS TRUE`
    );
    assert.strictEqual(account.rows.length, 1);
    assert.strictEqual(account.rows[0].name, LEGACY_ACCOUNT_NAME);
    assert.strictEqual(account.rows[0].email, SUPERADMIN_EMAIL);
    assert.strictEqual(account.rows[0].is_superadmin, true);
    assert.strictEqual(account.rows[0].verified_at, null);
    assert.strictEqual(account.rows[0].role, 'owner');
    const accountId = account.rows[0].id;

    const sites = await db.query(
      `SELECT name, domains, public_key, verified_at IS NOT NULL AS verified
       FROM sites WHERE account_id = $1 ORDER BY name`,
      [accountId]
    );
    const primary = sites.rows.find((row) => row.name === PRIMARY_SITE_HOST);
    assert.ok(primary, 'cantsaythat.co.uk is created even when no test uses only that host list');
    assert.deepStrictEqual(primary.domains, [PRIMARY_SITE_HOST]);
    assert.strictEqual(primary.verified, true);
    assert.ok(/^site_[a-f0-9]{16,80}$/i.test(primary.public_key));

    const placed = await db.query(
      `SELECT id::text, site_id IS NOT NULL AS has_site, needs_site
       FROM experiments WHERE id = ANY($1::uuid[])`,
      [[seeded.shopId, seeded.looseId, seeded.otherId]]
    );
    const byId = Object.fromEntries(placed.rows.map((row) => [row.id, row]));
    assert.strictEqual(byId[seeded.shopId].needs_site, false);
    assert.strictEqual(byId[seeded.shopId].has_site, true);
    assert.strictEqual(byId[seeded.looseId].needs_site, true);
    assert.strictEqual(byId[seeded.looseId].has_site, false);
    assert.strictEqual(byId[seeded.otherId].needs_site, false);

    const shopHosts = await db.query(`SELECT allowed_hosts FROM experiments WHERE id = $1`, [seeded.shopId]);
    assert.deepStrictEqual(shopHosts.rows[0].allowed_hosts, ['cantsaythat.co.uk']);

    const child = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM variants WHERE account_id = $1) AS variants,
         (SELECT COUNT(*)::int FROM events WHERE account_id = $1) AS events,
         (SELECT COUNT(*)::int FROM clients WHERE account_id = $1) AS clients,
         (SELECT COUNT(*)::int FROM host_hits WHERE account_id = $1) AS hits`,
      [accountId]
    );
    assert.strictEqual(child.rows[0].variants, 1);
    assert.strictEqual(child.rows[0].events, 3);
    assert.strictEqual(child.rows[0].clients, 1);
    assert.strictEqual(child.rows[0].hits, 1);

    await assert.rejects(
      db.query(`INSERT INTO accounts (name, legacy) VALUES ('Second legacy', true)`),
      (err) => err.code === '23505'
    );

    const again = await migrate();
    assert.deepStrictEqual(again, []);
    const { applyTenancy } = require('../src/db/tenancy');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenancy(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const still = await identity(db);
    assert.deepStrictEqual(still.clients, after.clients);
    assert.deepStrictEqual(still.experiments, after.experiments);

    console.log('tenancy db tests passed');
  } finally {
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
