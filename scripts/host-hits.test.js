const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hits = require('../src/host-hits');

function req({ method = 'GET', path: reqPath = '/', hostname = 'pivit.click', origin, referer } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  return {
    method,
    path: reqPath,
    hostname,
    headers,
    get(name) { return headers[String(name).toLowerCase()]; },
  };
}

assert.strictEqual(hits.shouldCountRequest(req({ path: '/health' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/health/' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/robots.txt' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/robots.txt/' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/robots.txt?x=1' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/index.html' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/host-hits' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/results/abc' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/client/experiments' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/experiments/all' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ method: 'POST', path: '/api/experiments' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ method: 'GET', path: '/api/event' })), false);

assert.strictEqual(hits.shouldCountRequest(req({ path: '/snippet/picker-bookmarklet.js' })), false);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/snippet/ab.js' })), true);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/snippet/editor.js' })), true);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/experiments' })), true);
assert.strictEqual(hits.shouldCountRequest(req({ path: '/api/experiments/by-ids' })), true);
assert.strictEqual(hits.shouldCountRequest(req({ method: 'POST', path: '/api/event' })), true);

const counted = hits.hostHitFromRequest(req({
  hostname: 'Pivit.Click',
  origin: 'https://WWW.CantSayThat.co.uk',
  referer: 'https://other.example/ignored',
}), new Date('2026-10-07T23:30:00Z'));
assert.strictEqual(counted.host, 'pivit.click');
assert.strictEqual(counted.referrer_origin, 'https://www.cantsaythat.co.uk');
assert.strictEqual(counted.day, '2026-10-07');

const fromReferer = hits.hostHitFromRequest(req({
  hostname: 'pivitlab.com',
  referer: 'https://Shop.Example/pricing?x=1',
}));
assert.strictEqual(fromReferer.host, 'pivitlab.com');
assert.strictEqual(fromReferer.referrer_origin, 'https://shop.example');

const unknown = hits.hostHitFromRequest(req({ hostname: '', referer: 'not a url' }));
assert.strictEqual(unknown.host, '(unknown)');
assert.strictEqual(unknown.referrer_origin, '');

const calls = [];
hits.scheduleHostHit(req({ path: '/snippet/ab.js', hostname: 'pivit.click', origin: 'https://cantsaythat.co.uk' }), (sql, params) => {
  calls.push({ sql, params });
  return Promise.resolve();
}, new Date('2026-10-07T12:00:00Z'));
assert.strictEqual(calls.length, 1);
assert.ok(calls[0].sql.includes('ON CONFLICT (day, host, referrer_origin)'));
assert.deepStrictEqual(calls[0].params, ['2026-10-07', 'pivit.click', 'https://cantsaythat.co.uk']);

let healthCalls = 0;
hits.scheduleHostHit(req({ path: '/health' }), () => { healthCalls += 1; return Promise.resolve(); });
hits.scheduleHostHit(req({ path: '/robots.txt' }), () => { healthCalls += 1; return Promise.resolve(); });
assert.strictEqual(healthCalls, 0);

const logged = [];
const originalError = console.error;
console.error = (...args) => logged.push(args.map(String).join(' '));
assert.doesNotThrow(() => {
  hits.scheduleHostHit(req({ path: '/api/event', method: 'POST' }), () => Promise.reject(new Error('db down')));
  hits.scheduleHostHit(req({ path: '/snippet/ab.js' }), () => { throw new Error('sync down'); });
});
assert.ok(logged.some((line) => line.includes('sync down')));

const summary = hits.summariseHostHits([
  { host: 'pivit.click', hit_count: 2 },
  { host: 'pivitlab.com', hit_count: 5 },
  { host: 'pivit.click', hit_count: '3' },
]);
assert.deepStrictEqual(summary, [
  { host: 'pivit.click', hit_count: 5 },
  { host: 'pivitlab.com', hit_count: 5 },
]);

const window = hits.windowStartDay(30, new Date('2026-10-07T15:00:00Z'));
assert.strictEqual(window.days, 30);
assert.strictEqual(window.start, '2026-09-08');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS host_hits'));
assert.ok(schema.includes('PRIMARY KEY (day, host, referrer_origin)'));
assert.ok(schema.includes('hit_count'));

const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
assert.ok(server.includes('hostHitMiddleware'));
assert.ok(server.includes("'/api/host-hits'"));

setTimeout(() => {
  console.error = originalError;
  assert.ok(logged.some((line) => line.includes('db down')));
  console.log('host-hits tests passed');
}, 0);
