const assert = require('assert');
const http = require('http');
const express = require('express');
const { originAllowed, csrfMiddleware } = require('../src/csrf');

function request(port, method, path, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port,
      method,
      path,
      headers: origin ? { Origin: origin, Host: `127.0.0.1:${port}` } : { Host: `127.0.0.1:${port}` },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

delete process.env.APP_ORIGIN;

assert.strictEqual(originAllowed({ method: 'GET', path: '/api/auth/signup', headers: {} }), true);
assert.strictEqual(originAllowed({
  method: 'POST',
  path: '/api/event',
  headers: { origin: 'https://shop.example' },
  get(name) { return this.headers[name]; },
  protocol: 'https',
}), true);
assert.strictEqual(originAllowed({
  method: 'PATCH',
  path: '/api/editor/variants/abc',
  headers: { origin: 'https://shop.example' },
  get(name) { return this.headers[name]; },
  protocol: 'https',
}), true);
assert.strictEqual(originAllowed({
  method: 'POST',
  path: '/api/auth/login',
  headers: {},
  get() { return ''; },
  protocol: 'http',
}), false);
assert.strictEqual(originAllowed({
  method: 'POST',
  path: '/api/auth/signup',
  headers: { host: 'pivitlab.com', origin: 'https://evil.example' },
  get(name) { return this.headers[name]; },
  protocol: 'https',
}), false);
assert.strictEqual(originAllowed({
  method: 'POST',
  path: '/api/auth/signup',
  headers: { host: 'pivitlab.com', origin: 'https://pivitlab.com' },
  get(name) { return this.headers[name]; },
  protocol: 'https',
}), true);

(async () => {
  const app = express();
  app.use(csrfMiddleware);
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  app.post('/api/event', (req, res) => res.status(204).end());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    assert.strictEqual(await request(port, 'POST', '/api/auth/login'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', 'https://evil.example'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', `http://127.0.0.1:${port}`), 200);
    assert.strictEqual(await request(port, 'POST', '/api/event', 'https://shop.example'), 204);
    console.log('csrf tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
