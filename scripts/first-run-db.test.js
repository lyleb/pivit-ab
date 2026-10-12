// PIV-051. The checklist ticks from the account's site, the install check,
// a saved test, a real ?pivit_qa=1 visit, and a started test. Hiding it is
// stored on the account. Migration 009 only adds columns.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
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
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function step(payload, id) {
  return payload.checklist.steps.find((item) => item.id === id);
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.ok(!schema.includes('checklist_dismissed_at'));
  assert.ok(!schema.includes('qa_seen_at'));
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(migrateSrc.includes("{ version: '009', name: 'first-run', run: applyFirstRun }"));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('first-run db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_firstrun_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyFirstRun } = require('../src/db/first-run');
  const { newSiteKey } = require('../src/db/tenancy');

  const servers = [];
  try {
    await migrate();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyFirstRun(client);
      await applyFirstRun(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const legacy = await db.query(
      `SELECT a.id, a.checklist_dismissed_at, s.qa_seen_at
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE`
    );
    assert.strictEqual(legacy.rows.length, 1);
    assert.strictEqual(legacy.rows[0].checklist_dismissed_at, null);
    assert.strictEqual(legacy.rows[0].qa_seen_at, null);
    const heclrId = legacy.rows[0].id;

    const fresh = await db.query(`INSERT INTO accounts (name) VALUES ('Fresh Ltd') RETURNING id`);
    const freshId = fresh.rows[0].id;
    const freshServer = await listen(appFor({ role: 'owner', accountId: freshId }));
    const signedOut = await listen(appFor({}));
    servers.push(freshServer, signedOut);

    const denied = await request(signedOut, 'GET', '/api/setup');
    assert.strictEqual(denied.status, 401);
    const deniedDismiss = await request(signedOut, 'POST', '/api/setup/dismiss');
    assert.strictEqual(deniedDismiss.status, 401);

    const before = await request(freshServer, 'GET', '/api/setup');
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.json.needs_setup, true);
    assert.strictEqual(before.json.site, null);
    assert.strictEqual(before.json.checklist.visible, true);
    assert.strictEqual(before.json.checklist.complete, false);
    assert.ok(before.json.checklist.steps.every((item) => item.done === false));

    const added = await request(freshServer, 'POST', '/api/sites', { website: 'fresh.example' });
    assert.strictEqual(added.status, 201);
    const withSite = await request(freshServer, 'GET', '/api/setup');
    assert.strictEqual(step(withSite.json, 'site').done, true);
    assert.strictEqual(step(withSite.json, 'snippet').done, false);
    assert.strictEqual(withSite.json.checklist.visible, true);

    const hidden = await request(freshServer, 'POST', '/api/setup/dismiss');
    assert.strictEqual(hidden.status, 200);
    assert.strictEqual(hidden.json.checklist.dismissed, true);
    assert.strictEqual(hidden.json.checklist.visible, false);
    assert.strictEqual(hidden.json.checklist.complete, false);
    const hiddenAgain = await request(freshServer, 'GET', '/api/setup');
    assert.strictEqual(hiddenAgain.json.checklist.visible, false);
    const dismissedAt = await db.query(
      `SELECT checklist_dismissed_at FROM accounts WHERE id = $1`,
      [freshId]
    );
    await request(freshServer, 'POST', '/api/setup/dismiss');
    const dismissedStill = await db.query(
      `SELECT checklist_dismissed_at FROM accounts WHERE id = $1`,
      [freshId]
    );
    assert.strictEqual(
      new Date(dismissedStill.rows[0].checklist_dismissed_at).toISOString(),
      new Date(dismissedAt.rows[0].checklist_dismissed_at).toISOString()
    );

    const learner = await db.query(`INSERT INTO accounts (name) VALUES ('Learner Ltd') RETURNING id`);
    const learnerId = learner.rows[0].id;
    const learnerServer = await listen(appFor({ role: 'owner', accountId: learnerId }));
    const publicServer = await listen(appFor({}));
    servers.push(learnerServer, publicServer);

    const site = await request(learnerServer, 'POST', '/api/sites', { website: 'www.learn.example' });
    assert.strictEqual(site.status, 201);
    assert.deepStrictEqual(site.json.site.domains, ['learn.example']);
    const key = site.json.site.public_key;
    const created = await request(learnerServer, 'POST', '/api/experiments', {
      name: 'Headline',
      url_match: '/pricing',
      allowed_hosts: ['learn.example'],
    });
    assert.strictEqual(created.status, 201, created.text);
    const drafted = await request(learnerServer, 'GET', '/api/setup');
    assert.strictEqual(drafted.json.needs_setup, false);
    assert.strictEqual(step(drafted.json, 'site').done, true);
    assert.strictEqual(step(drafted.json, 'test').done, true);
    assert.strictEqual(step(drafted.json, 'snippet').done, false);
    assert.strictEqual(step(drafted.json, 'preview').done, false);
    assert.strictEqual(step(drafted.json, 'started').done, false);
    assert.strictEqual(drafted.json.checklist.visible, true);
    const blockedStart = await request(
      learnerServer,
      'PATCH',
      `/api/experiments/${created.json.id}/status`,
      { status: 'running' }
    );
    assert.strictEqual(blockedStart.status, 400);
    assert.ok(/snippet/i.test(blockedStart.json.error));

    const page = '/api/experiments?url=' + encodeURIComponent('https://learn.example/pricing');
    const origin = { origin: 'https://www.learn.example' };
    const seen = await request(publicServer, 'GET', page + '&site=' + encodeURIComponent(key), null, origin);
    assert.strictEqual(seen.status, 200);
    const installed = await request(learnerServer, 'GET', '/api/setup');
    assert.strictEqual(step(installed.json, 'snippet').done, true);
    assert.strictEqual(installed.json.site.verified, true);
    assert.strictEqual(installed.json.site.install_check, null);
    assert.strictEqual(step(installed.json, 'preview').done, false);
    const notYet = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.strictEqual(notYet.rows[0].qa_seen_at, null);

    const headerOnly = await request(
      publicServer,
      'GET',
      page + '&site=' + encodeURIComponent(key),
      null,
      Object.assign({ 'x-pivit-test': '1' }, origin)
    );
    assert.strictEqual(headerOnly.status, 200);
    const stillWaiting = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.strictEqual(stillWaiting.rows[0].qa_seen_at, null);

    const wrongHost = await request(
      publicServer,
      'GET',
      page + '&pivit_qa=1&site=' + encodeURIComponent(key),
      null,
      { origin: 'https://evil.example' }
    );
    assert.strictEqual(wrongHost.status, 200);
    const wrongRow = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.strictEqual(wrongRow.rows[0].qa_seen_at, null);

    const preview = await request(
      publicServer,
      'GET',
      page + '&pivit_qa=1&site=' + encodeURIComponent(key),
      null,
      origin
    );
    assert.strictEqual(preview.status, 200);
    assert.ok(!preview.text.includes('qa_seen'));
    const marked = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.ok(marked.rows[0].qa_seen_at);
    const previewed = await request(learnerServer, 'GET', '/api/setup');
    assert.strictEqual(step(previewed.json, 'preview').done, true);
    assert.strictEqual(step(previewed.json, 'started').done, false);
    assert.strictEqual(previewed.json.checklist.visible, true);

    await request(
      publicServer,
      'GET',
      page + '&pivit_qa=1&site=' + encodeURIComponent(key),
      null,
      origin
    );
    const markedAgain = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.strictEqual(
      new Date(markedAgain.rows[0].qa_seen_at).toISOString(),
      new Date(marked.rows[0].qa_seen_at).toISOString()
    );

    const freshQa = await db.query(`SELECT qa_seen_at FROM sites WHERE account_id = $1`, [freshId]);
    assert.strictEqual(freshQa.rows[0].qa_seen_at, null);

    const running = await request(
      learnerServer,
      'PATCH',
      `/api/experiments/${created.json.id}/status`,
      { status: 'running' }
    );
    assert.strictEqual(running.status, 200, running.text);
    const started = await request(learnerServer, 'GET', '/api/setup');
    assert.strictEqual(step(started.json, 'started').done, true);
    assert.strictEqual(started.json.checklist.complete, true);
    assert.strictEqual(started.json.checklist.visible, false);
    assert.strictEqual(started.json.checklist.dismissed, false);

    const other = await db.query(`INSERT INTO accounts (name) VALUES ('Events Ltd') RETURNING id`);
    const otherId = other.rows[0].id;
    const otherKey = newSiteKey();
    const otherSite = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
       VALUES ($1, 'events.example', $2::text[], $3, now()) RETURNING id`,
      [otherId, ['events.example'], otherKey]
    );
    const exp = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated, started_at)
       VALUES ('Past', '/pricing', 'running', $1::text[], $2, $3, '[]'::jsonb, 'shared', true, now())
       RETURNING id`,
      [['events.example'], otherId, otherSite.rows[0].id]
    );
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
      [exp.rows[0].id]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       VALUES ($1, $2, 'v_shopper', 'view', true)`,
      [exp.rows[0].id, variant.rows[0].id]
    );
    const otherServer = await listen(appFor({ role: 'owner', accountId: otherId }));
    servers.push(otherServer);
    const fromEvents = await request(otherServer, 'GET', '/api/setup');
    assert.strictEqual(fromEvents.json.site.verified, true);
    assert.strictEqual(step(fromEvents.json, 'preview').done, true);
    assert.strictEqual(step(fromEvents.json, 'started').done, true);
    assert.strictEqual(fromEvents.json.checklist.visible, false);
    const otherQa = await db.query(`SELECT qa_seen_at FROM sites WHERE id = $1`, [otherSite.rows[0].id]);
    assert.strictEqual(otherQa.rows[0].qa_seen_at, null);

    const heclrExp = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated, started_at)
       SELECT 'Shop', '/pricing', 'running', ARRAY['cantsaythat.co.uk'], a.id, s.id, '[]'::jsonb, 'shared', true, now()
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE
       RETURNING id`
    );
    const heclrVariant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
      [heclrExp.rows[0].id]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       VALUES ($1, $2, 'v_ptlegacy', 'view', true)`,
      [heclrExp.rows[0].id, heclrVariant.rows[0].id]
    );
    const heclrServer = await listen(appFor({ role: 'owner', accountId: heclrId }));
    servers.push(heclrServer);
    const heclr = await request(heclrServer, 'GET', '/api/setup');
    assert.strictEqual(heclr.json.checklist.complete, true);
    assert.strictEqual(heclr.json.checklist.visible, false);
    assert.strictEqual(heclr.json.checklist.dismissed, false);

    const superUser = await db.query(`SELECT id FROM users WHERE email = 'info@heclr.com'`);
    const viewServer = await listen(appFor({
      role: 'owner',
      userId: superUser.rows[0].id,
      accountId: heclrId,
      viewAsAccountId: freshId,
    }));
    servers.push(viewServer);
    const viewed = await request(viewServer, 'GET', '/api/setup');
    assert.strictEqual(viewed.json.site.public_key, added.json.site.public_key);
    assert.strictEqual(viewed.json.checklist.dismissed, true);
    const blocked = await request(viewServer, 'POST', '/api/setup/dismiss');
    assert.strictEqual(blocked.status, 403);

    const repeat = await db.pool.connect();
    try {
      await repeat.query('BEGIN');
      await applyFirstRun(repeat);
      await repeat.query('COMMIT');
    } finally {
      repeat.release();
    }
    const kept = await db.query(`SELECT qa_seen_at FROM sites WHERE public_key = $1`, [key]);
    assert.strictEqual(
      new Date(kept.rows[0].qa_seen_at).toISOString(),
      new Date(marked.rows[0].qa_seen_at).toISOString()
    );

    console.log('first-run db tests passed');
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
