// An element goal is a value in the existing goals JSON. There is no new
// column. The API accepts one CSS selector, trims it, and rejects a blank
// or unsafe selector without changing the saved list. The public snippet
// payload includes the goal.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

const CONFIRM = '#step-confirmation';
const PAGE = 'https://site3-checkout.netlify.app/play';

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) json = JSON.parse(text);
        resolve({ status: res.statusCode, json });
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
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(schema.includes('goals JSONB'));
  assert.ok(migrateSrc.includes("{ version: '019', name: 'activation', run: applyActivation }"));
  assert.ok(!migrateSrc.includes('element_goal'), 'an element goal is stored in the goals JSON, not a new column');

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('element goal db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_element_goal_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let ownerServer;
  let publicServer;
  try {
    await migrate();
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'experiments' AND column_name = 'goals'`
    );
    assert.strictEqual(columns.rows.length, 1);

    const ownerApp = appFor({ role: 'owner' });
    const publicApp = appFor({});
    ownerServer = await listen(ownerApp);
    publicServer = await listen(publicApp);

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Checkout confirmation',
      url_match: PAGE,
      url_match_type: 'contains',
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(created.status, 201);
    const id = created.json.id;

    const saved = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [
        { type: 'click', selector: '#pay-now', name: 'Pay now' },
        { type: 'element', selector: '  ' + CONFIRM + '  ', name: 'Confirmation' },
      ],
    });
    assert.strictEqual(saved.status, 200);
    const element = saved.json.goals.find((goal) => goal.type === 'element');
    assert.ok(element);
    assert.strictEqual(element.selector, CONFIRM);
    assert.strictEqual(element.name, 'Confirmation');
    assert.strictEqual(element.url_match, undefined);
    assert.strictEqual(saved.json.goals.find((goal) => goal.type === 'click').selector, '#pay-now');

    const messy = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'element', selector: 'div { color: red }', name: 'Nope' }],
    });
    assert.strictEqual(messy.status, 400);
    assert.strictEqual(messy.json.error, 'an element goal needs a CSS selector');

    const blank = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'element', selector: '   ', name: 'Nope' }],
    });
    assert.strictEqual(blank.status, 400);
    assert.strictEqual(blank.json.error, 'an element goal needs a selector');

    const unknown = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'later', selector: CONFIRM }],
    });
    assert.strictEqual(unknown.status, 400);
    assert.ok(unknown.json.error.includes('unknown goal type'));

    const long = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'element', selector: 'a'.repeat(501), name: 'Nope' }],
    });
    assert.strictEqual(long.status, 400);
    assert.strictEqual(long.json.error, 'a selector is too long');

    const kept = await db.query(`SELECT goals FROM experiments WHERE id = $1`, [id]);
    assert.strictEqual(kept.rows[0].goals.find((goal) => goal.type === 'element').selector, CONFIRM);
    const variantGoals = await db.query(`SELECT goals FROM variants WHERE experiment_id = $1`, [id]);
    variantGoals.rows.forEach((row) => {
      assert.strictEqual(row.goals.find((goal) => goal.type === 'element').selector, CONFIRM);
    });

    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [id]);
    const page = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent(PAGE)
    );
    assert.strictEqual(page.status, 200);
    const match = page.json.experiments.find((row) => row.id === id);
    assert.ok(match);
    const served = match.goals.find((goal) => goal.type === 'element');
    assert.strictEqual(served.selector, CONFIRM);
    assert.strictEqual(served.name, 'Confirmation');

    console.log('element goal db tests passed');
  } finally {
    if (publicServer) publicServer.close();
    if (ownerServer) ownerServer.close();
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
