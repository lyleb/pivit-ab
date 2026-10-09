// Cross-account isolation. Account A is the migrated legacy account. Account B
// is another customer. Asking for B's ids while signed in as A returns 404.
// The public snippet reaches A only with no site key, and B only with B's key.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'user-agent': 'Mozilla/5.0 (compatible; pivitlab-check)' },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        headers || {}
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
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/invites', require('../src/routes/invites'));
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/admin', require('../src/routes/audit').adminRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/event', require('../src/routes/events'));
  app.use('/api/results', require('../src/routes/results'));
  app.use('/api/goals', require('../src/routes/goals').router);
  app.use('/api/clients', require('../src/routes/clients'));
  app.use('/api/client', require('../src/routes/client'));
  app.use('/api/editor', require('../src/routes/editor'));
  app.use('/api/host-hits', require('../src/routes/host-hits'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function expectMissing(server, method, urlPath, body, headers) {
  const res = await request(server, method, urlPath, body, headers);
  assert.strictEqual(res.status, 404, `${method} ${urlPath} -> ${res.status} ${res.text}`);
  assert.strictEqual(res.status === 403, false);
  assert.ok(!/forbidden/i.test(res.text));
  return res;
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('isolation db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_iso_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  process.env.ADMIN_API_KEY = 'isolation-admin-key-value';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { newSiteKey } = require('../src/db/tenancy');
  const { createEditToken } = require('../src/edit-token');
  const { createPreviewToken } = require('../src/preview-access');
  const { clearLegacyCache } = require('../src/tenant');

  const servers = [];
  try {
    await migrate();
    clearLegacyCache();

    const legacy = await db.query(
      `SELECT a.id, s.id AS site_id, s.public_key
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE`
    );
    const aId = legacy.rows[0].id;
    const aSiteId = legacy.rows[0].site_id;
    const aKey = legacy.rows[0].public_key;

    const other = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Other Ltd', false) RETURNING id`
    );
    const bId = other.rows[0].id;
    const bKey = newSiteKey();
    const bSite = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
       VALUES ($1, 'other.example', $2::text[], $3, now()) RETURNING id`,
      [bId, ['shop-a.example'], bKey]
    );
    const bSiteId = bSite.rows[0].id;

    async function makeExperiment(accountId, siteId, name) {
      const exp = await db.query(
        `INSERT INTO experiments
           (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
         VALUES ($1, '/pricing', 'running', $2::text[], $3, $4, '[]'::jsonb, 'shared', true)
         RETURNING id`,
        [name, ['shop-a.example'], accountId, siteId]
      );
      const variant = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
        [exp.rows[0].id]
      );
      return { id: exp.rows[0].id, variantId: variant.rows[0].id };
    }

    const aExp = await makeExperiment(aId, aSiteId, 'Account A');
    const bExp = await makeExperiment(bId, bSiteId, 'Account B');
    const bHistory = await makeExperiment(bId, bSiteId, 'Account B history');
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       VALUES ($1, $2, 'b-secret-visitor', 'view')`,
      [bExp.id, bExp.variantId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       SELECT $1, $2, 'b-hist-' || g::text, 'view' FROM generate_series(1, 150) g`,
      [bHistory.id, bHistory.variantId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       SELECT $1, $2, 'b-hist-' || g::text, 'convert' FROM generate_series(1, 80) g`,
      [bHistory.id, bHistory.variantId]
    );

    const aClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Client A', 'client-a', 'hash-a', $1) RETURNING id`,
      [aId]
    );
    const bClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Client B', 'client-b', 'hash-b', $1) RETURNING id`,
      [bId]
    );
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [aClient.rows[0].id, aExp.id]);
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [bClient.rows[0].id, bExp.id]);
    await db.query(
      `INSERT INTO goal_templates (account_id, type, value, label)
       VALUES ($1, 'click', '.only-b', 'only-b-goal')`,
      [bId]
    );
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count, account_id)
       VALUES (CURRENT_DATE, 'pivitlab.com', 'https://shop-a.example', 400, $1)`,
      [bId]
    );
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count)
       VALUES (CURRENT_DATE, 'pivit.click', 'https://cantsaythat.co.uk', 3)`
    );

    const ownerA = appFor({ role: 'owner' });
    const ownerB = appFor({ role: 'owner', accountId: bId });
    const clientA = appFor({ role: 'client', clientId: aClient.rows[0].id });
    const serverA = await listen(ownerA);
    const serverB = await listen(ownerB);
    const serverClient = await listen(clientA);
    const publicServer = await listen(appFor({}));
    servers.push(serverA, serverB, serverClient, publicServer);

    const page = '/api/experiments?url=' + encodeURIComponent('https://shop-a.example/pricing');
    const legacyList = await request(publicServer, 'GET', page);
    assert.ok(legacyList.json.experiments.some((exp) => exp.id === aExp.id));
    assert.ok(!legacyList.json.experiments.some((exp) => exp.id === bExp.id));
    assert.ok(!legacyList.json.experiments.some((exp) => exp.id === bHistory.id));

    const keyedB = await request(publicServer, 'GET', page + '&site=' + encodeURIComponent(bKey));
    assert.ok(keyedB.json.experiments.some((exp) => exp.id === bExp.id));
    assert.ok(!keyedB.json.experiments.some((exp) => exp.id === aExp.id));

    const keyedA = await request(publicServer, 'GET', page + '&site=' + encodeURIComponent(aKey));
    assert.ok(keyedA.json.experiments.some((exp) => exp.id === aExp.id));
    assert.ok(!keyedA.json.experiments.some((exp) => exp.id === bExp.id));

    const invalid = await request(publicServer, 'GET', page + '&site=site_' + 'g'.repeat(20));
    assert.deepStrictEqual(invalid.json.experiments, []);
    const unknown = await request(publicServer, 'GET', page + '&site=' + encodeURIComponent(newSiteKey()));
    assert.deepStrictEqual(unknown.json.experiments, []);

    const byIds = await request(
      publicServer,
      'GET',
      `/api/experiments/by-ids?ids=${aExp.id},${bExp.id}`,
      null,
      { origin: 'https://shop-a.example' }
    );
    assert.deepStrictEqual(byIds.json.experiments.map((exp) => exp.id), [aExp.id]);
    const byIdsB = await request(
      publicServer,
      'GET',
      `/api/experiments/by-ids?ids=${aExp.id},${bExp.id}&site=${bKey}`,
      null,
      { origin: 'https://shop-a.example' }
    );
    assert.ok(byIdsB.json.experiments.every((exp) => exp.id !== aExp.id));
    assert.ok(byIdsB.json.experiments.some((exp) => exp.id === bExp.id));

    const previewB = createPreviewToken(bExp.variantId, undefined, undefined, { accountId: bId, siteId: bSiteId });
    const previewLeak = await request(
      publicServer,
      'GET',
      page + `&preview=1&preview_variant=${bExp.variantId}&preview_token=${encodeURIComponent(previewB)}`
    );
    assert.ok(!previewLeak.json.experiments.some((exp) => exp.id === bExp.id));
    const previewA = createPreviewToken(aExp.variantId, undefined, undefined, { accountId: aId, siteId: aSiteId });
    const previewWrongSite = await request(
      publicServer,
      'GET',
      page + `&site=${aKey}&preview=1&preview_variant=${bExp.variantId}&preview_token=${encodeURIComponent(previewB)}`
    );
    assert.ok(!previewWrongSite.json.experiments.some((exp) => exp.id === bExp.id));
    assert.ok(previewA);

    async function postEvent(site, experiment, variant, visitor) {
      const body = {
        experiment_id: experiment,
        variant_id: variant,
        visitor_id: visitor,
        event_type: 'view',
      };
      if (site) body.site = site;
      return request(publicServer, 'POST', '/api/event', body, { origin: 'https://shop-a.example' });
    }
    assert.strictEqual((await postEvent(null, aExp.id, aExp.variantId, 'stored-on-a')).status, 204);
    assert.strictEqual((await postEvent(bKey, aExp.id, aExp.variantId, 'dropped-a-via-b')).status, 204);
    assert.strictEqual((await postEvent(null, bExp.id, bExp.variantId, 'dropped-b-legacy')).status, 204);
    assert.strictEqual((await postEvent(bKey, bExp.id, bExp.variantId, 'stored-on-b')).status, 204);
    assert.strictEqual((await postEvent('site_' + 'g'.repeat(20), aExp.id, aExp.variantId, 'dropped-bad-key')).status, 204);
    const stored = await db.query(
      `SELECT visitor_id FROM events
       WHERE visitor_id IN ('stored-on-a', 'dropped-a-via-b', 'dropped-b-legacy', 'stored-on-b', 'dropped-bad-key')
       ORDER BY visitor_id`
    );
    assert.deepStrictEqual(stored.rows.map((row) => row.visitor_id), ['stored-on-a', 'stored-on-b']);

    const foreign = [
      ['GET', `/api/experiments/${bExp.id}`],
      ['GET', `/api/experiments/${bExp.id}/health`],
      ['GET', `/api/results/${bExp.id}`],
      ['GET', `/api/results/${bExp.id}/export`],
      ['GET', `/api/results/${bExp.id}/timeseries`],
      ['GET', `/api/results/${bExp.id}/bayesian`],
      ['GET', `/api/results/${bExp.id}/verdict`],
      ['POST', `/api/experiments/${bExp.id}/test-traffic/preview`, { mode: 'test', direction: 'remove' }],
      ['POST', `/api/experiments/${bExp.id}/test-traffic/remove`, { mode: 'test', confirm: true }],
      ['POST', `/api/experiments/${bExp.id}/test-traffic/restore`, { mode: 'test', confirm: true }],
      ['GET', `/api/experiments/${bExp.id}/test-traffic/audit`],
      ['GET', `/api/experiments/${bExp.id}/plan`],
      ['PUT', `/api/experiments/${bExp.id}/plan`, {}],
      ['POST', `/api/experiments/${bExp.id}/reveal`, { confirm: true }],
      ['POST', `/api/experiments/${bExp.id}/variants/${bExp.variantId}/edit-link`, { page_url: 'https://shop-a.example/pricing' }],
      ['POST', `/api/experiments/${bExp.id}/variants/${bExp.variantId}/preview-link`, { page_url: 'https://shop-a.example/pricing' }],
      ['PATCH', `/api/experiments/${bExp.id}/hosts`, { allowed_hosts: ['evil.example'] }],
      ['PATCH', `/api/experiments/${bExp.id}/status`, { status: 'paused' }],
      ['DELETE', `/api/experiments/${bExp.id}`],
      ['PATCH', `/api/clients/${bClient.rows[0].id}`, { name: 'Hacked' }],
    ];
    for (const [method, urlPath, body] of foreign) {
      await expectMissing(serverA, method, urlPath, body);
    }
    await expectMissing(serverB, 'GET', `/api/experiments/${aExp.id}`);
    await expectMissing(serverB, 'GET', `/api/results/${aExp.id}/export`);
    await expectMissing(serverClient, 'GET', `/api/client/results/${bExp.id}`);

    const csv = await request(serverA, 'GET', `/api/results/${bExp.id}/export`);
    assert.strictEqual(csv.status, 404);
    assert.ok(!csv.text.includes('b-secret-visitor'));

    const all = await request(serverA, 'GET', '/api/experiments/all');
    assert.ok(all.json.experiments.some((exp) => exp.id === aExp.id));
    assert.ok(!all.json.experiments.some((exp) => exp.id === bExp.id));
    const clients = await request(serverA, 'GET', '/api/clients');
    assert.ok(clients.json.clients.some((client) => client.id === aClient.rows[0].id));
    assert.ok(!clients.json.clients.some((client) => client.id === bClient.rows[0].id));
    const goals = await request(serverA, 'GET', '/api/goals/popular');
    assert.ok(!goals.json.goals.some((goal) => goal.label === 'only-b-goal'));
    const goalsB = await request(serverB, 'GET', '/api/goals/popular');
    assert.ok(goalsB.json.goals.some((goal) => goal.label === 'only-b-goal'));

    const plan = await request(serverA, 'GET', `/api/experiments/${aExp.id}/plan`);
    assert.strictEqual(plan.status, 200);
    assert.strictEqual(plan.json.suggestion.baseline_source, 'default');
    assert.strictEqual(plan.json.suggestion.traffic_source, 'unknown');

    const hitsA = await request(serverA, 'GET', '/api/host-hits');
    assert.ok(hitsA.json.rows.some((row) => row.host === 'pivit.click'));
    assert.ok(!hitsA.json.rows.some((row) => row.referrer_origin === 'https://shop-a.example'));
    assert.ok(hitsA.json.excluded_windows.length >= 1);
    const hitsB = await request(serverB, 'GET', '/api/host-hits');
    assert.ok(hitsB.json.rows.some((row) => row.referrer_origin === 'https://shop-a.example'));
    assert.ok(!hitsB.json.rows.some((row) => row.host === 'pivit.click'));
    assert.strictEqual(hitsB.json.excluded_windows.length, 0);

    const stillRunning = await db.query(`SELECT status, allowed_hosts FROM experiments WHERE id = $1`, [bExp.id]);
    assert.strictEqual(stillRunning.rows[0].status, 'running');
    assert.deepStrictEqual(stillRunning.rows[0].allowed_hosts, ['shop-a.example']);
    const clientName = await db.query(`SELECT name FROM clients WHERE id = $1`, [bClient.rows[0].id]);
    assert.strictEqual(clientName.rows[0].name, 'Client B');

    const portal = await request(serverClient, 'GET', '/api/client/experiments');
    assert.deepStrictEqual(portal.json.experiments.map((exp) => exp.id), [aExp.id]);

    const badToken = createEditToken(bExp.variantId, undefined, { accountId: aId, siteId: aSiteId });
    const editor = await request(publicServer, 'GET', `/api/editor/variants/${bExp.variantId}?token=${encodeURIComponent(badToken)}`);
    assert.strictEqual(editor.status, 401);
    const patch = await request(
      publicServer,
      'PATCH',
      `/api/editor/variants/${bExp.variantId}?token=${encodeURIComponent(badToken)}`,
      { changes: [{ type: 'text', selector: 'h1', value: 'hacked' }] }
    );
    assert.strictEqual(patch.status, 401);
    const changes = await db.query(`SELECT changes FROM variants WHERE id = $1`, [bExp.variantId]);
    assert.deepStrictEqual(changes.rows[0].changes, []);

    const oldToken = createEditToken(aExp.variantId);
    const oldEditor = await request(publicServer, 'GET', `/api/editor/variants/${aExp.variantId}?token=${encodeURIComponent(oldToken)}`);
    assert.strictEqual(oldEditor.status, 200);
    const ownLink = await request(serverA, 'POST', `/api/experiments/${aExp.id}/variants/${aExp.variantId}/edit-link`, {
      page_url: 'https://shop-a.example/pricing',
    });
    assert.strictEqual(ownLink.status, 200);
    assert.ok(ownLink.json.edit_url.includes('ab_edit='));

    const loginSession = { save(cb) { cb(); } };
    const loginServer = await listen(appFor(loginSession));
    servers.push(loginServer);
    const login = await request(loginServer, 'POST', '/api/auth/login', { password: 'isolation-admin-key-value' });
    assert.deepStrictEqual(login.json, { role: 'owner' });
    assert.deepStrictEqual(Object.keys(login.json), ['role']);
    assert.strictEqual(loginSession.role, 'owner');
    assert.strictEqual(loginSession.accountId, aId);
    assert.ok(loginSession.userId);
    const me = await request(loginServer, 'GET', '/api/auth/me');
    assert.strictEqual(me.json.role, 'owner');
    assert.strictEqual(me.json.snippet_site_key, aKey);

    await db.query(
      `INSERT INTO audit_log (account_id, action, actor_label, detail)
       VALUES ($1, 'signup', 'a@example.com', '{}'::jsonb)`,
      [aId]
    );
    const auditB = await request(serverB, 'GET', '/api/audit');
    assert.strictEqual(auditB.status, 200);
    assert.ok(!auditB.json.entries.some((entry) => entry.account_id === aId));
    assert.ok(!auditB.text.includes(aKey));
    const invitesB = await request(serverB, 'GET', '/api/invites');
    assert.strictEqual(invitesB.status, 404);
    const viewB = await request(serverB, 'POST', '/api/auth/view-as', { account_id: aId });
    assert.strictEqual(viewB.status, 404);
    const setupB = await request(serverB, 'GET', '/api/setup');
    assert.strictEqual(setupB.status, 200);
    assert.notStrictEqual(setupB.json.site.public_key, aKey);
    const siteCount = await db.query(`SELECT COUNT(*)::int AS n FROM sites WHERE account_id = $1`, [aId]);
    const addOnA = await request(serverB, 'POST', '/api/sites', { website: 'evil.example' });
    assert.notStrictEqual(addOnA.status, 201);
    const siteCountAfter = await db.query(`SELECT COUNT(*)::int AS n FROM sites WHERE account_id = $1`, [aId]);
    assert.strictEqual(siteCountAfter.rows[0].n, siteCount.rows[0].n);

    const superUser = await db.query(`SELECT id FROM users WHERE is_superadmin IS TRUE LIMIT 1`);
    const viewSession = {
      role: 'owner',
      userId: superUser.rows[0].id,
      accountId: aId,
      superadmin: true,
      save(cb) { cb(); },
    };
    const viewServer = await listen(appFor(viewSession));
    servers.push(viewServer);
    const invitesA = await request(viewServer, 'GET', '/api/invites');
    assert.strictEqual(invitesA.status, 200);
    const started = await request(viewServer, 'POST', '/api/auth/view-as', { account_id: bId });
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.json.view_as.id, bId);
    const seen = await request(viewServer, 'GET', `/api/experiments/${bExp.id}`);
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.json.name, 'Account B');
    const blocked = await request(viewServer, 'PATCH', `/api/experiments/${bExp.id}/status`, { status: 'paused' });
    assert.strictEqual(blocked.status, 403);
    const statusAfterView = await db.query(`SELECT status FROM experiments WHERE id = $1`, [bExp.id]);
    assert.strictEqual(statusAfterView.rows[0].status, 'running');
    const viewed = await db.query(
      `SELECT account_id, action FROM audit_log WHERE action = 'view_as' ORDER BY id DESC LIMIT 1`
    );
    assert.strictEqual(viewed.rows[0].account_id, bId);
    const hiddenInvite = await request(viewServer, 'GET', '/api/invites');
    assert.strictEqual(hiddenInvite.status, 403);

    console.log('isolation db tests passed');
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
