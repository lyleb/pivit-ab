// Element selector column and the public payload. The URL rule still decides
// whether the experiment is returned. The selector rides along for the snippet.
// Skips when Postgres is not reachable. Never reads DATABASE_URL.
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
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('element-target db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_element_' + Date.now().toString(36);
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
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;
    const column = await db.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'experiments' AND column_name = 'element_selector'`
    );
    assert.strictEqual(column.rows[0].is_nullable, 'YES');

    const ownerApp = appFor({ role: 'owner' });
    const publicApp = appFor({});
    ownerServer = await listen(ownerApp);
    publicServer = await listen(publicApp);

    const plain = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Homepage',
      url_match: 'https://cantsaythat.co.uk/',
      allowed_hosts: ['cantsaythat.co.uk'],
    });
    assert.strictEqual(plain.status, 201);
    assert.strictEqual(plain.json.element_selector, null);

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'T-shirt social proof',
      url_match: 'https://cantsaythat.co.uk',
      url_match_type: 'contains',
      element_selector: '  button[name="add"]  ',
      allowed_hosts: ['cantsaythat.co.uk'],
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.json.element_selector, 'button[name="add"]');
    const id = created.json.id;
    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [id]);

    const product = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://cantsaythat.co.uk/products/graphic-t-shirt')
    );
    assert.strictEqual(product.status, 200);
    const match = product.json.experiments.find((row) => row.id === id);
    assert.ok(match);
    assert.strictEqual(match.element_selector, 'button[name="add"]');
    assert.strictEqual(match.url_match, 'https://cantsaythat.co.uk');

    const otherHost = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://example.com/products/graphic-t-shirt')
    );
    assert.ok(!(otherHost.json.experiments || []).some((row) => row.id === id));

    const messy = await request(ownerServer, 'PATCH', `/api/experiments/${id}/element-selector`, {
      element_selector: 'div { color: red }',
    });
    assert.strictEqual(messy.status, 400);
    const kept = await db.query(`SELECT element_selector FROM experiments WHERE id = $1`, [id]);
    assert.strictEqual(kept.rows[0].element_selector, 'button[name="add"]');

    const omitted = await request(ownerServer, 'PATCH', `/api/experiments/${id}/element-selector`, {});
    assert.strictEqual(omitted.status, 400);

    const cleared = await request(ownerServer, 'PATCH', `/api/experiments/${id}/element-selector`, {
      element_selector: '  ',
    });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.json.element_selector, null);
    const after = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://cantsaythat.co.uk/products/graphic-t-shirt')
    );
    const clearedRow = after.json.experiments.find((row) => row.id === id);
    assert.strictEqual(clearedRow.element_selector, '');

    const restored = await request(ownerServer, 'PATCH', `/api/experiments/${id}/element-selector`, {
      element_selector: '.product-form__submit',
    });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.json.element_selector, '.product-form__submit');

    console.log('element-target db tests passed');
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
