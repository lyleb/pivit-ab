// Migration 020 adds variants.steps_note. Existing rows stay blank. The editor
// can save the note on its own, and a rename from the dashboard leaves it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { clearSessionSecretCache } = require('../src/session-secret');

process.env.SESSION_SECRET = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim().length >= 32
  ? process.env.SESSION_SECRET
  : 'steps-note-test-secret-32chars-ok';
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
  app.use('/api/editor', require('../src/routes/editor'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(!schema.includes('steps_note'), 'steps_note stays out of schema.sql');
  assert.ok(migrateSrc.includes("{ version: '020', name: 'steps-note', run: applyStepsNote }"));
  assert.ok(migrateSrc.indexOf("version: '019'") < migrateSrc.indexOf("version: '020'"));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('steps note db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_steps_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { clearLegacyCache } = require('../src/tenant');
  const { createEditToken } = require('../src/edit-token');

  let server;
  try {
    await migrate();
    const column = await db.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'variants' AND column_name = 'steps_note'`
    );
    assert.strictEqual(column.rows.length, 1);
    assert.strictEqual(column.rows[0].is_nullable, 'NO');
    assert.ok(String(column.rows[0].column_default).includes("''") || String(column.rows[0].column_default).includes("::text"));

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
       VALUES ('Checkout', 'https://site3-checkout.netlify.app/play', 'running', ARRAY['site3-checkout.netlify.app'], '[]'::jsonb, 'shared', true, $1, $2)
       RETURNING id`,
      [accountId, siteId]
    );
    const experimentId = inserted.rows[0].id;
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Offer', 50, '[]'::jsonb)
       RETURNING id, steps_note`,
      [experimentId]
    );
    const variantId = variant.rows[0].id;
    assert.strictEqual(variant.rows[0].steps_note, '');
    const token = createEditToken(variantId, undefined, { accountId, siteId });
    server = await listen(appFor({ role: 'owner' }));

    const noted = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { steps_note: '  Click   Continue twice  ' }
    );
    assert.strictEqual(noted.status, 200);
    assert.strictEqual(noted.json.steps_note, 'Click Continue twice');
    assert.deepStrictEqual(noted.json.changes, []);

    const kept = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { changes: [{ selector: 'h1', type: 'text', value: 'Pay now' }] }
    );
    assert.strictEqual(kept.status, 200);
    assert.strictEqual(kept.json.steps_note, 'Click Continue twice');
    assert.strictEqual(kept.json.changes[0].value, 'Pay now');

    const tooLong = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { steps_note: 'x'.repeat(281) }
    );
    assert.strictEqual(tooLong.status, 400);

    const renamed = await request(
      server,
      'PATCH',
      `/api/experiments/${experimentId}/variants/${variantId}`,
      { name: 'Offer renamed', traffic_split: 40 }
    );
    assert.strictEqual(renamed.status, 200);
    const still = await db.query(`SELECT steps_note, changes FROM variants WHERE id = $1`, [variantId]);
    assert.strictEqual(still.rows[0].steps_note, 'Click Continue twice');
    assert.strictEqual(still.rows[0].changes[0].value, 'Pay now');

    const loaded = await request(
      server,
      'GET',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`
    );
    assert.strictEqual(loaded.status, 200);
    assert.strictEqual(loaded.json.steps_note, 'Click Continue twice');

    const page = await request(
      server,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://site3-checkout.netlify.app/play')
    );
    assert.strictEqual(page.status, 200);
    const match = page.json.experiments.find((row) => row.id === experimentId);
    assert.ok(match);
    const offered = match.variants.find((row) => row.id === variantId);
    assert.strictEqual(offered.steps_note, 'Click Continue twice');

    const cleared = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { steps_note: '   ' }
    );
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.json.steps_note, '');
    const again = await request(
      server,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://site3-checkout.netlify.app/play')
    );
    const quiet = again.json.experiments.find((row) => row.id === experimentId).variants.find((row) => row.id === variantId);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(quiet, 'steps_note'), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('steps note db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
