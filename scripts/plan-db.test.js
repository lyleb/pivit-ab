// Plan, blind mode, reveal and verdict against local Postgres.
// Skips (exit 0) when Postgres is not reachable. Never reads DATABASE_URL.
// TEST_DATABASE_URL (CI) is the only other connection, and a failure there
// fails the run instead of skipping.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
    req.session = session || {};
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/results', require('../src/routes/results'));
  app.use('/api/client', require('../src/routes/client'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('plan db tests skipped: postgres not reachable');
    return;
  }

  const dbName = 'pivit_plan_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  let ownerServer;
  let clientServer;
  try {
    await migrate();
    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const accountId = account.rows[0].id;

    const clientRow = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id) VALUES ('Acme', $1, 'x', $2) RETURNING id`,
      ['acme-plan-' + Date.now().toString(36), accountId]
    );
    const clientId = clientRow.rows[0].id;

    async function makeExperiment({ name, status, hosts, plan, startedAt, client, url }) {
      const inserted = await db.query(
        `INSERT INTO experiments (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, plan, started_at, client_id, account_id)
         VALUES ($1, $2, $3, $4::text[], '[]'::jsonb, 'shared', true, $5::jsonb, $6, $7, $8)
         RETURNING id`,
        [
          name,
          url || 'https://shop.example/',
          status,
          hosts || ['shop.example'],
          plan ? JSON.stringify(plan) : null,
          startedAt || null,
          client || null,
          accountId,
        ]
      );
      const experimentId = inserted.rows[0].id;
      const control = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50) RETURNING id`,
        [experimentId]
      );
      const challenger = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Challenger', 50) RETURNING id`,
        [experimentId]
      );
      return { id: experimentId, controlId: control.rows[0].id, challengerId: challenger.rows[0].id };
    }

    async function addVisitors(experimentId, variantId, count, converts, prefix) {
      if (count > 0) {
        await db.query(
          `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
           SELECT $1, $2, $3 || g::text, 'view', now() - interval '2 days'
           FROM generate_series(1, $4) g`,
          [experimentId, variantId, prefix, count]
        );
      }
      if (converts > 0) {
        await db.query(
          `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
           SELECT $1, $2, $3 || g::text, 'convert', now() - interval '2 days'
           FROM generate_series(1, $4) g`,
          [experimentId, variantId, prefix, converts]
        );
      }
    }

    async function fingerprint() {
      const { rows } = await db.query(
        `SELECT id, experiment_id, variant_id, visitor_id, event_type, goal_id, is_test, excluded_at
         FROM events ORDER BY id`
      );
      return JSON.stringify(rows);
    }

    const history = await makeExperiment({
      name: 'History',
      status: 'running',
      url: 'https://history.example/',
      hosts: ['history.example'],
    });
    await addVisitors(history.id, history.controlId, 100, 10, 'hist-');

    const hitsOnly = await makeExperiment({
      name: 'Hits',
      status: 'running',
      url: 'https://hits.example/',
      hosts: ['hits.example'],
    });
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count)
       VALUES (CURRENT_DATE, 'pivitlab.com', 'https://hits.example', 280)`
    );

    const draft = await makeExperiment({
      name: 'Draft',
      status: 'draft',
      url: 'https://draft.example/',
      hosts: ['draft.example'],
    });
    const kept = await makeExperiment({
      name: 'Kept plan',
      status: 'draft',
      url: 'https://kept.example/',
      hosts: ['kept.example'],
    });
    const paused = await makeExperiment({
      name: 'Paused',
      status: 'paused',
      url: 'https://paused.example/',
      hosts: ['paused.example'],
    });
    const unplanned = await makeExperiment({ name: 'Unplanned', status: 'running', client: clientId });
    await addVisitors(unplanned.id, unplanned.controlId, 2, 1, 'open-');

    const storedPlan = {
      visitors_per_variant: 100000,
      min_runtime_days: 14,
      baseline_rate: 0.03,
      relative_effect: 0.1,
      effect_choice: 'medium',
      source: 'auto',
      sentence: "You'll need about 100,000 visitors per variant.",
      power: 0.8,
      alpha: 0.05,
      comparisons: 1,
      variant_count: 2,
    };
    const blind = await makeExperiment({
      name: 'Blind',
      status: 'running',
      plan: storedPlan,
      startedAt: new Date().toISOString(),
      client: clientId,
    });
    await addVisitors(blind.id, blind.controlId, 3, 1, 'blind-secret-');
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
       VALUES ($1, $2, 'blind-secret-convert', 'convert', now())`,
      [blind.id, blind.challengerId]
    );

    const ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const metPlan = (visitors) => ({
      visitors_per_variant: visitors,
      min_runtime_days: 7,
      baseline_rate: 0.1,
      relative_effect: 0.5,
      effect_choice: 'custom',
      source: 'owner',
      sentence: "You'll need about " + visitors + ' visitors per variant.',
      power: 0.8,
      alpha: 0.05,
      alpha_per_comparison: 0.05,
      comparisons: 1,
      variant_count: 2,
    });
    const win = await makeExperiment({ name: 'Win', status: 'running', plan: metPlan(20), startedAt: ago });
    await addVisitors(win.id, win.controlId, 20, 2, 'win-c-');
    await addVisitors(win.id, win.challengerId, 20, 16, 'win-b-');

    const inconclusive = await makeExperiment({
      name: 'Inconclusive',
      status: 'running',
      plan: metPlan(40),
      startedAt: ago,
    });
    await addVisitors(inconclusive.id, inconclusive.controlId, 40, 8, 'inc-c-');
    await addVisitors(inconclusive.id, inconclusive.challengerId, 40, 9, 'inc-b-');

    const broken = await makeExperiment({ name: 'Broken split', status: 'running', plan: metPlan(5), startedAt: ago });
    await addVisitors(broken.id, broken.controlId, 80, 8, 'srm-c-');
    await addVisitors(broken.id, broken.challengerId, 5, 1, 'srm-b-');

    const before = await fingerprint();

    ownerServer = await listen(appFor({ role: 'owner' }));
    clientServer = await listen(appFor({ role: 'client', clientId }));

    const suggested = await request(ownerServer, 'GET', `/api/experiments/${history.id}/plan`);
    assert.strictEqual(suggested.status, 200);
    assert.strictEqual(suggested.json.suggestion.baseline_source, 'history');
    assert.ok(Math.abs(suggested.json.suggestion.baseline_rate - 0.1) < 0.001);
    assert.ok(suggested.json.suggestion.baseline_label.includes('You can change it'));
    assert.strictEqual(suggested.json.preview.source, 'auto');
    assert.strictEqual(suggested.json.preview.effect_choice, 'medium');
    assert.ok(suggested.json.preview.sentence.startsWith("You'll need about"));
    assert.ok(!suggested.json.preview.sentence.includes('MDE'));

    const fromHits = await request(ownerServer, 'GET', `/api/experiments/${hitsOnly.id}/plan`);
    assert.strictEqual(fromHits.status, 200);
    assert.strictEqual(fromHits.json.suggestion.baseline_source, 'default');
    assert.ok(fromHits.json.suggestion.baseline_label.includes('3%'));
    assert.strictEqual(fromHits.json.suggestion.traffic_source, 'host_hits');
    assert.strictEqual(fromHits.json.suggestion.weekly_traffic, 70);

    const ownerPlan = {
      baseline_rate: 0.04,
      relative_effect: 0.2,
      effect_choice: 'big',
      weekly_traffic: 800,
      min_runtime_days: 14,
      source: 'owner',
    };
    const savedOwner = await request(ownerServer, 'PUT', `/api/experiments/${kept.id}/plan`, ownerPlan);
    assert.strictEqual(savedOwner.status, 200);
    assert.strictEqual(savedOwner.json.plan.source, 'owner');
    assert.strictEqual(savedOwner.json.plan.effect_choice, 'big');

    const startedKept = await request(ownerServer, 'PATCH', `/api/experiments/${kept.id}/status`, { status: 'running' });
    assert.strictEqual(startedKept.status, 200);
    assert.strictEqual(startedKept.json.plan.source, 'owner');
    assert.strictEqual(startedKept.json.plan.effect_choice, 'big');

    const startedDraft = await request(ownerServer, 'PATCH', `/api/experiments/${draft.id}/status`, { status: 'running' });
    assert.strictEqual(startedDraft.status, 200);
    assert.ok(startedDraft.json.plan);
    assert.strictEqual(startedDraft.json.plan.source, 'auto');
    assert.strictEqual(startedDraft.json.plan.effect_choice, 'medium');
    assert.strictEqual(startedDraft.json.plan.baseline_rate, 0.03);
    assert.strictEqual(startedDraft.json.plan.power, 0.8);

    const resumed = await request(ownerServer, 'PATCH', `/api/experiments/${paused.id}/status`, { status: 'running' });
    assert.strictEqual(resumed.status, 200);
    assert.strictEqual(resumed.json.plan, null);

    const openResults = await request(ownerServer, 'GET', `/api/results/${unplanned.id}`);
    assert.strictEqual(openResults.status, 200);
    assert.strictEqual(openResults.json.reading.mode, 'unplanned');
    assert.strictEqual(openResults.json.blinded, false);
    const openControl = openResults.json.results.find((row) => row.variant_name === 'Control');
    assert.strictEqual(openControl.visitors, 2);
    assert.strictEqual(openControl.conversions, 1);
    assert.ok(openControl.conversion_rate != null);
    const openCsv = await request(ownerServer, 'GET', `/api/results/${unplanned.id}/export`);
    assert.ok(openCsv.text.startsWith('created_at,event_type'));
    assert.ok(openCsv.text.includes('open-1'));

    const hidden = await request(ownerServer, 'GET', `/api/results/${blind.id}`);
    assert.strictEqual(hidden.json.reading.mode, 'blind');
    assert.strictEqual(hidden.json.blinded, true);
    const hiddenControl = hidden.json.results.find((row) => row.variant_name === 'Control');
    assert.strictEqual(hiddenControl.visitors, 3);
    assert.strictEqual(hiddenControl.conversion_rate, undefined);
    assert.strictEqual(hiddenControl.conversions, undefined);
    assert.deepStrictEqual(hidden.json.goals, []);
    const hiddenBayes = await request(ownerServer, 'GET', `/api/results/${blind.id}/bayesian`);
    assert.deepStrictEqual(hiddenBayes.json.stats, []);
    const hiddenSeries = await request(ownerServer, 'GET', `/api/results/${blind.id}/timeseries`);
    assert.deepStrictEqual(hiddenSeries.json.series, []);
    const hiddenRecent = await request(ownerServer, 'GET', `/api/results/${blind.id}/recent`);
    assert.ok(hiddenRecent.json.events.length > 0);
    assert.ok(hiddenRecent.json.events.every((row) => row.event_type === 'view'));
    const progressCsv = await request(ownerServer, 'GET', `/api/results/${blind.id}/export`);
    assert.ok(progressCsv.headers['content-disposition'].includes('progress.csv'));
    assert.ok(progressCsv.text.startsWith('variant_name,visitors,target_visitors'));
    assert.ok(!progressCsv.text.includes('blind-secret'));
    assert.ok(!progressCsv.text.includes('convert'));
    const earlyVerdict = await request(ownerServer, 'GET', `/api/results/${blind.id}/verdict`);
    assert.strictEqual(earlyVerdict.json.ready, false);

    const clientHidden = await request(clientServer, 'GET', `/api/client/results/${blind.id}`);
    assert.strictEqual(clientHidden.status, 200);
    assert.strictEqual(clientHidden.json.blinded, true);
    assert.strictEqual(clientHidden.json.results[0].conversions, undefined);
    const clientSeries = await request(clientServer, 'GET', `/api/client/results/${blind.id}/timeseries`);
    assert.deepStrictEqual(clientSeries.json.series, []);
    const clientOpen = await request(clientServer, 'GET', `/api/client/results/${unplanned.id}`);
    assert.strictEqual(clientOpen.json.reading.mode, 'unplanned');
    assert.ok(clientOpen.json.results.find((row) => row.variant_name === 'Control').conversion_rate != null);

    const noConfirm = await request(ownerServer, 'POST', `/api/experiments/${blind.id}/reveal`, {});
    assert.strictEqual(noConfirm.status, 400);
    const clientReveal = await request(clientServer, 'POST', `/api/experiments/${blind.id}/reveal`, { confirm: true });
    assert.strictEqual(clientReveal.status, 401);
    const revealed = await request(ownerServer, 'POST', `/api/experiments/${blind.id}/reveal`, { confirm: true });
    assert.strictEqual(revealed.status, 200);
    assert.ok(revealed.json.peeked_at);
    assert.strictEqual(revealed.json.reading.mode, 'peeked');
    const afterPeek = await request(ownerServer, 'GET', `/api/results/${blind.id}`);
    const peekedControl = afterPeek.json.results.find((row) => row.variant_name === 'Control');
    assert.strictEqual(peekedControl.conversions, 1);
    assert.ok(peekedControl.conversion_rate != null);
    const peekedCsv = await request(ownerServer, 'GET', `/api/results/${blind.id}/export`);
    assert.ok(peekedCsv.text.includes('blind-secret-1'));
    assert.ok(peekedCsv.text.includes('convert'));
    const audit = await request(ownerServer, 'GET', `/api/experiments/${blind.id}/test-traffic/audit`);
    const revealRow = audit.json.entries.find((entry) => entry.action === 'reveal');
    assert.ok(revealRow);
    assert.strictEqual(revealRow.actor, 'owner');
    assert.strictEqual(revealRow.criteria.kind, 'peek');
    const again = await request(ownerServer, 'POST', `/api/experiments/${blind.id}/reveal`, { confirm: true });
    assert.strictEqual(again.status, 200);
    const revealCount = await db.query(
      `SELECT COUNT(*)::int AS n FROM test_traffic_audit WHERE experiment_id = $1 AND action = 'reveal'`,
      [blind.id]
    );
    assert.strictEqual(revealCount.rows[0].n, 2);
    const peekedAt = await db.query(`SELECT peeked_at FROM experiments WHERE id = $1`, [blind.id]);
    assert.strictEqual(new Date(peekedAt.rows[0].peeked_at).toISOString(), new Date(revealed.json.peeked_at).toISOString());

    const clientPeeked = await request(clientServer, 'GET', `/api/client/results/${blind.id}`);
    assert.strictEqual(clientPeeked.json.reading.mode, 'peeked');
    assert.strictEqual(clientPeeked.json.blinded, false);
    assert.ok(clientPeeked.json.results.find((row) => row.variant_name === 'Control').conversions != null);

    const winVerdict = await request(ownerServer, 'GET', `/api/results/${win.id}/verdict`);
    assert.strictEqual(winVerdict.status, 200);
    assert.strictEqual(winVerdict.json.ready, true);
    assert.strictEqual(winVerdict.json.challengers[0].verdict, 'win');
    assert.ok(winVerdict.json.challengers[0].rule_out);
    const winResults = await request(ownerServer, 'GET', `/api/results/${win.id}`);
    assert.strictEqual(winResults.json.reading.mode, 'verdict');

    const incVerdict = await request(ownerServer, 'GET', `/api/results/${inconclusive.id}/verdict`);
    assert.strictEqual(incVerdict.json.challengers[0].verdict, 'inconclusive');
    assert.ok(incVerdict.json.challengers[0].rule_out.toLowerCase().includes('unlikely'));

    const brokenVerdict = await request(ownerServer, 'GET', `/api/results/${broken.id}/verdict`);
    assert.strictEqual(brokenVerdict.json.label, 'Data problem');
    assert.deepStrictEqual(brokenVerdict.json.challengers, []);
    assert.deepStrictEqual(brokenVerdict.json.probability_best, []);
    const brokenResults = await request(ownerServer, 'GET', `/api/results/${broken.id}`);
    assert.strictEqual(brokenResults.json.reading.mode, 'data_problem');

    const noPlanReveal = await request(ownerServer, 'POST', `/api/experiments/${unplanned.id}/reveal`, { confirm: true });
    assert.strictEqual(noPlanReveal.status, 400);

    const after = await fingerprint();
    assert.strictEqual(after, before);

    console.log('plan db tests passed');
  } finally {
    if (ownerServer) await new Promise((resolve) => ownerServer.close(resolve));
    if (clientServer) await new Promise((resolve) => clientServer.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
