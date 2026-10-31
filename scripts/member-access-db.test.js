// A Member can read and preview. Changes return 403. An Owner still succeeds.
// Another agency's id stays 404, covered by the isolation tests.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { VIEW_ONLY_MESSAGE } = require('../src/membership-access');

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
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
    req.session = session;
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/experiments', require('../src/routes/conclusion').ownerRouter);
  app.use('/api/results', require('../src/routes/results'));
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/account/members', require('../src/routes/members'));
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/clients', require('../src/routes/clients'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('member access db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_member_access_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'member-access-session-secret-32chars';
  process.env.APP_ORIGIN = 'https://pivitlab.test';
  delete process.env.POSTMARK_SERVER_TOKEN;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let ownerServer;
  let memberServer;
  let viewerServer;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('023'));
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'account_invites' AND column_name IN ('code_hash', 'code_attempts', 'code_expires_at')`
    );
    assert.strictEqual(columns.rows.length, 3);

    const account = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Northwind', false) RETURNING id`
    );
    const accountId = account.rows[0].id;
    const owner = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@northwind.test', now()) RETURNING id`
    );
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member@northwind.test', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [accountId, owner.rows[0].id, member.rows[0].id]
    );
    const site = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
       VALUES ($1, 'northwind.test', ARRAY['northwind.test'], 'site_memberaccess0001', now())
       RETURNING id`,
      [accountId]
    );

    const ownerSession = {
      role: 'owner',
      userId: owner.rows[0].id,
      accountId,
      customer: true,
    };
    const memberSession = {
      role: 'owner',
      userId: member.rows[0].id,
      accountId,
      customer: true,
    };
    ownerServer = await listen(appFor(ownerSession));
    memberServer = await listen(appFor(memberSession));
    const viewer = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Viewer', 'north-viewer', 'x', $1) RETURNING id`,
      [accountId]
    );
    viewerServer = await listen(appFor({
      role: 'client',
      clientId: viewer.rows[0].id,
      accountId,
    }));

    const created = await request(ownerServer, 'POST', '/api/experiments', {
      name: 'Homepage',
      url_match: 'https://northwind.test/',
      url_match_type: 'exact',
      allowed_hosts: ['northwind.test'],
      site_id: site.rows[0].id,
    });
    assert.strictEqual(created.status, 201, created.text);
    const experimentId = created.json.id;
    const variantId = created.json.control_variant.id;

    const memberCreate = await request(memberServer, 'POST', '/api/experiments', {
      name: 'Should not exist',
      url_match: 'https://northwind.test/nope',
      allowed_hosts: ['northwind.test'],
    });
    assert.strictEqual(memberCreate.status, 403, memberCreate.text);
    assert.strictEqual(memberCreate.json.error, VIEW_ONLY_MESSAGE);
    const sneaky = await db.query(`SELECT id FROM experiments WHERE name = 'Should not exist'`);
    assert.strictEqual(sneaky.rows.length, 0);

    const memberRead = await request(memberServer, 'GET', `/api/experiments/${experimentId}`);
    assert.strictEqual(memberRead.status, 200, memberRead.text);
    assert.strictEqual(memberRead.json.name, 'Homepage');
    const memberResults = await request(memberServer, 'GET', `/api/results/${experimentId}`);
    assert.strictEqual(memberResults.status, 200, memberResults.text);
    const memberAudit = await request(memberServer, 'GET', '/api/audit');
    assert.strictEqual(memberAudit.status, 200, memberAudit.text);
    const memberTeam = await request(memberServer, 'GET', '/api/account/members');
    assert.strictEqual(memberTeam.status, 200, memberTeam.text);

    const page = 'https://northwind.test/';
    const memberPreview = await request(memberServer, 'POST', `/api/experiments/${experimentId}/variants/${variantId}/preview-link`, {
      page_url: page,
    });
    assert.strictEqual(memberPreview.status, 200, memberPreview.text);
    assert.ok(memberPreview.json.preview_url);

    const memberEdit = await request(memberServer, 'POST', `/api/experiments/${experimentId}/variants/${variantId}/edit-link`, {
      page_url: page,
    });
    assert.strictEqual(memberEdit.status, 403, memberEdit.text);
    assert.strictEqual(memberEdit.json.error, VIEW_ONLY_MESSAGE);
    const ownerEdit = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/variants/${variantId}/edit-link`, {
      page_url: page,
    });
    assert.strictEqual(ownerEdit.status, 200, ownerEdit.text);
    assert.ok(ownerEdit.json.edit_url);

    const memberStart = await request(memberServer, 'PATCH', `/api/experiments/${experimentId}/status`, { status: 'running' });
    assert.strictEqual(memberStart.status, 403, memberStart.text);
    assert.strictEqual(memberStart.json.error, VIEW_ONLY_MESSAGE);
    const stillDraft = await db.query(`SELECT status FROM experiments WHERE id = $1`, [experimentId]);
    assert.strictEqual(stillDraft.rows[0].status, 'draft');
    const ownerStart = await request(ownerServer, 'PATCH', `/api/experiments/${experimentId}/status`, { status: 'running' });
    assert.strictEqual(ownerStart.status, 200, ownerStart.text);
    assert.strictEqual(ownerStart.json.status, 'running');

    const memberPause = await request(memberServer, 'PATCH', `/api/experiments/${experimentId}/status`, { status: 'paused' });
    assert.strictEqual(memberPause.status, 403);
    const ownerPause = await request(ownerServer, 'PATCH', `/api/experiments/${experimentId}/status`, { status: 'paused' });
    assert.strictEqual(ownerPause.status, 200, ownerPause.text);

    const memberVariant = await request(memberServer, 'POST', `/api/experiments/${experimentId}/variants`, {
      name: 'Offer',
      traffic_split: 50,
    });
    assert.strictEqual(memberVariant.status, 403);
    const ownerVariant = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/variants`, {
      name: 'Offer',
      traffic_split: 50,
    });
    assert.strictEqual(ownerVariant.status, 201, ownerVariant.text);

    const memberGoals = await request(memberServer, 'PUT', `/api/experiments/${experimentId}/goals`, {
      goals: [{ type: 'click', selector: '#buy', name: 'Buy' }],
    });
    assert.strictEqual(memberGoals.status, 403);
    const ownerGoals = await request(ownerServer, 'PUT', `/api/experiments/${experimentId}/goals`, {
      goals: [{ type: 'click', selector: '#buy', name: 'Buy' }],
    });
    assert.strictEqual(ownerGoals.status, 200, ownerGoals.text);

    const memberSite = await request(memberServer, 'POST', '/api/sites', { website: 'other.northwind.test' });
    assert.strictEqual(memberSite.status, 403);
    const ownerSite = await request(ownerServer, 'POST', '/api/sites', { website: 'other.northwind.test' });
    assert.strictEqual(ownerSite.status, 201, ownerSite.text);
    const memberGa4 = await request(memberServer, 'PATCH', `/api/sites/${site.rows[0].id}/ga4`, {
      ga4_measurement_id: 'G-TEST1234',
      ga4_enabled: false,
    });
    assert.strictEqual(memberGa4.status, 403, memberGa4.text);
    const memberLayer = await request(memberServer, 'PATCH', `/api/sites/${site.rows[0].id}/datalayer`, {
      datalayer_events: true,
    });
    assert.strictEqual(memberLayer.status, 403, memberLayer.text);
    const memberSiteEdit = await request(memberServer, 'PATCH', `/api/sites/${site.rows[0].id}`, {
      website: 'renamed.northwind.test',
    });
    assert.strictEqual(memberSiteEdit.status, 403);

    const memberInvite = await request(memberServer, 'POST', '/api/account/members/invites', {
      email: 'new@northwind.test',
      role: 'member',
      send: false,
    });
    assert.strictEqual(memberInvite.status, 403, memberInvite.text);
    const ownerInvite = await request(ownerServer, 'POST', '/api/account/members/invites', {
      email: 'new@northwind.test',
      role: 'member',
      send: false,
    });
    assert.strictEqual(ownerInvite.status, 201, ownerInvite.text);

    const memberClear = await request(memberServer, 'POST', `/api/experiments/${experimentId}/test-traffic/clear`, { confirm: true });
    assert.strictEqual(memberClear.status, 403);
    const memberRestore = await request(memberServer, 'POST', `/api/experiments/${experimentId}/test-traffic/restore`, {
      mode: 'test',
      confirm: true,
    });
    assert.strictEqual(memberRestore.status, 403);

    const memberArchive = await request(memberServer, 'PATCH', `/api/experiments/${experimentId}/status`, {
      status: 'archived',
      archive: true,
    });
    assert.strictEqual(memberArchive.status, 403);
    const ownerArchive = await request(ownerServer, 'PATCH', `/api/experiments/${experimentId}/status`, {
      status: 'archived',
      archive: true,
    });
    assert.strictEqual(ownerArchive.status, 200, ownerArchive.text);
    const memberDelete = await request(memberServer, 'DELETE', `/api/experiments/${experimentId}`);
    assert.strictEqual(memberDelete.status, 403);
    const stillThere = await db.query(`SELECT id FROM experiments WHERE id = $1`, [experimentId]);
    assert.strictEqual(stillThere.rows.length, 1);

    const viewerStart = await request(viewerServer, 'PATCH', `/api/experiments/${experimentId}/status`, { status: 'running' });
    assert.strictEqual(viewerStart.status, 401);

    const foreign = '00000000-0000-4000-8000-000000000099';
    const hidden = await request(memberServer, 'PATCH', `/api/experiments/${foreign}/status`, { status: 'paused' });
    assert.strictEqual(hidden.status, 404, hidden.text);

    console.log('member access db tests passed');
  } finally {
    if (ownerServer) await new Promise((resolve) => ownerServer.close(resolve));
    if (memberServer) await new Promise((resolve) => memberServer.close(resolve));
    if (viewerServer) await new Promise((resolve) => viewerServer.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
