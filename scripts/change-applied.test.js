// Change-applied health: the view beacon says whether the selector was on
// the page, and the health card turns that into a percentage. Test traffic
// stays out unless the owner includes it. The column is migration 011, not
// schema.sql.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const health = require('../src/health');
const runtime = require('../snippet/ab.js');
const ui = require('../public/admin-ui');
const pg = require('./test-postgres');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../src/db/change-applied.js'), 'utf8');
const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

assert.ok(!schema.includes('change_applied'), 'change_applied must not be added in schema.sql');
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS change_applied BOOLEAN'));
assert.ok(!/NOT NULL/.test(migration));
assert.ok(!/DEFAULT/i.test(migration));
assert.ok(migrateSrc.includes("{ version: '011', name: 'change-applied', run: applyChangeApplied }"));
assert.ok(adminHtml.includes('id="change-applied-panel"'));
assert.ok(adminHtml.includes('renderChangeApplied'));

assert.strictEqual(health.tracksElementChange([]), false);
assert.strictEqual(health.tracksElementChange([{ type: 'stylesheet', selector: '', value: '.x{color:red}' }]), false);
assert.strictEqual(health.tracksElementChange([{ type: 'page_css', value: 'body{margin:0}' }]), false);
assert.strictEqual(health.tracksElementChange([{ type: 'page_js', selector: 'h1', value: 'void 0' }]), false);
assert.strictEqual(health.tracksElementChange([{ type: 'text', selector: 'h1', value: 'Hi' }]), true);

const low = health.changeAppliedLine({
  variant_name: 'Headline',
  reported_views: 10,
  applied_views: 4,
  views: 10,
});
assert.strictEqual(low.rate, 40);
assert.strictEqual(low.state, 'amber');
assert.ok(low.text.includes('Change applied on 40% of views'));
assert.ok(low.text.includes('The selector was missing on many of these views.'));

const boundary = health.changeAppliedLine({
  variant_name: 'Headline',
  reported_views: 10,
  applied_views: 9,
});
assert.strictEqual(boundary.rate, 90);
assert.strictEqual(boundary.state, 'green');
assert.ok(boundary.text.includes('Change applied on 90% of views'));
assert.ok(!boundary.text.includes('missing'));

const quietLine = health.changeAppliedLine({ variant_name: 'Headline', views: 0, reported_views: 0, applied_views: 0 });
assert.strictEqual(quietLine.rate, null);
assert.ok(quietLine.text.includes('not enough views yet'));
assert.ok(!quietLine.text.includes('Change applied on'));

const oldSnippet = health.changeAppliedLine({ variant_name: 'Headline', views: 8, reported_views: 0, applied_views: 0 });
assert.strictEqual(oldSnippet.rate, null);
assert.ok(oldSnippet.text.includes('have not reported'));

const report = health.buildHealth({
  status: 'running',
  srm: { applicable: true, srm_detected: false },
  totalVisitors: 80,
  scope: 'shared',
  goalCount: 1,
  drops: [],
  today: '2026-10-15',
  syntheticVisitors: 0,
  changeApplied: [
    { variant_id: 'c', variant_name: 'Control', changes: [], views: 40, reported_views: 0, applied_views: 0 },
    {
      variant_id: 'b',
      variant_name: 'Headline',
      changes: [{ type: 'text', selector: 'h1', value: 'Hi' }],
      views: 40,
      reported_views: 40,
      applied_views: 28,
    },
  ],
});
assert.strictEqual(report.show, true);
assert.strictEqual(report.checks[4].state, 'amber');
assert.strictEqual(report.checks[4].title, 'Changes');
assert.ok(report.checks[4].detail.includes('Headline: Change applied on 70% of views'));
assert.strictEqual(report.change_applied.length, 1);
assert.strictEqual(report.change_applied[0].variant_name, 'Headline');

const paused = health.buildHealth({
  status: 'paused',
  changeApplied: [{
    variant_name: 'Headline',
    changes: [{ type: 'text', selector: 'h1', value: 'Hi' }],
    views: 10,
    reported_views: 10,
    applied_views: 10,
  }],
});
assert.strictEqual(paused.show, false);
assert.strictEqual(paused.change_applied[0].rate, 100);
assert.strictEqual(paused.change_applied[0].state, 'green');

const card = ui.renderHealth(report);
assert.ok(card.includes('health-card amber'));
assert.ok(card.includes('Change applied on 70% of views'));
assert.ok(card.includes('The selector was missing on many of these views.'));
const resultsHtml = ui.renderChangeApplied(paused.change_applied);
assert.ok(resultsHtml.includes('Change applied on 100% of views'));
assert.ok(!resultsHtml.includes('warn-text'));
const warned = ui.renderChangeApplied(report.change_applied);
assert.ok(warned.includes('warn-text'));
assert.ok(warned.includes('Change applied on 70% of views'));
assert.strictEqual(ui.renderChangeApplied([{ rate: null, state: 'amber', text: 'waiting' }]), '');
const escaped = ui.renderChangeApplied([{
  rate: 10,
  state: 'amber',
  text: '<script>: Change applied on 10% of views',
}]);
assert.ok(escaped.includes('&lt;script&gt;'));
assert.ok(!escaped.includes('<script>'));

const plainView = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'view',
}, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plainView, 'change_applied'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plainView, 'is_test'), false);

const appliedView = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'view',
  change_applied: false,
}, false);
assert.strictEqual(appliedView.change_applied, false);

const qaView = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'view',
  change_applied: true,
}, true);
assert.strictEqual(qaView.change_applied, true);
assert.strictEqual(qaView.is_test, true);

const click = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'click',
  change_applied: false,
}, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(click, 'change_applied'), false);

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
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) json = JSON.parse(text);
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('change-applied tests passed (database skipped: postgres not reachable)');
    return;
  }
  const dbName = 'pivit_applied_' + Date.now().toString(36);
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
    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, status, goals, goals_scope, goals_migrated, account_id)
       VALUES ('Homepage', 'https://cantsaythat.co.uk/', 'running', '[]'::jsonb, 'shared', true, $1)
       RETURNING id`,
      [accountId]
    );
    const experimentId = exp.rows[0].id;
    const control = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Control', 50, '[]'::jsonb) RETURNING id`,
      [experimentId]
    );
    const headline = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Headline', 50, $2::jsonb) RETURNING id`,
      [experimentId, JSON.stringify([{ type: 'text', selector: 'h1', value: 'Hi' }])]
    );
    const controlId = control.rows[0].id;
    const headlineId = headline.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.session = { role: 'owner' };
      next();
    });
    app.use('/api/experiments', require('../src/routes/experiments'));
    app.use('/api/event', require('../src/routes/events'));
    server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });

    const ua = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    async function post(body) {
      const res = await request(server, 'POST', '/api/event', body, ua);
      assert.strictEqual(res.status, 204);
    }
    const view = { experiment_id: experimentId, variant_id: headlineId, event_type: 'view' };
    for (let i = 0; i < 9; i += 1) {
      await post(Object.assign({ visitor_id: `real_yes_${i}`, change_applied: true }, view));
    }
    await post(Object.assign({ visitor_id: 'real_no', change_applied: false }, view));
    for (let i = 0; i < 5; i += 1) {
      await post(Object.assign({ visitor_id: `qa_${i}`, change_applied: false, is_test: true }, view));
    }
    await post(Object.assign({ visitor_id: 'old_1' }, view));
    await post(Object.assign({ visitor_id: 'old_2' }, view));
    await post(Object.assign({ visitor_id: 'junk', change_applied: 'yes' }, view));
    await post({
      experiment_id: experimentId,
      variant_id: headlineId,
      visitor_id: 'clicker',
      event_type: 'click',
      change_applied: true,
    });
    await post({
      experiment_id: experimentId,
      variant_id: controlId,
      visitor_id: 'control_1',
      event_type: 'view',
      change_applied: true,
    });

    const stored = await db.query(
      `SELECT visitor_id, event_type, change_applied
       FROM events
       WHERE visitor_id IN ('clicker', 'junk', 'old_1', 'qa_0', 'real_no')
       ORDER BY visitor_id`
    );
    const byVisitor = Object.fromEntries(stored.rows.map((row) => [row.visitor_id, row.change_applied]));
    assert.strictEqual(byVisitor.clicker, null);
    assert.strictEqual(byVisitor.junk, null);
    assert.strictEqual(byVisitor.old_1, null);
    assert.strictEqual(byVisitor.qa_0, false);
    assert.strictEqual(byVisitor.real_no, false);

    const live = await request(server, 'GET', `/api/experiments/${experimentId}/health`);
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.json.show, true);
    assert.strictEqual(live.json.change_applied.length, 1);
    assert.strictEqual(live.json.change_applied[0].variant_name, 'Headline');
    assert.strictEqual(live.json.change_applied[0].rate, 90);
    assert.strictEqual(live.json.change_applied[0].reported_views, 10);
    assert.strictEqual(live.json.change_applied[0].applied_views, 9);
    assert.strictEqual(live.json.change_applied[0].state, 'green');
    assert.ok(live.json.change_applied[0].text.includes('Change applied on 90% of views'));
    const cardDetail = live.json.checks.find((check) => check.title === 'Changes');
    assert.ok(cardDetail.detail.includes('Change applied on 90% of views'));
    assert.strictEqual(cardDetail.state, 'green');

    const withTest = await request(server, 'GET', `/api/experiments/${experimentId}/health?include_test=1`);
    assert.strictEqual(withTest.json.change_applied[0].rate, 60);
    assert.strictEqual(withTest.json.change_applied[0].reported_views, 15);
    assert.strictEqual(withTest.json.change_applied[0].applied_views, 9);
    assert.strictEqual(withTest.json.change_applied[0].state, 'amber');
    assert.ok(withTest.json.change_applied[0].text.includes('Change applied on 60% of views'));
    assert.ok(withTest.json.change_applied[0].text.includes('The selector was missing on many of these views.'));

    await db.query(`UPDATE experiments SET status = 'paused' WHERE id = $1`, [experimentId]);
    const pausedHttp = await request(server, 'GET', `/api/experiments/${experimentId}/health`);
    assert.strictEqual(pausedHttp.json.show, false);
    assert.strictEqual(pausedHttp.json.change_applied[0].rate, 90);

    console.log('change-applied tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
