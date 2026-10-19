// The experiments list and the results endpoints return srmDetected and
// splitCheck. Below 100 visitors the badge stays early, even when p < 0.01.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && String(res.headers['content-type'] || '').includes('json')) json = JSON.parse(text);
        resolve({ status: res.statusCode, text, json, cache: res.headers['cache-control'] });
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
  app.use('/api/client', require('../src/routes/client'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function seedVisitors(db, experimentId, variantId, count, prefix) {
  if (!count) return;
  const params = [experimentId, variantId];
  const values = [];
  for (let i = 0; i < count; i += 1) {
    params.push(`${prefix}-${i}`);
    values.push(`($1, $2, $${params.length}, 'view')`);
  }
  await db.query(
    `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type) VALUES ${values.join(',')}`,
    params
  );
}

async function makeExperiment(db, accountId, name, splits) {
  const inserted = await db.query(
    `INSERT INTO experiments (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id)
     VALUES ($1, 'https://shop.example/pricing', 'running', ARRAY['shop.example'], '[]'::jsonb, 'shared', true, $2)
     RETURNING id`,
    [name, accountId]
  );
  const id = inserted.rows[0].id;
  const variants = [];
  for (let i = 0; i < splits.length; i += 1) {
    const row = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, $2, $3) RETURNING id`,
      [id, i === 0 ? 'Control' : 'variant-b', splits[i]]
    );
    variants.push(row.rows[0].id);
  }
  return { id, variants };
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('split-check db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_split_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let ownerServer;
  let clientServer;
  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;

    const early = await makeExperiment(db, accountId, 'Early split', [50, 50]);
    await seedVisitors(db, early.id, early.variants[0], 10, 'early-a');
    await seedVisitors(db, early.id, early.variants[1], 89, 'early-b');

    const ok = await makeExperiment(db, accountId, 'Even split', [50, 50]);
    await seedVisitors(db, ok.id, ok.variants[0], 60, 'ok-a');
    await seedVisitors(db, ok.id, ok.variants[1], 60, 'ok-b');

    const skewed = await makeExperiment(db, accountId, 'Skewed split', [50, 50]);
    await seedVisitors(db, skewed.id, skewed.variants[0], 104, 'skew-a');
    await seedVisitors(db, skewed.id, skewed.variants[1], 146, 'skew-b');

    const floor = await makeExperiment(db, accountId, 'Just enough', [50, 50]);
    await seedVisitors(db, floor.id, floor.variants[0], 10, 'floor-a');
    await seedVisitors(db, floor.id, floor.variants[1], 90, 'floor-b');

    const client = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Viewer', 'viewer-split', 'hash', $1) RETURNING id`,
      [accountId]
    );
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [client.rows[0].id, skewed.id]);

    ownerServer = await listen(appFor({ role: 'owner' }));
    clientServer = await listen(appFor({ role: 'client', clientId: client.rows[0].id }));

    const list = await request(ownerServer, 'GET', '/api/experiments/all');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.cache, 'no-store');
    const byName = new Map(list.json.experiments.map((row) => [row.name, row]));

    const earlyRow = byName.get('Early split');
    assert.strictEqual(earlyRow.srmDetected, true);
    assert.strictEqual(earlyRow.splitCheck.state, 'early');
    assert.strictEqual(earlyRow.splitCheck.show, false);
    assert.strictEqual(earlyRow.splitCheck.label, 'Too early');
    assert.strictEqual(earlyRow.splitCheck.visitors, 99);
    assert.strictEqual(earlyRow.splitCheck.minVisitors, 100);
    assert.strictEqual(earlyRow.splitCheck.threshold, 0.01);
    assert.strictEqual(earlyRow.splitCheck.srmDetected, true);

    const okRow = byName.get('Even split');
    assert.strictEqual(okRow.srmDetected, false);
    assert.strictEqual(okRow.splitCheck.state, 'ok');
    assert.strictEqual(okRow.splitCheck.show, true);
    assert.strictEqual(okRow.splitCheck.label, 'Split OK');
    assert.strictEqual(okRow.splitCheck.tooltip, 'Visitors are splitting as expected');
    assert.strictEqual(okRow.splitCheck.visitors, 120);

    const skewedRow = byName.get('Skewed split');
    assert.strictEqual(skewedRow.srmDetected, true);
    assert.strictEqual(skewedRow.splitCheck.state, 'skewed');
    assert.strictEqual(skewedRow.splitCheck.show, true);
    assert.strictEqual(skewedRow.splitCheck.label, 'Split skewed');
    assert.strictEqual(skewedRow.splitCheck.tooltip, "Visitors aren't splitting as set; results may be unreliable");
    assert.strictEqual(skewedRow.splitCheck.visitors, 250);
    assert.ok(skewedRow.splitCheck.threshold < 0.05);

    const floorRow = byName.get('Just enough');
    assert.strictEqual(floorRow.srmDetected, true);
    assert.strictEqual(floorRow.splitCheck.state, 'skewed');
    assert.strictEqual(floorRow.splitCheck.visitors, 100);
    assert.strictEqual(floorRow.splitCheck.show, true);

    const srm = await request(ownerServer, 'GET', `/api/results/${skewed.id}/srm`);
    assert.strictEqual(srm.status, 200);
    assert.strictEqual(srm.json.srm_detected, true);
    assert.strictEqual(srm.json.srmDetected, true);
    assert.ok(srm.json.p_value < 0.01);
    assert.strictEqual(srm.json.threshold, 0.01);
    assert.strictEqual(srm.json.splitCheck.state, 'skewed');
    assert.strictEqual(srm.json.splitCheck.show, true);

    const earlyResults = await request(ownerServer, 'GET', `/api/results/${early.id}`);
    assert.strictEqual(earlyResults.status, 200);
    assert.strictEqual(earlyResults.json.srmDetected, true);
    assert.strictEqual(earlyResults.json.splitCheck.state, 'early');
    assert.strictEqual(earlyResults.json.splitCheck.show, false);

    const earlySrm = await request(ownerServer, 'GET', `/api/results/${early.id}/srm`);
    assert.strictEqual(earlySrm.json.srm_detected, true);
    assert.strictEqual(earlySrm.json.splitCheck.state, 'early');
    assert.strictEqual(earlySrm.json.splitCheck.show, false);

    const portal = await request(clientServer, 'GET', '/api/client/experiments');
    assert.strictEqual(portal.status, 200);
    const portalRow = portal.json.experiments.find((row) => row.id === skewed.id);
    assert.ok(portalRow);
    assert.strictEqual(portalRow.srmDetected, true);
    assert.strictEqual(portalRow.splitCheck.state, 'skewed');
    assert.strictEqual(portalRow.splitCheck.label, 'Split skewed');

    const detail = await request(clientServer, 'GET', `/api/client/experiments/${skewed.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.json.splitCheck.state, 'skewed');
    assert.strictEqual(detail.json.splitCheck.show, true);

    const clientResults = await request(clientServer, 'GET', `/api/client/results/${early.id}`);
    assert.strictEqual(clientResults.status, 404);

    const ownedEarly = await request(clientServer, 'GET', `/api/client/results/${skewed.id}`);
    assert.strictEqual(ownedEarly.status, 200);
    assert.strictEqual(ownedEarly.json.splitCheck.state, 'skewed');
    assert.strictEqual(ownedEarly.json.srmDetected, true);
  } finally {
    if (ownerServer) await new Promise((resolve) => ownerServer.close(resolve));
    if (clientServer) await new Promise((resolve) => clientServer.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('split-check db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
