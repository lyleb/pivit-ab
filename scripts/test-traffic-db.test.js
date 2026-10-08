// Test-traffic SQL against local Postgres. Skips (exit 0) when Postgres is
// not reachable, so npm test still passes without a database. This file never
// reads DATABASE_URL from the environment before choosing the local socket.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Client } = require('pg');
const express = require('express');

function localUrl(database) {
  return `postgres://ubuntu@/${database}?host=/var/run/postgresql`;
}

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
    req.session = session || {};
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/event', require('../src/routes/events'));
  app.use('/api/results', require('../src/routes/results'));
  app.use('/api/client', require('../src/routes/client'));
  return app;
}

async function main() {
  const admin = new Client({ connectionString: localUrl('postgres') });
  try {
    await admin.connect();
  } catch (err) {
    console.log('test-traffic db tests skipped:', err.message);
    return;
  }

  const dbName = 'pivit_test_traffic_' + Date.now().toString(36);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  process.env.DATABASE_URL = localUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';

  const db = require('../src/db');
  const metrics = require('../src/metrics');
  const hits = require('../src/host-hits');
  const traffic = require('../src/test-traffic');

  const ownerApp = appFor({ role: 'owner' });
  let ownerServer;
  let clientServer;
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await db.query(schema);

    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, status, goals, goals_scope, goals_migrated)
       VALUES ('Homepage', 'https://cantsaythat.co.uk/', 'running', $1::jsonb, 'shared', true)
       RETURNING id`,
      [JSON.stringify([{ type: 'click', selector: '.buy', id: 'buy', name: 'Buy', primary: true }])]
    );
    const experimentId = exp.rows[0].id;
    const control = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50) RETURNING id`,
      [experimentId]
    );
    const challenger = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Challenger', 50) RETURNING id`,
      [experimentId]
    );
    const controlId = control.rows[0].id;
    const challengerId = challenger.rows[0].id;

    async function track(variantId, visitorId, eventType, at, isTest) {
      await db.query(
        `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id, is_test, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [experimentId, variantId, visitorId, eventType, eventType === 'convert' ? 'buy' : null, !!isTest, at]
      );
    }

    await track(controlId, 'v_real', 'view', '2026-10-01T10:00:00Z', false);
    await track(controlId, 'v_real', 'convert', '2026-10-01T10:01:00Z', false);
    await track(controlId, 'real_batch_1', 'view', '2026-10-01T10:05:00Z', false);
    await track(controlId, 'v_ptold', 'view', '2026-10-02T10:00:00Z', false);
    await track(controlId, 'v_ptmuyez2tm_a', 'view', '2026-10-03T10:00:00Z', false);
    await track(controlId, 'v_ptmuyez2tm_a', 'convert', '2026-10-03T10:01:00Z', false);
    await track(challengerId, 'v_ptother', 'view', '2026-10-03T11:00:00Z', true);
    await track(challengerId, 'v_qa', 'view', '2026-10-03T12:00:00Z', true);

    await db.query(`UPDATE events SET is_test = true WHERE is_test = false AND left(visitor_id, 4) = 'v_pt'`);
    const backfill = await db.query(
      `SELECT visitor_id, is_test, excluded_at IS NULL AS kept
       FROM events WHERE experiment_id = $1 ORDER BY visitor_id, event_type`,
      [experimentId]
    );
    const byVisitor = new Map();
    backfill.rows.forEach((row) => {
      if (!byVisitor.has(row.visitor_id)) byVisitor.set(row.visitor_id, row);
    });
    assert.strictEqual(byVisitor.get('v_ptold').is_test, true);
    assert.strictEqual(byVisitor.get('v_ptmuyez2tm_a').is_test, true);
    assert.strictEqual(byVisitor.get('v_ptold').kept, true);
    assert.strictEqual(byVisitor.get('v_real').is_test, false);
    assert.strictEqual(byVisitor.get('real_batch_1').is_test, false);

    function visitorsNamed(results, name) {
      return results.find((row) => row.variant_name === name);
    }

    const excluded = await metrics.getVariantResults(experimentId);
    assert.strictEqual(visitorsNamed(excluded.results, 'Control').visitors, 2);
    assert.strictEqual(visitorsNamed(excluded.results, 'Control').conversions, 1);
    assert.strictEqual(visitorsNamed(excluded.results, 'Challenger').visitors, 0);

    const includedBefore = await metrics.getVariantResults(experimentId, undefined, { includeTest: true });
    assert.strictEqual(visitorsNamed(includedBefore.results, 'Control').visitors, 4);
    assert.strictEqual(visitorsNamed(includedBefore.results, 'Control').conversions, 2);
    assert.strictEqual(visitorsNamed(includedBefore.results, 'Challenger').visitors, 2);

    const bayesExcluded = await metrics.getPrimaryVariantData(experimentId);
    assert.strictEqual(bayesExcluded.variantData.find((row) => row.variant_name === 'Control').visitors, 2);
    assert.strictEqual(bayesExcluded.variantData.find((row) => row.variant_name === 'Control').conversions, 1);
    const bayesIncluded = await metrics.getPrimaryVariantData(experimentId, { includeTest: true });
    const seriesExcluded = await metrics.getTimeseries(experimentId);
    const seriesIncluded = await metrics.getTimeseries(experimentId, { includeTest: true });
    assert.ok(seriesIncluded.length > seriesExcluded.length);

    const prefixPreview = await traffic.previewTestTraffic(experimentId, { mode: 'prefix', prefix: 'v_ptmuyez2tm_' }, 'remove');
    assert.strictEqual(prefixPreview.visitors, 1);
    assert.strictEqual(prefixPreview.events, 2);
    const controlPreview = prefixPreview.variants.find((row) => row.variant_name === 'Control');
    const challengerPreview = prefixPreview.variants.find((row) => row.variant_name === 'Challenger');
    assert.strictEqual(controlPreview.visitors, 1);
    assert.strictEqual(controlPreview.events, 2);
    assert.strictEqual(challengerPreview.visitors, 0);
    assert.strictEqual(challengerPreview.events, 0);

    const testPreview = await traffic.previewTestTraffic(experimentId, { mode: 'test' }, 'remove');
    assert.strictEqual(testPreview.visitors, 4);
    assert.strictEqual(testPreview.events, 5);

    const removedPrefix = await traffic.applyTestTraffic({
      experimentId,
      criteria: { mode: 'prefix', prefix: 'v_ptmuyez2tm_' },
      direction: 'remove',
      actor: 'owner',
      actorIp: '127.0.0.1',
    });
    assert.strictEqual(removedPrefix.changed, true);
    assert.strictEqual(removedPrefix.visitors, 1);
    assert.strictEqual(removedPrefix.events, 2);

    const during = await metrics.getVariantResults(experimentId, undefined, { includeTest: true });
    assert.strictEqual(visitorsNamed(during.results, 'Control').visitors, 3);
    assert.strictEqual(visitorsNamed(during.results, 'Control').conversions, 1);
    const stillThere = await db.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE visitor_id = 'v_ptmuyez2tm_a' AND excluded_at IS NOT NULL`
    );
    assert.strictEqual(stillThere.rows[0].n, 2);

    const restoredPrefix = await traffic.applyTestTraffic({
      experimentId,
      criteria: { mode: 'prefix', prefix: 'v_ptmuyez2tm_' },
      direction: 'restore',
      actor: 'owner',
    });
    assert.strictEqual(restoredPrefix.changed, true);
    const includedAfter = await metrics.getVariantResults(experimentId, undefined, { includeTest: true });
    const excludedAfter = await metrics.getVariantResults(experimentId);
    assert.deepStrictEqual(includedAfter.results, includedBefore.results);
    assert.deepStrictEqual(excludedAfter.results, excluded.results);
    const bayesAfter = await metrics.getPrimaryVariantData(experimentId, { includeTest: true });
    assert.deepStrictEqual(bayesAfter.variantData, bayesIncluded.variantData);
    const seriesAfter = await metrics.getTimeseries(experimentId, { includeTest: true });
    assert.deepStrictEqual(seriesAfter, seriesIncluded);

    const defaultBeforePrefix = await metrics.getVariantResults(experimentId);
    await traffic.applyTestTraffic({
      experimentId,
      criteria: { mode: 'prefix', prefix: 'real_batch_' },
      direction: 'remove',
      actor: 'owner',
    });
    const hiddenReal = await metrics.getVariantResults(experimentId);
    assert.strictEqual(visitorsNamed(hiddenReal.results, 'Control').visitors, 1);
    await traffic.applyTestTraffic({
      experimentId,
      criteria: { mode: 'prefix', prefix: 'real_batch_' },
      direction: 'restore',
      actor: 'owner',
    });
    const defaultAfterPrefix = await metrics.getVariantResults(experimentId);
    assert.deepStrictEqual(defaultAfterPrefix.results, defaultBeforePrefix.results);

    const audit = await traffic.listTestTrafficAudit(experimentId);
    assert.ok(audit.entries.length >= 4);
    audit.entries.forEach((entry) => {
      assert.strictEqual(entry.actor, 'owner');
      assert.ok(entry.created_at);
      assert.ok(entry.visitor_count >= 1);
      assert.ok(entry.event_count >= 1);
    });
    const prefixRemove = audit.entries.find((entry) => entry.action === 'remove' && entry.criteria.prefix === 'v_ptmuyez2tm_');
    const prefixRestore = audit.entries.find((entry) => entry.action === 'restore' && entry.criteria.prefix === 'v_ptmuyez2tm_');
    assert.ok(prefixRemove);
    assert.strictEqual(prefixRemove.visitor_count, 1);
    assert.strictEqual(prefixRemove.event_count, 2);
    assert.ok(prefixRestore);

    ownerServer = await new Promise((resolve) => {
      const server = ownerApp.listen(0, () => resolve(server));
    });

    const unconfirmed = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/test-traffic/remove`, { mode: 'test' });
    assert.strictEqual(unconfirmed.status, 400);
    const previewHttp = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/test-traffic/preview`, {
      mode: 'prefix',
      prefix: 'v_ptmuyez2tm_',
      direction: 'remove',
    });
    assert.strictEqual(previewHttp.status, 200);
    assert.strictEqual(previewHttp.json.visitors, 1);
    assert.strictEqual(previewHttp.json.events, 2);
    const removeHttp = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/test-traffic/remove`, {
      mode: 'test',
      confirm: true,
    });
    assert.strictEqual(removeHttp.status, 200);
    assert.strictEqual(removeHttp.json.changed, true);
    const auditHttp = await request(ownerServer, 'GET', `/api/experiments/${experimentId}/test-traffic/audit`);
    assert.strictEqual(auditHttp.status, 200);
    assert.ok(auditHttp.json.entries.some((entry) => entry.action === 'remove' && entry.criteria.mode === 'test' && entry.actor === 'owner'));
    const restoreHttp = await request(ownerServer, 'POST', `/api/experiments/${experimentId}/test-traffic/restore`, {
      mode: 'test',
      confirm: true,
    });
    assert.strictEqual(restoreHttp.status, 200);
    const includedHttp = await request(ownerServer, 'GET', `/api/results/${experimentId}?include_test=1`);
    const excludedHttp = await request(ownerServer, 'GET', `/api/results/${experimentId}`);
    assert.strictEqual(visitorsNamed(excludedHttp.json.results, 'Control').visitors, 2);
    assert.strictEqual(visitorsNamed(includedHttp.json.results, 'Control').visitors, 4);
    assert.strictEqual(excludedHttp.json.include_test, false);
    assert.strictEqual(excludedHttp.json.test_traffic.excluded, true);
    const csv = await request(ownerServer, 'GET', `/api/results/${experimentId}/export`);
    assert.ok(!csv.text.includes('v_ptmuyez2tm_a'));
    assert.ok(csv.text.includes('v_real'));
    const csvIncluded = await request(ownerServer, 'GET', `/api/results/${experimentId}/export?include_test=1`);
    assert.ok(csvIncluded.text.includes('v_ptmuyez2tm_a'));

    const clientRow = await db.query(
      `INSERT INTO clients (name, username, password_hash) VALUES ('Can not say', 'cst', 'x') RETURNING id`
    );
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [clientRow.rows[0].id, experimentId]);
    const clientApp = appFor({ role: 'client', clientId: clientRow.rows[0].id });
    clientServer = await new Promise((resolve) => {
      const server = clientApp.listen(0, () => resolve(server));
    });
    const portal = await request(clientServer, 'GET', `/api/client/results/${experimentId}?include_test=1`);
    assert.strictEqual(portal.status, 200);
    assert.strictEqual(visitorsNamed(portal.json.results, 'Control').visitors, 2);
    assert.strictEqual(portal.json.test_traffic, undefined);

    const ua = { 'user-agent': 'Mozilla/5.0 (compatible; pivitlab-check)' };
    async function postEvent(urlPath, body, extra) {
      return request(ownerServer, 'POST', urlPath, body, Object.assign({}, ua, extra));
    }
    const base = { experiment_id: experimentId, variant_id: controlId, event_type: 'view' };
    assert.strictEqual((await postEvent('/api/event', Object.assign({ visitor_id: 'v_http_real' }, base))).status, 204);
    assert.strictEqual((await postEvent('/api/event', Object.assign({ visitor_id: 'v_pt_http' }, base))).status, 204);
    assert.strictEqual((await postEvent('/api/event', Object.assign({ visitor_id: 'v_http_field', is_test: true }, base))).status, 204);
    assert.strictEqual((await postEvent('/api/event', Object.assign({ visitor_id: 'v_http_header' }, base), { 'x-pivit-test': '1' })).status, 204);
    assert.strictEqual((await postEvent('/api/event?pivit_qa=1', Object.assign({ visitor_id: 'v_http_param' }, base))).status, 204);
    const stored = await db.query(
      `SELECT visitor_id, is_test FROM events WHERE visitor_id LIKE 'v_http%' OR visitor_id = 'v_pt_http' ORDER BY visitor_id`
    );
    const flagged = Object.fromEntries(stored.rows.map((row) => [row.visitor_id, row.is_test]));
    assert.strictEqual(flagged.v_http_real, false);
    assert.strictEqual(flagged.v_pt_http, true);
    assert.strictEqual(flagged.v_http_field, true);
    assert.strictEqual(flagged.v_http_header, true);
    assert.strictEqual(flagged.v_http_param, true);

    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count)
       VALUES ('2026-10-07', 'pivitlab.com', 'https://cantsaythat.co.uk', 40)`
    );
    await hits.scheduleHostHit({
      method: 'POST',
      path: '/api/event',
      hostname: 'pivitlab.com',
      headers: { origin: 'https://cantsaythat.co.uk', 'x-pivit-test': '1' },
      body: { visitor_id: 'v_shopper', is_test: true },
      get(name) { return this.headers[String(name).toLowerCase()]; },
    }, db.query.bind(db), new Date('2026-10-08T12:00:00Z'));
    await hits.scheduleHostHit({
      method: 'GET',
      path: '/snippet/ab.js',
      hostname: 'pivitlab.com',
      headers: { origin: 'https://cantsaythat.co.uk' },
      get(name) { return this.headers[String(name).toLowerCase()]; },
    }, db.query.bind(db), new Date('2026-10-08T12:00:00Z'));
    await db.query(schema);
    const keptHits = await db.query(
      `SELECT day::text AS day, hit_count FROM host_hits WHERE host = 'pivitlab.com' ORDER BY day`
    );
    assert.deepStrictEqual(keptHits.rows.map((row) => [row.day, Number(row.hit_count)]), [
      ['2026-10-07', 40],
      ['2026-10-08', 1],
    ]);
    const windows = await db.query(`SELECT source_ip, started_at, ended_at FROM host_hit_exclusions ORDER BY started_at`);
    assert.strictEqual(windows.rows.length, 2);
    assert.strictEqual(windows.rows[0].source_ip, '54.201.40.3');
    assert.strictEqual(new Date(windows.rows[0].started_at).toISOString(), '2026-10-07T12:22:00.000Z');
    assert.strictEqual(new Date(windows.rows[0].ended_at).toISOString(), '2026-10-07T12:24:00.000Z');
    assert.strictEqual(new Date(windows.rows[1].started_at).toISOString(), '2026-10-07T18:01:00.000Z');
    assert.strictEqual(new Date(windows.rows[1].ended_at).toISOString(), '2026-10-07T18:27:00.000Z');

    const health = await request(ownerServer, 'GET', `/api/experiments/${experimentId}/health`);
    const testCheck = health.json.checks.find((check) => check.title === 'Test traffic');
    assert.ok(testCheck.detail.includes('excluded'));
    assert.strictEqual(health.json.test_traffic.excluded, true);
    assert.ok(health.json.test_traffic.visitors >= 3);

    console.log('test-traffic db tests passed');
  } finally {
    if (ownerServer) await new Promise((resolve) => ownerServer.close(resolve));
    if (clientServer) await new Promise((resolve) => clientServer.close(resolve));
    await db.pool.end();
    const drop = new Client({ connectionString: localUrl('postgres') });
    await drop.connect();
    await drop.query(`DROP DATABASE ${dbName}`);
    await drop.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
