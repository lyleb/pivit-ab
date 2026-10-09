// Start, pause and archive. A status write without archive: true must not
// archive the experiment, and the response status is the row that was stored.
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
    console.log('status db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_status_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let server;
  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;

    async function makeExperiment(name, status) {
      const inserted = await db.query(
        `INSERT INTO experiments (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id)
         VALUES ($1, 'https://shop.example/', $2, ARRAY['shop.example'], '[]'::jsonb, 'shared', true, $3)
         RETURNING id`,
        [name, status, accountId]
      );
      return inserted.rows[0].id;
    }

    async function stored(id) {
      const { rows } = await db.query(`SELECT status FROM experiments WHERE id = $1`, [id]);
      return rows[0].status;
    }

    const running = await makeExperiment('Live', 'running');
    const draft = await makeExperiment('Draft', 'draft');
    server = await listen(appFor({ role: 'owner' }));

    const paused = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'paused' });
    assert.strictEqual(paused.status, 200);
    assert.strictEqual(paused.json.status, 'paused');
    assert.strictEqual(paused.cache, 'no-store');
    assert.strictEqual(await stored(running), 'paused');

    const stillPaused = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'paused' });
    assert.strictEqual(stillPaused.status, 200);
    assert.strictEqual(stillPaused.json.status, 'paused');
    assert.strictEqual(await stored(running), 'paused');

    const slipped = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'archived' });
    assert.strictEqual(slipped.status, 400);
    assert.strictEqual(await stored(running), 'paused');

    const stringFlag = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'archived', archive: 'true' });
    assert.strictEqual(stringFlag.status, 400);
    assert.strictEqual(await stored(running), 'paused');

    const resumed = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'running' });
    assert.strictEqual(resumed.status, 200);
    assert.strictEqual(resumed.json.status, 'running');
    assert.strictEqual(await stored(running), 'running');

    const started = await request(server, 'PATCH', `/api/experiments/${draft}/status`, { status: 'running' });
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.json.status, 'running');
    assert.strictEqual(await stored(draft), 'running');

    const archived = await request(server, 'PATCH', `/api/experiments/${running}/status`, { status: 'archived', archive: true });
    assert.strictEqual(archived.status, 200);
    assert.strictEqual(archived.json.status, 'archived');
    assert.strictEqual(await stored(running), 'archived');
    assert.strictEqual(await stored(draft), 'running');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('status db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
