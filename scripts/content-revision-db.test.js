// Migration 025. Saving variant changes bumps the revision. A null event
// revision still counts as revision 1. A failed member save does not bump.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { clearSessionSecretCache } = require('../src/session-secret');
const { VIEW_ONLY_MESSAGE } = require('../src/membership-access');

process.env.SESSION_SECRET = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim().length >= 32
  ? process.env.SESSION_SECRET
  : 'content-revision-test-secret-32ch';
clearSessionSecretCache();

function request(server, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {},
        headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && String(res.headers['content-type'] || '').includes('json')) json = JSON.parse(text);
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.ok(!schema.includes('content_revision'));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('content revision db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_rev_' + Date.now().toString(36);
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

  const session = { role: 'owner' };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session;
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/editor', require('../src/routes/editor'));
  app.use('/api/event', require('../src/routes/events'));
  app.use('/api/results', require('../src/routes/results'));

  let server;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('025'));

    const variantColumn = await db.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'variants' AND column_name = 'content_revision'`
    );
    assert.strictEqual(variantColumn.rows[0].is_nullable, 'NO');
    assert.ok(String(variantColumn.rows[0].column_default).includes('1'));
    const eventColumn = await db.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_name = 'events' AND column_name = 'content_revision'`
    );
    assert.strictEqual(eventColumn.rows[0].is_nullable, 'YES');

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
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member-rev@pivitlab.test', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [accountId, member.rows[0].id]
    );

    const inserted = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id, site_id)
       VALUES ('Homepage', 'https://demo.pivitlab.com/', 'draft', ARRAY['demo.pivitlab.com'], '[]'::jsonb, 'shared', true, $1, $2)
       RETURNING id, content_revision`,
      [accountId, siteId]
    );
    const experimentId = inserted.rows[0].id;
    assert.strictEqual(inserted.rows[0].content_revision, 1);
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Offer', 50, '[]'::jsonb)
       RETURNING id, content_revision`,
      [experimentId]
    );
    const variantId = variant.rows[0].id;
    assert.strictEqual(variant.rows[0].content_revision, 1);

    server = await listen(app);
    session.role = 'owner';
    session.userId = member.rows[0].id;
    session.accountId = accountId;
    session.customer = true;
    const denied = await request(server, 'PATCH', `/api/experiments/${experimentId}/variants/${variantId}`, {
      name: 'Offer',
      traffic_split: 50,
      changes: [{ selector: 'h1', type: 'text', value: 'Member edit' }],
    });
    assert.strictEqual(denied.status, 403, denied.text);
    assert.strictEqual(denied.json.error, VIEW_ONLY_MESSAGE);
    const stillOne = await db.query(`SELECT content_revision FROM variants WHERE id = $1`, [variantId]);
    assert.strictEqual(stillOne.rows[0].content_revision, 1);

    delete session.userId;
    delete session.accountId;
    delete session.customer;
    session.role = 'owner';

    const token = createEditToken(variantId, undefined, { accountId, siteId });
    const first = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { changes: [{ selector: 'h1', type: 'text', value: 'Pay now' }] }
    );
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.json.content_revision, 2);
    assert.strictEqual(first.json.changes[0].value, 'Pay now');

    const same = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { changes: [{ value: 'Pay now', type: 'text', selector: 'h1' }] }
    );
    assert.strictEqual(same.status, 200, same.text);
    assert.strictEqual(same.json.content_revision, 2);

    const noted = await request(
      server,
      'PATCH',
      `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`,
      { steps_note: 'Click Continue twice', changes: [{ selector: 'h1', type: 'text', value: 'Pay now' }] }
    );
    assert.strictEqual(noted.status, 200, noted.text);
    assert.strictEqual(noted.json.content_revision, 2);
    assert.strictEqual(noted.json.steps_note, 'Click Continue twice');

    const renamed = await request(server, 'PATCH', `/api/experiments/${experimentId}/variants/${variantId}`, {
      name: 'Offer renamed',
      traffic_split: 40,
    });
    assert.strictEqual(renamed.status, 200, renamed.text);
    assert.strictEqual(renamed.json.content_revision, 2);

    const draftHistory = await db.query(
      `SELECT revision, while_running FROM content_revisions WHERE experiment_id = $1 ORDER BY revision`,
      [experimentId]
    );
    assert.strictEqual(draftHistory.rows.length, 1);
    assert.strictEqual(draftHistory.rows[0].revision, 2);
    assert.strictEqual(draftHistory.rows[0].while_running, false);

    await db.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [experimentId]);
    const live = await request(server, 'PATCH', `/api/experiments/${experimentId}/variants/${variantId}`, {
      name: 'Offer renamed',
      traffic_split: 40,
      changes: [{ selector: 'h1', type: 'text', value: 'Pay today' }],
    });
    assert.strictEqual(live.status, 200, live.text);
    assert.strictEqual(live.json.content_revision, 3);
    const experimentRow = await db.query(`SELECT content_revision FROM experiments WHERE id = $1`, [experimentId]);
    assert.strictEqual(experimentRow.rows[0].content_revision, 3);
    const runningHistory = await db.query(
      `SELECT revision, while_running FROM content_revisions WHERE experiment_id = $1 AND revision = 3`,
      [experimentId]
    );
    assert.strictEqual(runningHistory.rows[0].while_running, true);

    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, content_revision)
       VALUES ($1, $2, 'legacy-shopper', 'view', NULL)`,
      [experimentId, variantId]
    );

    const ua = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      origin: 'https://demo.pivitlab.com',
    };
    async function post(body) {
      const res = await request(server, 'POST', '/api/event', body, ua);
      assert.strictEqual(res.status, 204, res.text);
    }
    await post({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: 'saw-two',
      event_type: 'view',
      content_revision: 2,
    });
    await post({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: 'saw-current',
      event_type: 'view',
    });
    await post({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: 'saw-two',
      event_type: 'convert',
      content_revision: 2,
    });
    await post({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: 'future',
      event_type: 'view',
      content_revision: 99,
    });

    const stored = await db.query(
      `SELECT visitor_id, event_type, content_revision
       FROM events WHERE experiment_id = $1 ORDER BY id`,
      [experimentId]
    );
    const byVisitor = {};
    stored.rows.forEach((row) => {
      byVisitor[`${row.visitor_id}:${row.event_type}`] = row.content_revision;
    });
    assert.strictEqual(byVisitor['legacy-shopper:view'], null);
    assert.strictEqual(byVisitor['saw-two:view'], 2);
    assert.strictEqual(byVisitor['saw-two:convert'], 2);
    assert.strictEqual(byVisitor['saw-current:view'], 3);
    assert.strictEqual(byVisitor['future:view'], 3);

    const results = await request(server, 'GET', `/api/results/${experimentId}`);
    assert.strictEqual(results.status, 200, results.text);
    const revisions = results.json.revisions;
    assert.strictEqual(revisions.spans, true);
    assert.ok(revisions.notice.includes('more than one version'));
    const counts = {};
    revisions.revisions.forEach((row) => { counts[row.revision] = row.visitors; });
    assert.strictEqual(counts[1], 1);
    assert.strictEqual(counts[2], 1);
    assert.strictEqual(counts[3], 2);
    const changed = revisions.changed_while_running.find((row) => row.revision === 3);
    assert.ok(changed.label.startsWith('Changed while running on '));
    const line = revisions.revisions.find((row) => row.revision === 3);
    assert.ok(line.line.includes('Changed while running on '));
    assert.ok(line.line.includes('2 visitors'));

    const detail = await request(server, 'GET', `/api/experiments/${experimentId}`);
    assert.strictEqual(detail.json.content_revision, 3);
    assert.strictEqual(detail.json.variants[0].content_revision, 3);

    const loaded = await request(server, 'GET', `/api/editor/variants/${variantId}?token=${encodeURIComponent(token)}`);
    assert.strictEqual(loaded.status, 200, loaded.text);
    assert.strictEqual(loaded.json.content_revision, 3);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('content revision db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
