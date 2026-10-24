// Migration 021 adds sites.datalayer_events, off by default. A custom goal
// is still a value in the goals JSON. The public snippet hears about the
// switch only when it is on, and receives the event name with the goal.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

const PAGE = 'https://site3-checkout.netlify.app/play';

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
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) json = JSON.parse(text);
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
    req.session = Object.assign({}, session);
    req.ip = '127.0.0.1';
    next();
  });
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
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
  assert.ok(!schema.includes('datalayer_events'));
  assert.ok(migrateSrc.includes("{ version: '021', name: 'datalayer-events', run: applyDatalayerEvents }"));
  assert.ok(migrateSrc.indexOf("version: '020'") < migrateSrc.indexOf("version: '021'"));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('custom event db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_custom_event_' + Date.now().toString(36);
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
    assert.ok(applied.includes('021'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);

    const column = await db.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sites' AND column_name = 'datalayer_events'`
    );
    assert.strictEqual(column.rows[0].is_nullable, 'NO');
    assert.ok(String(column.rows[0].column_default).includes('false'));

    const north = await db.query(`INSERT INTO accounts (name) VALUES ('North Ltd') RETURNING id`);
    const south = await db.query(`INSERT INTO accounts (name) VALUES ('South Ltd') RETURNING id`);
    const northId = north.rows[0].id;
    const southId = south.rows[0].id;
    const owner = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@north.example', now()) RETURNING id`
    );
    const stranger = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@south.example', now()) RETURNING id`
    );
    const adminUser = await db.query(
      `INSERT INTO users (email, verified_at, is_superadmin) VALUES ('admin@pivitlab.test', now(), true) RETURNING id`
    );
    const ownerId = owner.rows[0].id;
    const strangerId = stranger.rows[0].id;
    const adminId = adminUser.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [northId, ownerId, southId, strangerId]
    );

    const ownerServer = await listen(appFor({ role: 'owner', accountId: northId, userId: ownerId }));
    const southServer = await listen(appFor({ role: 'owner', accountId: southId, userId: strangerId }));
    const viewServer = await listen(appFor({
      role: 'owner',
      accountId: northId,
      userId: adminId,
      viewAsAccountId: northId,
    }));
    const publicServer = await listen(appFor({}));
    servers.push(ownerServer, southServer, viewServer, publicServer);

    const added = await request(ownerServer, 'POST', '/api/sites', { website: 'site3-checkout.netlify.app' });
    assert.strictEqual(added.status, 201, added.text);
    assert.strictEqual(added.json.site.datalayer_events, false);
    const siteId = added.json.site.id;
    const siteKey = added.json.site.public_key;

    const missing = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, {});
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.json.error, 'Say whether dataLayer events count.');
    const wrongType = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: 'yes' });
    assert.strictEqual(wrongType.status, 400);
    const other = await request(southServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: true });
    assert.strictEqual(other.status, 404);
    const signedOut = await request(publicServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: true });
    assert.strictEqual(signedOut.status, 401);
    const view = await request(viewServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: true });
    assert.strictEqual(view.status, 403);

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Checkout confirmation',
      url_match: PAGE,
      url_match_type: 'exact',
      allowed_hosts: ['site3-checkout.netlify.app'],
      site_id: siteId,
    });
    assert.strictEqual(created.status, 201, created.text);
    const id = created.json.id;
    await db.query(`UPDATE experiments SET site_id = $2 WHERE id = $1`, [id, siteId]);

    const saved = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [
        { type: 'click', selector: '#pay-now', name: 'Pay now' },
        {
          type: 'custom',
          event: ' checkout_step ',
          name: 'Paid',
          when: [{ key: ' step_name ', value: ' confirmation ' }],
        },
      ],
    });
    assert.strictEqual(saved.status, 200, saved.text);
    const custom = saved.json.goals.find((goal) => goal.type === 'custom');
    assert.ok(custom);
    assert.strictEqual(custom.event, 'checkout_step');
    assert.strictEqual(custom.name, 'Paid');
    assert.strictEqual(custom.selector, undefined);
    assert.deepStrictEqual(custom.when, [{ key: 'step_name', value: 'confirmation' }]);
    assert.strictEqual(saved.json.goals.find((goal) => goal.type === 'click').selector, '#pay-now');

    const reserved = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'custom', event: 'experience_impression', name: 'Nope' }],
    });
    assert.strictEqual(reserved.status, 400);
    assert.ok(reserved.json.error.includes('experience_impression'));
    const messy = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'custom', event: 'checkout step', name: 'Nope' }],
    });
    assert.strictEqual(messy.status, 400);
    assert.strictEqual(messy.json.error, 'an event name can use letters, digits, and _ - .');
    const tooMany = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{
        type: 'custom',
        event: 'checkout_step',
        name: 'Paid',
        when: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
          { key: 'c', value: '3' },
          { key: 'd', value: '4' },
        ],
      }],
    });
    assert.strictEqual(tooMany.status, 400);
    assert.strictEqual(tooMany.json.error, 'a custom goal can have at most 3 conditions');
    const longValue = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'custom', event: 'checkout_step', name: 'Paid', when: [{ key: 'note', value: 'a'.repeat(101) }] }],
    });
    assert.strictEqual(longValue.status, 400);
    assert.strictEqual(longValue.json.error, 'a condition value is too long');
    const badKey = await request(ownerServer, 'PUT', `/api/experiments/${id}/goals`, {
      goals: [{ type: 'custom', event: 'checkout_step', name: 'Paid', when: [{ key: 'step name', value: 'confirmation' }] }],
    });
    assert.strictEqual(badKey.status, 400);
    assert.strictEqual(badKey.json.error, 'a condition key can use letters, digits, and _ - .');

    const kept = await db.query(`SELECT goals FROM experiments WHERE id = $1`, [id]);
    const stored = kept.rows[0].goals.find((goal) => goal.type === 'custom');
    assert.strictEqual(stored.event, 'checkout_step');
    assert.deepStrictEqual(stored.when, [{ key: 'step_name', value: 'confirmation' }]);

    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [id]);
    await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals)
       VALUES ($1, 'Control', 100, $2::jsonb)`,
      [id, JSON.stringify(kept.rows[0].goals)]
    );

    const publicPath = '/api/experiments?url=' + encodeURIComponent(PAGE) + '&site=' + encodeURIComponent(siteKey);
    const off = await request(publicServer, 'GET', publicPath);
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(off.json, 'datalayer_events'), false);
    const servedOff = off.json.experiments.find((row) => row.id === id);
    assert.ok(servedOff);
    assert.strictEqual(servedOff.goals.find((goal) => goal.type === 'custom').event, 'checkout_step');
    assert.deepStrictEqual(servedOff.goals.find((goal) => goal.type === 'custom').when, [{ key: 'step_name', value: 'confirmation' }]);

    const switched = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: true });
    assert.strictEqual(switched.status, 200, switched.text);
    assert.strictEqual(switched.json.site.datalayer_events, true);
    const on = await request(publicServer, 'GET', publicPath);
    assert.strictEqual(on.json.datalayer_events, true);
    assert.strictEqual(on.json.experiments.find((row) => row.id === id).goals.find((goal) => goal.name === 'Paid').event, 'checkout_step');

    const same = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: true });
    assert.strictEqual(same.status, 200, same.text);
    const audits = await db.query(
      `SELECT action, detail FROM audit_log WHERE action = 'datalayer_events' ORDER BY created_at`
    );
    assert.strictEqual(audits.rows.length, 1);
    assert.strictEqual(audits.rows[0].detail.datalayer_events, true);

    const switchedOff = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/datalayer`, { datalayer_events: false });
    assert.strictEqual(switchedOff.status, 200, switchedOff.text);
    assert.strictEqual(switchedOff.json.site.datalayer_events, false);
    const afterOff = await request(publicServer, 'GET', publicPath);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(afterOff.json, 'datalayer_events'), false);
    const offAudits = await db.query(
      `SELECT detail FROM audit_log WHERE action = 'datalayer_events' ORDER BY created_at`
    );
    assert.strictEqual(offAudits.rows.length, 2);
    assert.strictEqual(offAudits.rows[1].detail.datalayer_events, false);

    console.log('custom event db tests passed');
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
