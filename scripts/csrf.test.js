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

const savedNodeEnv = process.env.NODE_ENV;
const savedAppOrigin = process.env.APP_ORIGIN;
const savedAppOrigins = process.env.APP_ORIGINS;

function fakeReq(method, path, headers, protocol) {
  return {
    method,
    path,
    headers,
    protocol: protocol || 'https',
    get(name) { return this.headers[name]; },
  };
}

process.env.NODE_ENV = 'production';
delete process.env.APP_ORIGIN;
delete process.env.APP_ORIGINS;

assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivit-ab.up.railway.app',
  origin: 'https://evil.example',
})), false);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivit-ab.up.railway.app',
  origin: 'https://pivit-ab.up.railway.app',
})), false);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivit.click',
  origin: 'https://pivit.click',
})), false);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivitlab.com',
  origin: 'https://pivitlab.com',
})), true);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivitlab.com',
  referer: 'https://pivitlab.com/owner',
})), true);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivitlab.com',
  origin: 'null',
  referer: 'https://pivitlab.com/owner',
})), false);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/auth/login', {
  host: 'pivitlab.com',
  origin: 'https://evil.example',
  referer: 'https://pivitlab.com/owner',
})), false);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/event', {
  origin: 'https://cantsaythat.co.uk',
})), true);

process.env.APP_ORIGIN = 'https://preview.example';
process.env.APP_ORIGINS = 'https://extra.example, not a url';
assert.strictEqual(originAllowed(fakeReq('POST', '/api/experiments', {
  host: '127.0.0.1:3000',
  origin: 'https://preview.example',
})), true);
assert.strictEqual(originAllowed(fakeReq('PATCH', '/api/experiments/1', {
  origin: 'https://extra.example',
})), true);
assert.strictEqual(originAllowed(fakeReq('POST', '/api/experiments', {
  origin: 'https://evil.example',
})), false);

delete process.env.APP_ORIGIN;
delete process.env.APP_ORIGINS;
process.env.NODE_ENV = 'test';

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
  app.post('/api/experiments', (req, res) => res.status(201).json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    process.env.NODE_ENV = 'test';
    delete process.env.APP_ORIGIN;
    delete process.env.APP_ORIGINS;
    assert.strictEqual(await request(port, 'POST', '/api/auth/login'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', 'https://evil.example'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', `http://127.0.0.1:${port}`), 200);
    assert.strictEqual(await request(port, 'POST', '/api/event', 'https://cantsaythat.co.uk'), 204);

    process.env.NODE_ENV = 'production';
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', 'https://evil.example'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', `http://127.0.0.1:${port}`), 403);
    assert.strictEqual(await request(port, 'POST', '/api/experiments', 'https://pivit.click'), 403);
    assert.strictEqual(await request(port, 'POST', '/api/auth/login', 'https://pivitlab.com'), 200);
    assert.strictEqual(await request(port, 'POST', '/api/event', 'https://cantsaythat.co.uk'), 204);
    process.env.APP_ORIGIN = 'https://preview.example';
    assert.strictEqual(await request(port, 'POST', '/api/experiments', 'https://preview.example'), 201);
    assert.strictEqual(await request(port, 'POST', '/api/experiments', 'https://evil.example'), 403);
    console.log('csrf tests passed');
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
    if (savedAppOrigins === undefined) delete process.env.APP_ORIGINS;
    else process.env.APP_ORIGINS = savedAppOrigins;
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
