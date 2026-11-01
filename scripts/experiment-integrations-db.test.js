// Migration 024 adds experiments.ga4_enabled and experiments.datalayer_events,
// both defaulting on so an existing test keeps today's behaviour.
// An Owner can change them. A Member cannot. The public snippet receives
// the ticks, and omits the GA4 measurement id when every test on the
// response has Send to GA4 unticked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { VIEW_ONLY_MESSAGE } = require('../src/membership-access');
const flags = require('../src/experiment-integrations');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'user-agent': 'Mozilla/5.0 (compatible; pivitlab-check)' },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
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
    req.session = Object.assign({}, session);
    req.ip = '127.0.0.1';
    next();
  });
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/admin', require('../src/routes/ga4-admin'));
  app.use('/api/experiments', require('../src/routes/experiments'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function assertSources() {
  const schema = read('src/db/schema.sql');
  const migrateSrc = read('src/db/migrate.js');
  const migration = read('src/db/experiment-integrations.js');
  assert.ok(migrateSrc.includes("{ version: '024', name: 'experiment-integrations', run: applyExperimentIntegrations }"));
  assert.ok(migrateSrc.indexOf("version: '023'") < migrateSrc.indexOf("version: '024'"));
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS ga4_enabled BOOLEAN NOT NULL DEFAULT true'));
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS datalayer_events BOOLEAN NOT NULL DEFAULT true'));
  assert.ok(!/\bDROP\s/i.test(migration));
  assert.ok(!/\bDELETE\s/i.test(migration));
  assert.ok(!/\bUPDATE\s/i.test(migration));
  assert.ok(!schema.includes('datalayer_events'));
  assert.ok(!schema.includes('ga4_enabled'));
  const omitted = flags.parseCreateIntegrationFlags({});
  assert.deepStrictEqual(
    { ga4_enabled: omitted.ga4_enabled, datalayer_events: omitted.datalayer_events },
    { ga4_enabled: true, datalayer_events: true }
  );
  assert.strictEqual(flags.parseCreateIntegrationFlags({ ga4_enabled: 'yes' }).ok, false);
  assert.strictEqual(flags.parseExperimentIntegrations({}).ok, false);
  assert.deepStrictEqual(flags.parseExperimentIntegrations({ ga4_enabled: false }), {
    ok: true,
    ga4_enabled: false,
  });
}

async function column(db, name) {
  const { rows } = await db.query(
    `SELECT column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'experiments' AND column_name = $1`,
    [name]
  );
  return rows[0] || null;
}

async function main() {
  assertSources();
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('experiment integrations db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_exp_integrations_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const servers = [];
  try {
    const applied = await migrate();
    assert.ok(applied.includes('024'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);

    for (const name of ['ga4_enabled', 'datalayer_events']) {
      const info = await column(db, name);
      assert.strictEqual(info.is_nullable, 'NO', name);
      assert.ok(String(info.column_default).includes('true'), name);
    }

    const north = await db.query(`INSERT INTO accounts (name) VALUES ('North Ltd') RETURNING id`);
    const south = await db.query(`INSERT INTO accounts (name) VALUES ('South Ltd') RETURNING id`);
    const northId = north.rows[0].id;
    const southId = south.rows[0].id;
    const owner = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@north.example', now()) RETURNING id`
    );
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member@north.example', now()) RETURNING id`
    );
    const stranger = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@south.example', now()) RETURNING id`
    );
    const adminUser = await db.query(
      `INSERT INTO users (email, verified_at, is_superadmin) VALUES ('admin@pivitlab.test', now(), true) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
      [northId, owner.rows[0].id, member.rows[0].id, southId, stranger.rows[0].id]
    );

    const legacy = await db.query(
      `INSERT INTO experiments (name, url_match, account_id)
       VALUES ('Already saved', 'https://shop.example/', $1)
       RETURNING ga4_enabled, datalayer_events`,
      [northId]
    );
    assert.strictEqual(legacy.rows[0].ga4_enabled, true);
    assert.strictEqual(legacy.rows[0].datalayer_events, true);

    const ownerServer = await listen(appFor({
      role: 'owner', accountId: northId, userId: owner.rows[0].id, customer: true,
    }));
    const memberServer = await listen(appFor({
      role: 'owner', accountId: northId, userId: member.rows[0].id, customer: true,
    }));
    const southServer = await listen(appFor({
      role: 'owner', accountId: southId, userId: stranger.rows[0].id, customer: true,
    }));
    const adminServer = await listen(appFor({
      role: 'owner', accountId: northId, userId: adminUser.rows[0].id,
    }));
    const viewServer = await listen(appFor({
      role: 'owner',
      accountId: northId,
      userId: adminUser.rows[0].id,
      viewAsAccountId: northId,
    }));
    const publicServer = await listen(appFor({}));
    servers.push(ownerServer, memberServer, southServer, adminServer, viewServer, publicServer);

    const added = await request(ownerServer, 'POST', '/api/sites', { website: 'shop.example' });
    assert.strictEqual(added.status, 201, added.text);
    const siteId = added.json.site.id;
    const siteKey = added.json.site.public_key;

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Home hero',
      url_match: 'https://shop.example/pricing',
      url_match_type: 'contains',
      allowed_hosts: ['shop.example'],
      site_id: siteId,
    });
    assert.strictEqual(created.status, 201, created.text);
    assert.strictEqual(created.json.ga4_enabled, true);
    assert.strictEqual(created.json.datalayer_events, true);
    const heroId = created.json.id;

    const quiet = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Quiet',
      url_match: 'https://shop.example/pricing',
      url_match_type: 'contains',
      allowed_hosts: ['shop.example'],
      site_id: siteId,
      ga4_enabled: false,
      datalayer_events: false,
    });
    assert.strictEqual(quiet.status, 201, quiet.text);
    assert.strictEqual(quiet.json.ga4_enabled, false);
    assert.strictEqual(quiet.json.datalayer_events, false);
    const quietId = quiet.json.id;

    const badCreate = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Bad',
      url_match: 'https://shop.example/pricing',
      allowed_hosts: ['shop.example'],
      ga4_enabled: 'yes',
    });
    assert.strictEqual(badCreate.status, 400);

    const missing = await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {});
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.json.error, 'Nothing to save.');
    const wrongType = await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      datalayer_events: 'yes',
    });
    assert.strictEqual(wrongType.status, 400);
    assert.strictEqual(wrongType.json.error, 'Say whether this test counts dataLayer events.');

    const memberPatch = await request(memberServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
      datalayer_events: false,
    });
    assert.strictEqual(memberPatch.status, 403);
    assert.strictEqual(memberPatch.json.error, VIEW_ONLY_MESSAGE);
    const viewPatch = await request(viewServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
    });
    assert.strictEqual(viewPatch.status, 403);
    const other = await request(southServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
    });
    assert.strictEqual(other.status, 404);
    const signedOut = await request(publicServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
    });
    assert.strictEqual(signedOut.status, 401);

    const memberRead = await request(memberServer, 'GET', `/api/experiments/${heroId}`);
    assert.strictEqual(memberRead.status, 200, memberRead.text);
    assert.strictEqual(memberRead.json.ga4_enabled, true);
    assert.strictEqual(memberRead.json.datalayer_events, true);

    const turned = await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
    });
    assert.strictEqual(turned.status, 200, turned.text);
    assert.strictEqual(turned.json.ga4_enabled, false);
    assert.strictEqual(turned.json.datalayer_events, true);
    const same = await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
    });
    assert.strictEqual(same.status, 200, same.text);
    const audits = await db.query(
      `SELECT action, detail FROM audit_log WHERE action = 'experiment_integrations' ORDER BY created_at`
    );
    assert.strictEqual(audits.rows.length, 1);
    assert.strictEqual(audits.rows[0].detail.name, 'Home hero');
    assert.strictEqual(audits.rows[0].detail.ga4_enabled, false);
    assert.strictEqual(audits.rows[0].detail.datalayer_events, true);

    const restored = await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: true,
      datalayer_events: true,
    });
    assert.strictEqual(restored.status, 200, restored.text);
    assert.strictEqual(restored.json.ga4_enabled, true);

    await request(adminServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: true });
    const ga4On = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, {
      measurement_id: 'G-TEST1234',
      enabled: true,
    });
    assert.strictEqual(ga4On.status, 200, ga4On.text);
    const layerOn = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, {
      datalayer_events: true,
    });
    assert.strictEqual(layerOn.status, 200, layerOn.text);

    await db.query(
      `UPDATE experiments SET status = 'running' WHERE id = ANY($1::uuid[])`,
      [[heroId, quietId]]
    );
    await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split)
       VALUES ($1, 'Control', 50), ($2, 'Control', 50)`,
      [heroId, quietId]
    );

    const page = '/api/experiments?url=' + encodeURIComponent('https://shop.example/pricing')
      + '&site=' + encodeURIComponent(siteKey);
    const live = await request(publicServer, 'GET', page);
    assert.strictEqual(live.status, 200, live.text);
    assert.deepStrictEqual(live.json.ga4, { measurement_id: 'G-TEST1234' });
    assert.strictEqual(live.json.datalayer_events, true);
    const hero = live.json.experiments.find((row) => row.id === heroId);
    const quietRow = live.json.experiments.find((row) => row.id === quietId);
    assert.strictEqual(hero.ga4_enabled, true);
    assert.strictEqual(hero.datalayer_events, true);
    assert.strictEqual(quietRow.ga4_enabled, false);
    assert.strictEqual(quietRow.datalayer_events, false);

    const byIds = await request(
      publicServer,
      'GET',
      '/api/experiments/by-ids?ids=' + encodeURIComponent(quietId)
        + '&site=' + encodeURIComponent(siteKey)
        + '&url=' + encodeURIComponent('https://shop.example/pricing')
    );
    assert.strictEqual(byIds.status, 200, byIds.text);
    assert.strictEqual(byIds.json.experiments[0].datalayer_events, false);
    assert.strictEqual(byIds.json.experiments[0].ga4_enabled, false);

    await request(ownerServer, 'PATCH', `/api/experiments/${heroId}/integrations`, {
      ga4_enabled: false,
      datalayer_events: false,
    });
    const none = await request(publicServer, 'GET', page);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(none.json, 'ga4'), false);
    assert.strictEqual(none.json.datalayer_events, true);
    assert.ok(none.json.experiments.every((row) => row.ga4_enabled === false && row.datalayer_events === false));

    await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: false });
    const siteOff = await request(publicServer, 'GET', page);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(siteOff.json, 'datalayer_events'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(siteOff.json, 'ga4'), false);

    console.log('experiment integrations db tests passed');
  } finally {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
