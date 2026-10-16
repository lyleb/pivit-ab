// Demo tests against Postgres: type lock, test traffic only, a full result
// without the 14-day wait, and exclusion from account baselines.
// Skips when Postgres is not reachable. Never reads DATABASE_URL.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

const BROWSER = {
  origin: 'https://example.test',
  'user-agent': 'Mozilla/5.0 (compatible; pivitlab-demo-test)',
};

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
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) {
          json = JSON.parse(text);
        }
        resolve({ status: res.statusCode, json, text });
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
  app.use('/api/event', require('../src/routes/events'));
  app.use('/api/results', require('../src/routes/results'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function expectRefusal(db, sql, params, pattern) {
  let caught = null;
  try {
    await db.query(sql, params);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected the database to refuse the type change');
  assert.ok(pattern.test(caught.message), caught.message);
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('demo-test db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_demo_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;
  delete process.env.POSTMARK_SERVER_TOKEN;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { suggest } = require('../src/experiment-plan');
  const { captureDemoSample } = require('../src/demo-sample');
  const { draftConclusion, releaseConclusion, approveConclusion, ownerPdf } = require('../src/conclusion');

  let server;
  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;

    const column = await db.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'experiments' AND column_name = 'test_type'`
    );
    assert.strictEqual(column.rows[0].is_nullable, 'NO');
    assert.ok(String(column.rows[0].column_default).includes('live'));

    const bare = await db.query(
      `INSERT INTO experiments (name, url_match, account_id)
       VALUES ('Bare live', 'https://example.test/bare', $1)
       RETURNING test_type`,
      [accountId]
    );
    assert.strictEqual(bare.rows[0].test_type, 'live');
    await expectRefusal(
      db,
      `UPDATE experiments SET test_type = 'demo' WHERE name = 'Bare live'`,
      [],
      /cannot be changed into a demo/
    );

    server = await listen(appFor({ role: 'owner' }));
    const created = await request(server, 'POST', '/api/experiments', {
      name: 'Homepage demo',
      url_match: 'https://example.test/',
      allowed_hosts: ['example.test'],
      test_type: 'demo',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.test_type, 'demo');
    assert.strictEqual(created.json.plan.demo, true);
    assert.strictEqual(created.json.plan.runtime_waived, true);
    assert.strictEqual(created.json.plan.visitors_per_variant, 100);
    assert.strictEqual(created.json.plan.min_runtime_days, 0);
    const id = created.json.id;
    const controlId = created.json.control_variant.id;

    const challenger = await request(server, 'POST', `/api/experiments/${id}/variants`, {
      name: 'Challenger',
      traffic_split: 50,
    });
    assert.strictEqual(challenger.status, 201, JSON.stringify(challenger.json));
    const challengerId = challenger.json.id;
    const planRow = await db.query(`SELECT plan FROM experiments WHERE id = $1`, [id]);
    assert.strictEqual(planRow.rows[0].plan.visitors_per_variant, 100);
    assert.strictEqual(planRow.rows[0].plan.variant_count, 2);

    const switched = await request(server, 'PATCH', `/api/experiments/${id}/status`, {
      status: 'running',
      test_type: 'live',
    });
    assert.strictEqual(switched.status, 400);
    assert.ok(switched.json.error.includes('cannot be switched to live'));
    const still = await db.query(`SELECT status, test_type FROM experiments WHERE id = $1`, [id]);
    assert.strictEqual(still.rows[0].status, 'draft');
    assert.strictEqual(still.rows[0].test_type, 'demo');
    await expectRefusal(
      db,
      `UPDATE experiments SET test_type = 'live' WHERE id = $1`,
      [id],
      /cannot be switched to live/
    );

    const lockedPlan = await request(server, 'PUT', `/api/experiments/${id}/plan`, {
      baseline_rate: 0.03,
      effect_choice: 'medium',
      min_runtime_days: 14,
    });
    assert.strictEqual(lockedPlan.status, 400);
    assert.ok(lockedPlan.json.error.includes('fixed sample'));

    await db.query(
      `UPDATE sites SET verified_at = now()
       WHERE id = (SELECT site_id FROM experiments WHERE id = $1)`,
      [id]
    );
    const started = await request(server, 'PATCH', `/api/experiments/${id}/status`, { status: 'running' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.json));
    assert.strictEqual(started.json.test_type, 'demo');
    assert.strictEqual(started.json.plan.visitors_per_variant, 100);

    const real = await request(server, 'POST', '/api/event', {
      experiment_id: id,
      variant_id: controlId,
      visitor_id: 'real-visitor-1',
      event_type: 'view',
    }, BROWSER);
    assert.strictEqual(real.status, 204);
    const realRows = await db.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE experiment_id = $1 AND is_test = false`,
      [id]
    );
    assert.strictEqual(realRows.rows[0].n, 0);

    const probe = await request(server, 'POST', '/api/event', {
      experiment_id: id,
      variant_id: controlId,
      visitor_id: 'v_pt_probe',
      event_type: 'view',
    }, BROWSER);
    assert.strictEqual(probe.status, 204);
    const probeRow = await db.query(`SELECT is_test FROM events WHERE visitor_id = 'v_pt_probe'`);
    assert.strictEqual(probeRow.rows.length, 1);
    assert.strictEqual(probeRow.rows[0].is_test, true);

    const page = '/api/experiments?url=' + encodeURIComponent('https://example.test/');
    const hidden = await request(server, 'GET', page, null, BROWSER);
    assert.strictEqual(hidden.status, 200);
    assert.ok(!(hidden.json.experiments || []).some((row) => row.id === id));

    const shown = await request(server, 'GET', page + '&pivit_qa=1', null, BROWSER);
    const demoPublic = (shown.json.experiments || []).find((row) => row.id === id);
    assert.ok(demoPublic, 'a pivit_qa caller should see the demo test');
    assert.strictEqual(demoPublic.test_type, 'demo');

    const live = await request(server, 'POST', '/api/experiments', {
      name: 'Homepage live',
      url_match: 'https://example.test/',
      allowed_hosts: ['example.test'],
    });
    assert.strictEqual(live.status, 201);
    assert.strictEqual(live.json.test_type, 'live');
    assert.strictEqual(live.json.plan, null);
    const liveId = live.json.id;
    await db.query(`UPDATE experiments SET status = 'running', started_at = now() WHERE id = $1`, [liveId]);

    const mixed = await request(server, 'GET', page, null, BROWSER);
    const livePublic = (mixed.json.experiments || []).find((row) => row.id === liveId);
    assert.ok(livePublic);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(livePublic, 'test_type'), false);
    assert.ok(!(mixed.json.experiments || []).some((row) => row.id === id));

    const byIds = await request(server, 'GET', `/api/experiments/by-ids?ids=${id},${liveId}`, null, BROWSER);
    assert.ok((byIds.json.experiments || []).some((row) => row.id === liveId));
    assert.ok(!(byIds.json.experiments || []).some((row) => row.id === id));

    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       SELECT $1, $2, 'v_ptda_' || g, 'view', true FROM generate_series(1, 100) g`,
      [id, controlId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       SELECT $1, $2, 'v_ptda_' || g, 'convert', true FROM generate_series(1, 8) g`,
      [id, controlId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       SELECT $1, $2, 'v_ptdb_' || g, 'view', true FROM generate_series(1, 100) g`,
      [id, challengerId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       SELECT $1, $2, 'v_ptdb_' || g, 'convert', true FROM generate_series(1, 22) g`,
      [id, challengerId]
    );

    const extra = await request(server, 'POST', '/api/event', {
      experiment_id: id,
      variant_id: challengerId,
      visitor_id: 'v_pt_extra',
      event_type: 'view',
    }, BROWSER);
    assert.strictEqual(extra.status, 204);
    const captured = await captureDemoSample(id);
    assert.ok(captured === 'written' || captured === 'stored', captured);

    const verdict = await request(server, 'GET', `/api/results/${id}/verdict?include_test=1`);
    assert.notStrictEqual(verdict.json && verdict.json.ready, false, JSON.stringify(verdict.json && verdict.json.reading));
    assert.strictEqual(verdict.json.reading.plan_met, true);
    assert.strictEqual(verdict.json.reading.runtime_met, true);
    assert.strictEqual(verdict.json.reading.days_elapsed, 0);
    const range = verdict.json.challengers && verdict.json.challengers[0];
    assert.ok(range, JSON.stringify(verdict.json));
    assert.ok(range.ci_low_label);
    assert.ok(range.ci_high_label);
    const counted = verdict.json.reading.variants.map((row) => row.visitors);
    assert.ok(counted.every((visitors) => visitors >= 100 && visitors < 120), counted.join(','));

    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       SELECT $1, $2, 'real_' || g, 'view', false FROM generate_series(1, 40) g`,
      [id, controlId]
    );
    const afterReal = await request(server, 'GET', `/api/results/${id}/verdict?include_test=1`);
    const afterCounts = afterReal.json.reading.variants.map((row) => row.visitors);
    assert.ok(afterCounts.every((visitors) => visitors < 120), afterCounts.join(','));

    const suggestion = await suggest(liveId, undefined, accountId);
    assert.strictEqual(suggestion.traffic_source, 'unknown');
    assert.notStrictEqual(suggestion.baseline_source, 'history');

    const snap = await db.query(
      `SELECT detail #>> '{public,concluded,label}' AS label,
              detail #>> '{public,recommendation}' AS recommendation,
              detail #>> '{public,concluded,range_label}' AS range_label
       FROM status_snapshots WHERE experiment_id = $1`,
      [id]
    );
    assert.ok(snap.rows[0], 'the demo sample should store a snapshot');
    assert.ok(snap.rows[0].label);
    assert.ok(snap.rows[0].range_label);
    assert.ok(snap.rows[0].recommendation.includes('14-day minimum runtime is skipped'));

    const client = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('North Shop', 'north-shop-demo', 'hash', $1)
       RETURNING id`,
      [accountId]
    );
    await db.query(`UPDATE experiments SET client_id = $2 WHERE id = $1`, [id, client.rows[0].id]);
    const drafted = await draftConclusion({ accountId, experimentId: id, actor: 'owner' });
    assert.strictEqual(drafted.ok, true, JSON.stringify(drafted));
    const released = await releaseConclusion({ accountId, experimentId: id, actor: 'owner' });
    assert.strictEqual(released.ok, true, JSON.stringify(released));
    const approved = await approveConclusion({
      clientId: client.rows[0].id,
      accountId,
      experimentId: id,
    });
    assert.strictEqual(approved.ok, true, JSON.stringify(approved));

    const conclusion = await ownerPdf(accountId, id, 'conclusion');
    assert.ok(conclusion, 'conclusion PDF should be available');
    const conclusionText = conclusion.bytes.toString('latin1');
    assert.ok(conclusionText.includes('(Demo)'));
    assert.ok(conclusionText.includes('14-day'));
    assert.ok(conclusionText.includes('Test traffic only'));
    assert.ok(conclusionText.includes('demo test'));
    const approval = await ownerPdf(accountId, id, 'approval');
    assert.ok(approval.bytes.toString('latin1').includes('(Demo)'));

    console.log('demo test db tests passed');
  } finally {
    if (server) server.close();
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
