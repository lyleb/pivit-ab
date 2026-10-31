// activation_type defaults to page_load. An element start stores one CSS
// selector. The public snippet payload carries both. Existing tests that
// omit the fields still start when the page loads.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(!schema.includes('activation_type'), 'activation columns stay out of schema.sql');
  assert.ok(migrateSrc.includes("{ version: '019', name: 'activation', run: applyActivation }"));
  assert.ok(migrateSrc.indexOf("version: '018'") < migrateSrc.indexOf("version: '019'"));
  assert.ok(migrateSrc.includes("{ version: '022', name: 'element-activation-selector', run: applyElementActivationSelector }"));
  assert.ok(!schema.includes('element_selector = NULL'), 'the data fix stays out of schema.sql');

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('activation db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_activation_' + Date.now().toString(36);
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
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'experiments' AND column_name IN ('activation_type', 'activation_value')
       ORDER BY column_name`
    );
    assert.strictEqual(columns.rows.length, 2);
    const type = columns.rows.find((row) => row.column_name === 'activation_type');
    const value = columns.rows.find((row) => row.column_name === 'activation_value');
    assert.strictEqual(type.is_nullable, 'NO');
    assert.ok(String(type.column_default).includes('page_load'));
    assert.strictEqual(value.is_nullable, 'YES');
    assert.strictEqual(value.column_default, null);

    const ownerApp = appFor({ role: 'owner' });
    const publicApp = appFor({});
    ownerServer = await listen(ownerApp);
    publicServer = await listen(publicApp);

    const plain = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Homepage',
      url_match: 'https://site3-checkout.netlify.app/play',
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(plain.status, 201);
    assert.strictEqual(plain.json.activation_type, 'page_load');
    assert.strictEqual(plain.json.activation_value, null);

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Payment step',
      url_match: 'https://site3-checkout.netlify.app/play',
      url_match_type: 'contains',
      activation_type: 'element',
      activation_value: '  #step-payment  ',
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.json.activation_type, 'element');
    assert.strictEqual(created.json.activation_value, '#step-payment');
    const id = created.json.id;

    const staleCreate = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Stale selector',
      url_match: 'https://site3-checkout.netlify.app/play',
      url_match_type: 'contains',
      activation_type: 'element',
      activation_value: '#step-payment',
      element_selector: '#payment-step',
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(staleCreate.status, 201);
    assert.strictEqual(staleCreate.json.element_selector, null);

    await db.query(`UPDATE experiments SET element_selector = '#payment-step' WHERE id = $1`, [id]);
    const clearedSelector = await request(ownerServer, 'PATCH', `/api/experiments/${id}/activation`, {
      activation_type: 'element',
      activation_value: '#step-payment',
    });
    assert.strictEqual(clearedSelector.status, 200);
    assert.strictEqual(clearedSelector.json.element_selector, null);

    await db.query(
      `UPDATE experiments SET activation_type = 'element', activation_value = '#step-payment', element_selector = '#payment-step' WHERE id = $1`,
      [staleCreate.json.id]
    );
    const { applyElementActivationSelector } = require('../src/db/element-activation-selector');
    await applyElementActivationSelector(db);
    const migrated = await db.query(`SELECT element_selector FROM experiments WHERE id = $1`, [staleCreate.json.id]);
    assert.strictEqual(migrated.rows[0].element_selector, null);
    await db.query(`UPDATE experiments SET element_selector = '#pay-now', activation_type = 'page_load' WHERE id = $1`, [plain.json.id]);
    await applyElementActivationSelector(db);
    const stillLegacy = await db.query(`SELECT element_selector, activation_type FROM experiments WHERE id = $1`, [plain.json.id]);
    assert.strictEqual(stillLegacy.rows[0].element_selector, '#pay-now');
    assert.strictEqual(stillLegacy.rows[0].activation_type, 'page_load');
    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [id]);

    const page = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://site3-checkout.netlify.app/play')
    );
    assert.strictEqual(page.status, 200);
    const match = page.json.experiments.find((row) => row.id === id);
    assert.ok(match);
    assert.strictEqual(match.activation_type, 'element');
    assert.strictEqual(match.activation_value, '#step-payment');
    const home = page.json.experiments.find((row) => row.id === plain.json.id);
    assert.strictEqual(home, undefined);

    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [plain.json.id]);
    const again = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://site3-checkout.netlify.app/play')
    );
    const loaded = again.json.experiments.find((row) => row.id === plain.json.id);
    assert.strictEqual(loaded.activation_type, 'page_load');
    assert.strictEqual(loaded.activation_value, '');

    const messy = await request(ownerServer, 'PATCH', `/api/experiments/${id}/activation`, {
      activation_type: 'element',
      activation_value: 'div { color: red }',
    });
    assert.strictEqual(messy.status, 400);
    const kept = await db.query(`SELECT activation_type, activation_value FROM experiments WHERE id = $1`, [id]);
    assert.strictEqual(kept.rows[0].activation_type, 'element');
    assert.strictEqual(kept.rows[0].activation_value, '#step-payment');

    const empty = await request(ownerServer, 'PATCH', `/api/experiments/${id}/activation`, {
      activation_type: 'element',
      activation_value: '  ',
    });
    assert.strictEqual(empty.status, 400);

    const omitted = await request(ownerServer, 'PATCH', `/api/experiments/${id}/activation`, {});
    assert.strictEqual(omitted.status, 400);

    const cleared = await request(ownerServer, 'PATCH', `/api/experiments/${id}/activation`, {
      activation_type: 'page_load',
      activation_value: '#step-payment',
    });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.json.activation_type, 'page_load');
    assert.strictEqual(cleared.json.activation_value, null);

    const detail = await request(ownerServer, 'GET', `/api/experiments/${id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.json.activation_type, 'page_load');
    assert.strictEqual(detail.json.activation_value, null);

    const condition = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Step 3 condition',
      url_match: 'https://site3-checkout.netlify.app/play',
      url_match_type: 'contains',
      activation_type: 'js_condition',
      activation_value: "  document.getElementById('step-payment')  ",
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(condition.status, 201);
    assert.strictEqual(condition.json.activation_type, 'js_condition');
    assert.strictEqual(condition.json.activation_value, "document.getElementById('step-payment')");

    const manual = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Step 3 manual',
      url_match: 'https://site3-checkout.netlify.app/play',
      url_match_type: 'contains',
      activation_type: 'manual',
      activation_value: 'ignored',
      allowed_hosts: ['site3-checkout.netlify.app'],
    });
    assert.strictEqual(manual.status, 201);
    assert.strictEqual(manual.json.activation_type, 'manual');
    assert.strictEqual(manual.json.activation_value, null);

    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1 OR id = $2`, [
      condition.json.id,
      manual.json.id,
    ]);
    const live = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://site3-checkout.netlify.app/play')
    );
    const liveCondition = live.json.experiments.find((row) => row.id === condition.json.id);
    const liveManual = live.json.experiments.find((row) => row.id === manual.json.id);
    assert.strictEqual(liveCondition.activation_type, 'js_condition');
    assert.strictEqual(liveCondition.activation_value, "document.getElementById('step-payment')");
    assert.strictEqual(liveManual.activation_type, 'manual');
    assert.strictEqual(liveManual.activation_value, '');

    const blankCondition = await request(ownerServer, 'PATCH', `/api/experiments/${condition.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: '   ',
    });
    assert.strictEqual(blankCondition.status, 400);
    const longCondition = await request(ownerServer, 'PATCH', `/api/experiments/${condition.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: 'a'.repeat(501),
    });
    assert.strictEqual(longCondition.status, 400);
    const brokenLine = await request(ownerServer, 'PATCH', `/api/experiments/${condition.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: 'checkout.step === 3\n&& false',
    });
    assert.strictEqual(brokenLine.status, 400);
    const stillCondition = await db.query(
      `SELECT activation_type, activation_value FROM experiments WHERE id = $1`,
      [condition.json.id]
    );
    assert.strictEqual(stillCondition.rows[0].activation_type, 'js_condition');
    assert.strictEqual(stillCondition.rows[0].activation_value, "document.getElementById('step-payment')");

    const clientServer = await listen(appFor({ role: 'client' }));
    const viewerDenied = await request(clientServer, 'PATCH', `/api/experiments/${condition.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: 'true',
    });
    assert.strictEqual(viewerDenied.status, 401);
    clientServer.close();

    const legacy = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE LIMIT 1`);
    const memberUser = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member-activation@example.com', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [legacy.rows[0].id, memberUser.rows[0].id]
    );
    const memberServer = await listen(appFor({
      role: 'owner',
      userId: memberUser.rows[0].id,
      accountId: legacy.rows[0].id,
    }));
    const memberSet = await request(memberServer, 'PATCH', `/api/experiments/${manual.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: "document.getElementById('step-payment')",
    });
    assert.strictEqual(memberSet.status, 200);
    assert.strictEqual(memberSet.json.activation_type, 'js_condition');
    const memberSame = await request(memberServer, 'PATCH', `/api/experiments/${manual.json.id}/activation`, {
      activation_type: 'js_condition',
      activation_value: "document.getElementById('step-payment')",
    });
    assert.strictEqual(memberSame.status, 200);
    memberServer.close();

    console.log('activation db tests passed');
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
