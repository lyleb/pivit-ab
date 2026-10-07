const assert = require('assert');
const http = require('http');
const express = require('express');
const { hstsMiddleware, hstsMaxAge, DEFAULT_MAX_AGE } = require('../src/hsts');

function run(mw, secure) {
  const headers = {};
  let called = false;
  mw({ secure }, { setHeader(name, value) { headers[name] = value; } }, () => { called = true; });
  assert.ok(called, 'middleware must call next()');
  return headers;
}

assert.strictEqual(DEFAULT_MAX_AGE, 15552000);
assert.strictEqual(hstsMaxAge({}), DEFAULT_MAX_AGE);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: '' }), DEFAULT_MAX_AGE);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: '31536000' }), 31536000);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: ' 86400 ' }), 86400);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: '0' }), 0);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: '-5' }), DEFAULT_MAX_AGE);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: 'abc' }), DEFAULT_MAX_AGE);
assert.strictEqual(hstsMaxAge({ HSTS_MAX_AGE: '1.5' }), DEFAULT_MAX_AGE);

// HTTPS request: header set, no includeSubDomains / preload.
const secure = run(hstsMiddleware({}), true);
assert.strictEqual(secure['Strict-Transport-Security'], 'max-age=15552000');

// Plain HTTP (local dev): no header.
const plain = run(hstsMiddleware({}), false);
assert.strictEqual(plain['Strict-Transport-Security'], undefined);

// Rollback value.
const off = run(hstsMiddleware({ HSTS_MAX_AGE: '0' }), true);
assert.strictEqual(off['Strict-Transport-Security'], 'max-age=0');

// Same rules through Express, which is what turns Railway's X-Forwarded-Proto
// into req.secure when trust proxy is set. No redirects.
function appWith(env) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(hstsMiddleware(env));
  const ok = (req, res) => res.type('text/plain').send('ok');
  app.get('/', ok);
  app.get('/snippet/ab.js', ok);
  app.get('/api/config', ok);
  app.get('/health', ok);
  return app;
}

function request(app, { path, proto }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const headers = {};
      if (proto) headers['X-Forwarded-Proto'] = proto;
      const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
        res.resume();
        res.on('end', () => {
          server.close(() => resolve({
            status: res.statusCode,
            location: res.headers.location,
            hsts: res.headers['strict-transport-security'],
          }));
        });
      });
      req.on('error', (err) => server.close(() => reject(err)));
    });
  });
}

(async () => {
  const paths = ['/', '/snippet/ab.js', '/api/config', '/health'];
  const httpsApp = appWith({});
  for (const path of paths) {
    const viaProxy = await request(httpsApp, { path, proto: 'https' });
    assert.strictEqual(viaProxy.status, 200, path);
    assert.strictEqual(viaProxy.location, undefined, path);
    assert.strictEqual(viaProxy.hsts, 'max-age=15552000', path);

    const plain = await request(httpsApp, { path });
    assert.strictEqual(plain.status, 200, path);
    assert.strictEqual(plain.location, undefined, path);
    assert.strictEqual(plain.hsts, undefined, path);
  }

  const disabled = appWith({ HSTS_MAX_AGE: '0' });
  const rolledBack = await request(disabled, { path: '/health', proto: 'https' });
  assert.strictEqual(rolledBack.status, 200);
  assert.strictEqual(rolledBack.hsts, 'max-age=0');

  console.log('hsts tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
