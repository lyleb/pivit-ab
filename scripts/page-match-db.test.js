// Page match and test-traffic results against local Postgres.
// Skips when Postgres is not reachable. Never reads DATABASE_URL.
// TEST_DATABASE_URL (CI) fails the run if it cannot connect.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) {
          json = JSON.parse(text);
        }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function appFor(session) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session || {};
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/results', require('../src/routes/results'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function ids(payload) {
  return (payload.experiments || []).map((exp) => exp.id);
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('page-match db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_page_match_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let publicServer;
  let ownerServer;
  let clientServer;
  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;

    // Stored the way Home - Winter Sale already is: homepage text, no match
    // type of its own. The column default is contains, so /checkout still runs it.
    const winter = await db.query(
      `INSERT INTO experiments (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id)
       VALUES ('Home - Winter Sale', 'https://cantsaythat.co.uk/', 'running', $1::text[], '[]'::jsonb, 'shared', true, $2)
       RETURNING id, url_match_type`,
      [['cantsaythat.co.uk'], accountId]
    );
    assert.strictEqual(winter.rows[0].url_match_type, 'contains');
    const winterId = winter.rows[0].id;

    const ownerApp = appFor({ role: 'owner' });
    const publicApp = appFor({});
    ownerServer = await listen(ownerApp);
    publicServer = await listen(publicApp);

    async function runningOn(url) {
      const listed = await request(publicServer, 'GET', '/api/experiments?url=' + encodeURIComponent(url));
      assert.strictEqual(listed.status, 200);
      return ids(listed.json);
    }

    assert.ok((await runningOn('https://cantsaythat.co.uk/checkout')).includes(winterId));
    assert.ok((await runningOn('https://cantsaythat.co.uk/shop')).includes(winterId));
    assert.ok((await runningOn('https://cantsaythat.co.uk/')).includes(winterId));

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Homepage exact',
      url_match: 'https://cantsaythat.co.uk/',
      allowed_hosts: ['cantsaythat.co.uk'],
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.json.url_match_type, 'exact');
    const exactId = created.json.id;
    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [exactId]);

    const checkoutIds = await runningOn('https://cantsaythat.co.uk/checkout');
    assert.ok(checkoutIds.includes(winterId));
    assert.ok(!checkoutIds.includes(exactId));
    const homeIds = await runningOn('https://cantsaythat.co.uk/?utm=winter#sale');
    assert.ok(homeIds.includes(exactId));
    assert.ok((await runningOn('https://cantsaythat.co.uk')).includes(exactId));
    assert.ok(!(await runningOn('https://cantsaythat.co.uk/about')).includes(exactId));

    const explicit = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Homepage contains on purpose',
      url_match: 'https://cantsaythat.co.uk/',
      url_match_type: 'contains',
      allowed_hosts: ['cantsaythat.co.uk'],
    });
    assert.strictEqual(explicit.status, 201);
    assert.strictEqual(explicit.json.url_match_type, 'contains');
    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [explicit.json.id]);
    assert.ok((await runningOn('https://cantsaythat.co.uk/checkout')).includes(explicit.json.id));

    const about = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'About',
      url_match: '/about',
      allowed_hosts: ['cantsaythat.co.uk'],
    });
    assert.strictEqual(about.json.url_match_type, 'contains');
    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [about.json.id]);
    assert.ok((await runningOn('https://cantsaythat.co.uk/about-us')).includes(about.json.id));

    const omitted = await request(ownerServer, 'PATCH', `/api/experiments/${winterId}/url-match`, {});
    assert.strictEqual(omitted.status, 400);
    const still = await db.query(`SELECT url_match_type FROM experiments WHERE id = $1`, [winterId]);
    assert.strictEqual(still.rows[0].url_match_type, 'contains');

    const switched = await request(ownerServer, 'PATCH', `/api/experiments/${winterId}/url-match`, {
      url_match_type: 'exact',
    });
    assert.strictEqual(switched.status, 200);
    assert.strictEqual(switched.json.url_match_type, 'exact');
    assert.ok(!(await runningOn('https://cantsaythat.co.uk/checkout')).includes(winterId));
    assert.ok((await runningOn('https://cantsaythat.co.uk/')).includes(winterId));
    // Put it back so the rest of the file is about a contains homepage, the
    // stored shape the live test keeps until someone saves Exact.
    await db.query(`UPDATE experiments SET url_match_type = 'contains' WHERE id = $1`, [winterId]);
    assert.ok((await runningOn('https://cantsaythat.co.uk/shop')).includes(winterId));

    const plan = {
      source: 'owner',
      visitors_per_variant: 1000,
      min_runtime_days: 14,
      baseline_rate: 0.03,
      relative_effect: 0.2,
    };
    const blind = await db.query(
      `INSERT INTO experiments (name, url_match, url_match_type, status, allowed_hosts, goals, goals_scope, goals_migrated, plan, started_at, account_id)
       VALUES ('Blind sale', '/pricing', 'contains', 'running', $1::text[], '[]'::jsonb, 'shared', true, $2::jsonb, now(), $3)
       RETURNING id`,
      [['shop.example'], JSON.stringify(plan), accountId]
    );
    const blindId = blind.rows[0].id;
    const control = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50) RETURNING id`,
      [blindId]
    );
    const controlId = control.rows[0].id;

    async function track(visitorId, eventType, isTest) {
      await db.query(
        `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
        [blindId, controlId, visitorId, eventType, isTest]
      );
    }
    await track('v_real_a', 'view', false);
    await track('v_real_a', 'convert', false);
    await track('v_real_b', 'view', false);
    await track('v_test_a', 'view', true);
    await track('v_test_a', 'convert', true);
    await track('v_test_b', 'view', true);
    await track('v_test_b', 'convert', true);
    await track('v_test_c', 'view', true);

    const beforePeek = await db.query(`SELECT peeked_at FROM experiments WHERE id = $1`, [blindId]);
    assert.strictEqual(beforePeek.rows[0].peeked_at, null);

    const hidden = await request(ownerServer, 'GET', `/api/results/${blindId}`);
    assert.strictEqual(hidden.json.blinded, true);
    assert.strictEqual(hidden.json.reading.mode, 'blind');
    const hiddenControl = hidden.json.results.find((row) => row.variant_name === 'Control');
    assert.strictEqual(hiddenControl.visitors, 2);
    assert.strictEqual(hiddenControl.conversions, undefined);

    const testView = await request(ownerServer, 'GET', `/api/results/${blindId}/test-traffic`);
    assert.strictEqual(testView.status, 200);
    assert.strictEqual(testView.json.test_only, true);
    assert.strictEqual(testView.json.blinded, false);
    assert.strictEqual(testView.json.peeked, false);
    assert.ok(testView.json.label.includes('Test traffic only'));
    assert.ok(testView.json.label.includes('early look'));
    const testControl = testView.json.results.find((row) => row.variant_name === 'Control');
    assert.strictEqual(testControl.visitors, 3);
    assert.strictEqual(testControl.conversions, 2);
    assert.ok(testControl.conversion_rate != null);
    assert.ok(!JSON.stringify(testView.json).includes('v_real_a'));

    const afterPeek = await db.query(`SELECT peeked_at FROM experiments WHERE id = $1`, [blindId]);
    assert.strictEqual(afterPeek.rows[0].peeked_at, null);

    const progressCsv = await request(ownerServer, 'GET', `/api/results/${blindId}/export`);
    assert.ok(progressCsv.headers['content-disposition'].includes('progress.csv'));
    assert.ok(!progressCsv.text.includes('v_test_a'));
    assert.ok(!progressCsv.text.includes('convert'));

    const testCsv = await request(ownerServer, 'GET', `/api/results/${blindId}/export?test_only=1`);
    assert.strictEqual(testCsv.status, 200);
    assert.ok(testCsv.headers['content-disposition'].includes('test-traffic.csv'));
    assert.ok(testCsv.text.startsWith('created_at,event_type'));
    assert.ok(testCsv.text.includes(',traffic'));
    assert.ok(testCsv.text.includes('v_test_a'));
    assert.ok(testCsv.text.includes('convert'));
    assert.ok(testCsv.text.includes(',test'));
    assert.ok(!testCsv.text.includes('v_real_a'));
    assert.ok(!testCsv.text.includes('v_real_b'));

    const stillHidden = await request(ownerServer, 'GET', `/api/results/${blindId}`);
    assert.strictEqual(stillHidden.json.blinded, true);
    assert.strictEqual(stillHidden.json.reading.peeked, false);
    const peekedAt = await db.query(`SELECT peeked_at FROM experiments WHERE id = $1`, [blindId]);
    assert.strictEqual(peekedAt.rows[0].peeked_at, null);

    const clientRow = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id) VALUES ('Portal', $1, 'x', $2) RETURNING id`,
      ['portal-' + Date.now().toString(36), accountId]
    );
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [clientRow.rows[0].id, blindId]);
    clientServer = await listen(appFor({ role: 'client', clientId: clientRow.rows[0].id }));
    const portal = await request(clientServer, 'GET', `/api/results/${blindId}/test-traffic`);
    assert.strictEqual(portal.status, 401);
    const portalCsv = await request(clientServer, 'GET', `/api/results/${blindId}/export?test_only=1`);
    assert.strictEqual(portalCsv.status, 401);

    console.log('page-match db tests passed');
  } finally {
    if (publicServer) publicServer.close();
    if (ownerServer) ownerServer.close();
    if (clientServer) clientServer.close();
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
