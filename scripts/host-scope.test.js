const assert = require('assert');
const scope = require('../src/host-scope');

function req({ url, origin, referer, referrer, hostname, host } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  if (referrer) headers.referrer = referrer;
  if (host) headers.host = host;
  return {
    hostname: hostname || '',
    query: url ? { url } : {},
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

assert.strictEqual(scope.normaliseHost('Example.COM'), 'example.com');
assert.strictEqual(scope.normaliseHost('  WWW.Example.COM:443. '), 'example.com');
assert.strictEqual(scope.normaliseHost('example.com:8080'), 'example.com');
assert.strictEqual(scope.normaliseHost('example.com.'), 'example.com');
assert.strictEqual(scope.normaliseHost('www.example.com.:443'), 'example.com');
assert.strictEqual(scope.normaliseHost('www.www.example.com'), 'www.example.com');
assert.strictEqual(scope.normaliseHost('shop.example.com'), 'shop.example.com');
assert.strictEqual(scope.normaliseHost(''), '');
assert.strictEqual(scope.normaliseHost(null), '');
assert.strictEqual(scope.normaliseHost('https://WWW.Example.com:444/pricing'), 'example.com');

assert.strictEqual(
  scope.pageHostFromRequest(req({
    url: 'https://www.Other.com:444/pricing',
    origin: 'https://shop.example.com',
    hostname: 'pivit.click',
    host: 'pivit.click',
  })),
  'other.com'
);
assert.strictEqual(
  scope.pageHostFromRequest(req({ origin: 'https://www.Shop.Example.com', hostname: 'pivit.click', host: 'pivit.click' })),
  'shop.example.com'
);
assert.strictEqual(
  scope.pageHostFromRequest(req({ referer: 'https://www.Refer.Example/path?x=1', hostname: 'pivit.click' })),
  'refer.example'
);
assert.strictEqual(
  scope.pageHostFromRequest(req({ referrer: 'https://fallback.example/a' })),
  'fallback.example'
);
assert.strictEqual(
  scope.pageHostFromRequest(req({ hostname: 'pivit.click', host: 'pivit.click' })),
  ''
);
assert.strictEqual(scope.pageHostFromRequest(req({ url: 'not a url', origin: 'https://example.com' })), 'example.com');

assert.strictEqual(
  scope.originHostFromRequest(req({
    url: 'https://evil.example/phish',
    origin: 'https://www.Example.com',
    referer: 'https://other.example/',
  })),
  'example.com'
);
assert.strictEqual(
  scope.originHostFromRequest(req({ url: 'https://evil.example/', referer: 'https://www.Ok.Example/thanks' })),
  'ok.example'
);
assert.strictEqual(scope.originHostFromRequest(req({ url: 'https://evil.example/', hostname: 'pivit.click' })), '');

const previousMode = process.env.HOST_SCOPING;
delete process.env.HOST_SCOPING;
assert.strictEqual(scope.hostScopingMode(), 'transition');
assert.deepStrictEqual(scope.checkHost([], 'example.com'), {
  serve: true, scoped: false, reason: 'unscoped-transition',
});
process.env.HOST_SCOPING = 'enforce';
assert.strictEqual(scope.hostScopingMode(), 'enforce');
assert.deepStrictEqual(scope.checkHost([], 'example.com'), {
  serve: false, scoped: false, reason: 'unscoped-enforce',
});
assert.deepStrictEqual(scope.checkHost([], 'example.com', 'transition'), {
  serve: true, scoped: false, reason: 'unscoped-transition',
});
assert.strictEqual(scope.hostScopingMode('nope'), 'transition');
process.env.HOST_SCOPING = 'ENFORCE';
assert.strictEqual(scope.hostScopingMode(), 'enforce');
if (previousMode === undefined) delete process.env.HOST_SCOPING;
else process.env.HOST_SCOPING = previousMode;

assert.deepStrictEqual(scope.checkHost(['example.com'], 'www.example.com', 'transition'), {
  serve: true, scoped: true, reason: 'allowed',
});
assert.deepStrictEqual(scope.checkHost(['WWW.Example.com:443'], 'example.com', 'enforce'), {
  serve: true, scoped: true, reason: 'allowed',
});
assert.deepStrictEqual(scope.checkHost(['example.com'], 'shop.example.com', 'transition'), {
  serve: false, scoped: true, reason: 'host-denied',
});
assert.deepStrictEqual(scope.checkHost(['example.com'], 'other.com', 'enforce'), {
  serve: false, scoped: true, reason: 'host-denied',
});
assert.deepStrictEqual(scope.checkHost(['example.com'], '', 'transition'), {
  serve: false, scoped: true, reason: 'host-unknown',
});
assert.deepStrictEqual(scope.checkHost(null, 'example.com', 'enforce'), {
  serve: false, scoped: false, reason: 'unscoped-enforce',
});

assert.deepStrictEqual(
  scope.parseHostList('https://www.Example.com/pricing, shop.example.com\nother.com'),
  { ok: true, hosts: ['example.com', 'shop.example.com', 'other.com'] }
);
assert.deepStrictEqual(scope.parseHostList(['WWW.Example.com', 'example.com']), {
  ok: true, hosts: ['example.com'],
});
assert.deepStrictEqual(scope.parseHostList('  ,  '), { ok: true, hosts: [] });
assert.deepStrictEqual(scope.parseHostList(null), { ok: true, hosts: [] });
assert.strictEqual(scope.parseHostList('not a host!!').ok, false);
assert.strictEqual(scope.parseHostList(12).ok, false);
assert.strictEqual(scope.parseHostList('example.com/about').hosts[0], 'example.com');

scope.clearSeen();
scope.recordSeen('exp-1', 'https://www.Example.com/a');
scope.recordSeen('exp-1', 'example.com');
scope.recordSeen('exp-1', 'shop.example.com');
scope.recordSeen('', 'example.com');
scope.recordSeen('exp-1', '');
let report = scope.seenReport();
assert.deepStrictEqual(report.experiments['exp-1'], [
  { host: 'example.com', count: 2 },
  { host: 'shop.example.com', count: 1 },
]);
assert.ok(report.since);

scope.clearSeen();
const many = [];
for (let i = 0; i < scope.MAX_SEEN_HOSTS + 1; i += 1) {
  const host = `h${i}.example.com`;
  many.push(host);
  scope.recordSeen('bounded', host);
}
const hosts = scope.seenReport().experiments.bounded.map((row) => row.host);
assert.strictEqual(hosts.length, scope.MAX_SEEN_HOSTS);
assert.ok(hosts.includes('h0.example.com'));
assert.ok(!hosts.includes(`h${scope.MAX_SEEN_HOSTS}.example.com`));

scope.clearSeen();
for (let i = 0; i < scope.MAX_SEEN_EXPERIMENTS + 1; i += 1) {
  scope.recordSeen(`exp-${i}`, 'example.com');
}
const ids = Object.keys(scope.seenReport().experiments);
assert.strictEqual(ids.length, scope.MAX_SEEN_EXPERIMENTS);
assert.ok(!ids.includes('exp-0'));
assert.ok(ids.includes(`exp-${scope.MAX_SEEN_EXPERIMENTS}`));
scope.clearSeen();

console.log('host-scope tests passed');
