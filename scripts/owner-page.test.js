// The public sign-in page does not advertise the owner password. /owner is
// unlisted, noindexed, left out of robots.txt, and rate-limited. POST
// /api/auth/login keeps its existing behaviour.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const pg = require('./test-postgres');
const { ROBOTS_TXT } = require('../src/robots');

const publicDir = path.join(__dirname, '../public');
for (const file of fs.readdirSync(publicDir)) {
  if (!file.endsWith('.html')) continue;
  const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(!html.includes('href="/owner"'), file);
  assert.ok(!html.includes('Owner password'), file);
  assert.ok(!html.includes('Owner login'), file);
}

const login = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
assert.ok(login.includes('Email me a sign-in link'));
assert.ok(login.includes('Client login'));
assert.ok(login.includes('Got an invite code from pivitlab?'));
assert.ok(login.includes('/api/auth/client-login'));
assert.ok(!login.includes('/api/auth/login'));

const ownerHtml = fs.readFileSync(path.join(__dirname, '../src/pages/owner.html'), 'utf8');
assert.ok(ownerHtml.includes('noindex, nofollow'));
assert.ok(ownerHtml.includes("fetch('/api/auth/login'"));
assert.ok(ROBOTS_TXT.includes('Disallow: /owner'));
assert.ok(!ROBOTS_TXT.split('\n').includes('Disallow: /'));

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && String(res.headers['content-type'] || '').includes('json')) json = JSON.parse(text);
        resolve({
          status: res.statusCode,
          text,
          json,
          robots: res.headers['x-robots-tag'],
          retry: res.headers['retry-after'],
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('owner page db tests skipped: postgres not reachable');
    console.log('owner page tests passed');
    return;
  }
  const dbName = 'pivit_owner_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_API_KEY = 'owner-page-test-key';
  process.env.SESSION_SECRET = 'owner-page-session-secret-32chars';
  process.env.OWNER_PAGE_LIMIT = '2';
  delete process.env.APP_ORIGIN;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const sessionMiddleware = require('../src/session');
  const { sendOwnerPage } = require('../src/owner-page');
  const authRouter = require('../src/routes/auth');
  const { robotsTagMiddleware, sendRobotsTxt } = require('../src/robots');

  let server;
  try {
    await migrate();
    const app = express();
    app.use(robotsTagMiddleware);
    app.use(express.json());
    app.use(sessionMiddleware);
    app.get('/owner', sendOwnerPage);
    app.get('/robots.txt', sendRobotsTxt);
    app.use('/api/auth', authRouter);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const first = await request(server, 'GET', '/owner');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.robots, 'noindex, nofollow');
    assert.ok(first.text.includes('noindex, nofollow'));
    assert.ok(first.text.includes('/api/auth/login'));
    assert.ok(!first.text.includes('ADMIN_API_KEY'));

    const second = await request(server, 'GET', '/owner');
    assert.strictEqual(second.status, 200);
    const limited = await request(server, 'GET', '/owner');
    assert.strictEqual(limited.status, 429);
    assert.ok(Number(limited.retry) > 0);

    const robots = await request(server, 'GET', '/robots.txt');
    assert.ok(robots.text.includes('Disallow: /owner'));

    const wrong = await request(server, 'POST', '/api/auth/login', { password: 'nope' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.json.error, 'incorrect password');

    const right = await request(server, 'POST', '/api/auth/login', { password: 'owner-page-test-key' });
    assert.strictEqual(right.status, 200);
    assert.strictEqual(right.json.role, 'owner');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('owner page tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
