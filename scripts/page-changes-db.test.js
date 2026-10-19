// The editor and the variant API accept page_css and page_js, and still
// accept the element HTML, CSS and JS types. An unknown type is refused.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { clearSessionSecretCache } = require('../src/session-secret');

process.env.SESSION_SECRET = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim().length >= 32
  ? process.env.SESSION_SECRET
  : 'page-changes-test-secret-32chars-ok';
clearSessionSecretCache();

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
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
        resolve({ status: res.statusCode, text, json });
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
  app.use('/api/editor', require('../src/routes/editor'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const pageChanges = [
  { type: 'page_css', value: 'body{margin:0}' },
  { type: 'page_js', value: 'document.documentElement.classList.add("pivit-offer")' },
  { selector: '#cta', type: 'html', value: '<b>Buy</b>' },
  { selector: '#cta', type: 'js', value: 'el.dataset.ready = "1"' },
  { selector: '#cta', type: 'stylesheet', value: '#cta{color:red}' },
];

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('page changes db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_page_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.APP_ORIGIN;
  delete process.env.PORT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { clearLegacyCache } = require('../src/tenant');
  const { createEditToken } = require('../src/edit-token');

  let server;
  try {
    await migrate();
    clearLegacyCache();
    const legacy = await db.query(
      `SELECT a.id, s.id AS site_id
       FROM accounts a
       JOIN sites s ON s.account_id = a.id
       WHERE a.legacy IS TRUE
       ORDER BY s.created_at
       LIMIT 1`
    );
    const accountId = legacy.rows[0].id;
    const siteId = legacy.rows[0].site_id;
    const inserted = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id, site_id)
       VALUES ('Pricing', '/pricing', 'draft', ARRAY['cantsaythat.co.uk'], '[]'::jsonb, 'shared', true, $1, $2)
       RETURNING id`,
      [accountId, siteId]
    );
    const experimentId = inserted.rows[0].id;
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Offer', 50, $2::jsonb)
       RETURNING id`,
      [experimentId, JSON.stringify([{ selector: 'h1', type: 'text', value: 'Hello' }])]
    );
    const variantId = variant.rows[0].id;
    const token = createEditToken(variantId, undefined, { accountId, siteId });

    server = await listen(appFor({ role: 'owner' }));

    const saved = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { changes: pageChanges }
    );
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.json.changes.length, pageChanges.length);
    assert.strictEqual(saved.json.changes[0].type, 'page_css');
    assert.strictEqual(saved.json.changes[1].type, 'page_js');
    assert.strictEqual(saved.json.changes[2].type, 'html');
    assert.strictEqual(saved.json.changes[3].type, 'js');
    assert.strictEqual(saved.json.changes[4].type, 'stylesheet');

    const rejected = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { changes: [{ type: 'made_up', value: 'no' }] }
    );
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(rejected.json.error, 'unknown change type "made_up"');
    const still = await db.query(`SELECT changes FROM variants WHERE id = $1`, [variantId]);
    assert.strictEqual(still.rows[0].changes[0].type, 'page_css');
    assert.strictEqual(still.rows[0].changes[1].type, 'page_js');

    const renamed = await request(
      server,
      'PATCH',
      `/api/experiments/${experimentId}/variants/${variantId}`,
      { name: 'Offer renamed', traffic_split: 40 }
    );
    assert.strictEqual(renamed.status, 200);
    const untouched = await db.query(`SELECT name, changes FROM variants WHERE id = $1`, [variantId]);
    assert.strictEqual(untouched.rows[0].name, 'Offer renamed');
    assert.strictEqual(untouched.rows[0].changes[0].type, 'page_css');
    assert.strictEqual(untouched.rows[0].changes[4].type, 'stylesheet');

    const replaced = await request(
      server,
      'PATCH',
      `/api/experiments/${experimentId}/variants/${variantId}`,
      { name: 'Offer renamed', traffic_split: 40, changes: pageChanges }
    );
    assert.strictEqual(replaced.status, 200);
    assert.strictEqual(replaced.json.changes[1].type, 'page_js');

    const badPatch = await request(
      server,
      'PATCH',
      `/api/experiments/${experimentId}/variants/${variantId}`,
      { name: 'Offer renamed', traffic_split: 40, changes: [{ type: 'css', value: '.x{}' }] }
    );
    assert.strictEqual(badPatch.status, 400);
    assert.ok(badPatch.json.error.includes('unknown change type'));

    const created = await request(
      server,
      'POST',
      `/api/experiments/${experimentId}/variants`,
      { name: 'Whole page', traffic_split: 10, changes: pageChanges }
    );
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.json.changes[0].type, 'page_css');
    assert.strictEqual(created.json.changes[1].type, 'page_js');
    assert.strictEqual(created.json.changes[2].type, 'html');

    const before = await db.query(`SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1`, [experimentId]);
    const badCreate = await request(
      server,
      'POST',
      `/api/experiments/${experimentId}/variants`,
      { name: 'Broken', traffic_split: 10, changes: [{ type: 'page_script', value: '1' }] }
    );
    assert.strictEqual(badCreate.status, 400);
    assert.strictEqual(badCreate.json.error, 'unknown change type "page_script"');
    const after = await db.query(`SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1`, [experimentId]);
    assert.strictEqual(after.rows[0].n, before.rows[0].n);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('page changes db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
