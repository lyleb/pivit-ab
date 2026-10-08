const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const flags = require('../src/test-traffic');
const hits = require('../src/host-hits');
const snippet = require('../snippet/ab.js');

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    data,
  };
}

assert.strictEqual(flags.visitorIsTest('v_pt'), true);
assert.strictEqual(flags.visitorIsTest('v_ptmuyez2tm_'), true);
assert.strictEqual(flags.visitorIsTest('v_ptmuyez2tm_visitor'), true);
assert.strictEqual(flags.visitorIsTest('v_real'), false);
assert.strictEqual(flags.visitorIsTest('V_pt'), false);
assert.strictEqual(flags.visitorIsTest(''), false);
assert.strictEqual(flags.visitorIsTest(null), false);

assert.strictEqual(flags.flagIsOn('1'), true);
assert.strictEqual(flags.flagIsOn('true'), true);
assert.strictEqual(flags.flagIsOn(' yes '), true);
assert.strictEqual(flags.flagIsOn(1), true);
assert.strictEqual(flags.flagIsOn(true), true);
assert.strictEqual(flags.flagIsOn('0'), false);
assert.strictEqual(flags.flagIsOn('false'), false);
assert.strictEqual(flags.flagIsOn(''), false);
assert.strictEqual(flags.flagIsOn(undefined), false);

function request({ header, query, body, referer } = {}) {
  const headers = {};
  if (header != null) headers['x-pivit-test'] = header;
  if (referer) headers.referer = referer;
  return {
    headers,
    query: query || {},
    body: body || {},
    get(name) { return headers[String(name).toLowerCase()]; },
  };
}

assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_ptabc' } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_shopper' } })), false);
assert.strictEqual(flags.requestIsTestTraffic(request({ header: '1', body: { visitor_id: 'v_shopper' } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ header: '0', body: { visitor_id: 'v_shopper' } })), false);
assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_shopper', is_test: true } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_shopper', is_test: 1 } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_shopper', is_test: '1' } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ body: { visitor_id: 'v_shopper', is_test: false } })), false);
assert.strictEqual(flags.requestIsTestTraffic(request({ query: { pivit_qa: '1' }, body: { visitor_id: 'v_shopper' } })), true);
assert.strictEqual(flags.requestIsTestTraffic(request({ query: { pivit_qa: '0' }, body: { visitor_id: 'v_shopper' } })), false);
assert.strictEqual(flags.requestIsTestTraffic(request({
  referer: 'https://cantsaythat.co.uk/pricing?pivit_qa=1',
  body: { visitor_id: 'v_shopper' },
})), true);
assert.strictEqual(flags.requestIsTestTraffic(request()), false);

const store = memoryStore();
const cookies = [];
assert.strictEqual(snippet.qaFlagFromSearch('?pivit_qa=1'), '1');
assert.strictEqual(snippet.qaFlagFromSearch('pivit_qa=0'), '0');
assert.strictEqual(snippet.qaFlagFromSearch('?x=1&pivit_qa=1&pivit_qa=0'), '0');
assert.strictEqual(snippet.qaFlagFromSearch(''), null);
assert.strictEqual(snippet.applyQaFlag(store, '', '?pivit_qa=1', (value) => cookies.push(value)), true);
assert.strictEqual(store.data.pivit_qa, '1');
assert.ok(cookies[0].startsWith('pivit_qa=1'));
assert.strictEqual(snippet.readQaFlag(memoryStore(), 'theme=dark; pivit_qa=1'), true);
assert.strictEqual(snippet.applyQaFlag(store, 'pivit_qa=1', '?pivit_qa=0', (value) => cookies.push(value)), false);
assert.strictEqual(store.data.pivit_qa, undefined);
assert.ok(cookies[1].includes('Max-Age=0'));
assert.strictEqual(snippet.applyQaFlag(memoryStore({ pivit_qa: '1' }), '', '', () => {}), true);
assert.strictEqual(snippet.applyQaFlag(memoryStore(), '', '', () => {}), false);

const realEvent = snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_shopper', event_type: 'view', goal_id: null,
}, false);
assert.strictEqual(realEvent.is_test, undefined);
assert.strictEqual(JSON.stringify(realEvent).includes('is_test'), false);
const qaEvent = snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_shopper', event_type: 'view', goal_id: null,
}, true);
assert.strictEqual(qaEvent.is_test, true);
const prefixEvent = snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_ptmuyez2tm_a', event_type: 'convert', goal_id: 'cta',
}, false);
assert.strictEqual(prefixEvent.is_test, true);
assert.strictEqual(snippet.withQaQuery('https://pivitlab.com/api/experiments?url=1', false), 'https://pivitlab.com/api/experiments?url=1');
assert.strictEqual(snippet.withQaQuery('https://pivitlab.com/api/experiments?url=1', true), 'https://pivitlab.com/api/experiments?url=1&pivit_qa=1');

const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
assert.ok(!/X-Pivit-Test['"]?\s*:/.test(snippetSrc));
assert.ok(snippetSrc.includes('sendBeacon cannot set X-Pivit-Test'));
assert.ok(snippetSrc.includes('is_test'));
assert.ok(snippetSrc.includes('pivit_qa'));

const badPrefix = flags.normalisePrefix('v_');
assert.strictEqual(badPrefix.ok, false);
assert.strictEqual(flags.normalisePrefix('v_ptmuyez2tm_').ok, true);
assert.strictEqual(flags.normalisePrefix('v_pt%').ok, false);
assert.strictEqual(flags.parseCriteria({ mode: 'test' }).mode, 'test');
assert.strictEqual(flags.parseCriteria({ mode: 'prefix', prefix: 'v_ptmuyez2tm_' }).prefix, 'v_ptmuyez2tm_');
assert.strictEqual(flags.isConfirmed({ confirm: true }), true);
assert.strictEqual(flags.isConfirmed({ confirm: 'true' }), false);

const calls = [];
hits.scheduleHostHit({
  method: 'POST',
  path: '/api/event',
  hostname: 'pivitlab.com',
  headers: { origin: 'https://cantsaythat.co.uk', 'x-pivit-test': '1' },
  body: { visitor_id: 'v_shopper' },
  get(name) { return this.headers[name]; },
}, (sql, params) => { calls.push({ sql, params }); return Promise.resolve(); });
hits.scheduleHostHit({
  method: 'POST',
  path: '/api/event',
  hostname: 'pivitlab.com',
  headers: { origin: 'https://cantsaythat.co.uk' },
  query: { pivit_qa: '1' },
  body: { visitor_id: 'v_shopper' },
  get(name) { return this.headers[name]; },
}, (sql, params) => { calls.push({ sql, params }); return Promise.resolve(); });
hits.scheduleHostHit({
  method: 'POST',
  path: '/api/event',
  hostname: 'pivitlab.com',
  headers: { origin: 'https://cantsaythat.co.uk' },
  body: { visitor_id: 'v_ptmuyez2tm_a', is_test: true },
  get(name) { return this.headers[name]; },
}, (sql, params) => { calls.push({ sql, params }); return Promise.resolve(); });
hits.scheduleHostHit({
  method: 'GET',
  path: '/snippet/ab.js',
  hostname: 'pivitlab.com',
  headers: { origin: 'https://cantsaythat.co.uk' },
  get(name) { return this.headers[name]; },
}, (sql, params) => { calls.push({ sql, params }); return Promise.resolve(); }, new Date('2026-10-08T12:00:00Z'));
assert.strictEqual(calls.length, 1);
assert.deepStrictEqual(calls[0].params, ['2026-10-08', 'pivitlab.com', 'https://cantsaythat.co.uk']);

assert.strictEqual(hits.rowOverlapsExclusion({
  day: '2026-10-07',
  host: 'pivitlab.com',
  referrer_origin: 'https://cantsaythat.co.uk',
}, [{
  host: 'pivitlab.com',
  referrer_origin: 'https://cantsaythat.co.uk',
  started_at: '2026-10-07T12:22:00Z',
  ended_at: '2026-10-07T12:24:00Z',
}]), true);
assert.strictEqual(hits.rowOverlapsExclusion({
  day: '2026-10-08',
  host: 'pivitlab.com',
  referrer_origin: 'https://cantsaythat.co.uk',
}, [{
  host: 'pivitlab.com',
  referrer_origin: 'https://cantsaythat.co.uk',
  started_at: new Date('2026-10-07T18:01:00Z'),
  ended_at: new Date('2026-10-07T18:27:00Z'),
}]), false);

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
assert.ok(schema.includes('ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false'));
assert.ok(schema.includes('ADD COLUMN IF NOT EXISTS excluded_at'));
assert.ok(schema.includes("left(visitor_id, 4) = 'v_pt'"));
assert.ok(schema.includes('SET is_test = true'));
assert.ok(!schema.includes('DELETE FROM events'));
assert.ok(!schema.includes('DELETE FROM host_hits'));
assert.ok(schema.includes('54.201.40.3'));
assert.ok(schema.includes('2026-10-07T12:22:00Z'));
assert.ok(schema.includes('2026-10-07T12:24:00Z'));
assert.ok(schema.includes('2026-10-07T18:01:00Z'));
assert.ok(schema.includes('2026-10-07T18:27:00Z'));
assert.ok(schema.includes('https://cantsaythat.co.uk'));
assert.ok(schema.includes("'pivitlab.com'"));
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS host_hit_exclusions'));
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS test_traffic_audit'));

const clientHtml = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
const clientRoute = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(!clientHtml.includes('test-traffic'));
assert.ok(!clientHtml.includes('include-test-traffic'));
assert.ok(!clientHtml.includes('include_test'));
assert.ok(!clientRoute.includes('include_test'));
assert.ok(!clientRoute.includes('test-traffic'));
assert.ok(adminHtml.includes('id="include-test-traffic"'));
assert.ok(adminHtml.includes('id="test-traffic-modal"'));
assert.ok(adminHtml.includes('id="test-audit-table"'));
assert.ok(adminHtml.includes('Remove test traffic'));

const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
assert.ok(serverSrc.includes("res.json({ ok: true })"));
assert.ok(serverSrc.includes('cors({ origin: true, credentials: true })'));
assert.ok(!serverSrc.includes('allowedHeaders'));

function listen(session) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = session || {}; next(); });
  app.use('/api/experiments', require('../src/routes/experiments'));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify({ mode: 'test' });
    const req = http.request({
      port,
      method: 'POST',
      path: urlPath,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

(async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const pathName = `/api/experiments/${id}/test-traffic/preview`;
  const anon = await listen(null);
  const client = await listen({ role: 'client', clientId: id });
  try {
    const anonRes = await post(anon, pathName);
    const clientRes = await post(client, pathName);
    assert.strictEqual(anonRes.status, 401);
    assert.strictEqual(clientRes.status, 401);
    console.log('test-traffic tests passed');
  } finally {
    anon.close();
    client.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
