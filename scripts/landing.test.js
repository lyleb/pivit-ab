// Landing page routing, the access-request flag, and the stored requests.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const pg = require('./test-postgres');
const { landingTarget, landingHtml, sendLandingPage } = require('../src/landing');
const { accessRequestsEnabled } = require('../src/access-flag');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function staticChecks() {
  const previous = process.env.ACCESS_REQUESTS_ENABLED;
  delete process.env.ACCESS_REQUESTS_ENABLED;
  assert.strictEqual(accessRequestsEnabled(), false);
  assert.strictEqual(landingTarget(null), null);
  assert.strictEqual(landingTarget({}), null);
  assert.strictEqual(landingTarget({ role: 'owner' }), '/index.html');
  assert.strictEqual(landingTarget({ role: 'owner', customer: true }), '/index.html');
  assert.strictEqual(landingTarget({ role: 'client' }), '/client.html');

  const off = landingHtml();
  assert.ok(off.includes('Request access: <a href="mailto:info@pivitlab.com">email info@pivitlab.com</a>'));
  assert.ok(!off.includes('id="req-form"'));
  assert.ok(off.includes('A/B testing without the enterprise baggage'));
  assert.ok(!/Pivitlab|PivitLab|PIVITLAB/.test(off.replace(/pivitlab-logo|og-pivitlab|pivitlab-icon/g, '')));

  process.env.ACCESS_REQUESTS_ENABLED = 'true';
  assert.strictEqual(accessRequestsEnabled(), true);
  const on = landingHtml();
  assert.ok(on.includes('id="req-form"'));
  assert.ok(on.includes('name="pivit_hp"'));
  assert.ok(on.includes('href="/privacy.html"'));
  assert.ok(!on.includes('Request access: <a href="mailto:info@pivitlab.com">email info@pivitlab.com</a>'));
  process.env.ACCESS_REQUESTS_ENABLED = 'yes';
  assert.strictEqual(accessRequestsEnabled(), true);
  process.env.ACCESS_REQUESTS_ENABLED = 'off';
  assert.strictEqual(accessRequestsEnabled(), false);

  if (previous === undefined) delete process.env.ACCESS_REQUESTS_ENABLED;
  else process.env.ACCESS_REQUESTS_ENABLED = previous;

  const dashboard = read('public/index.html');
  assert.ok(dashboard.includes('id="invite-card"'));
  assert.ok(dashboard.includes('id="access-requests-body"'));
  assert.ok(dashboard.includes('>Create invite code</button>'));
  assert.ok(dashboard.includes('data-access-invite'));
  assert.ok(dashboard.includes('<link rel="canonical" href="https://pivitlab.com/index.html">'));
  assert.ok(dashboard.includes('noindex, nofollow'));
  assert.ok(!dashboard.includes('ADMIN_API_KEY'));

  const sessionSrc = read('src/session.js');
  assert.ok(sessionSrc.includes("name: 'pivit.sid'"));
  const snippet = read('snippet/ab.js');
  assert.ok(snippet.includes('function'));
}

function request(server, method, urlPath, body, jar, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = Object.assign({
      Host: `127.0.0.1:${port}`,
    }, extraHeaders || {});
    if (jar && Object.keys(jar).length) {
      headers.Cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = res.headers['set-cookie'] || [];
        const lines = Array.isArray(raw) ? raw : [raw];
        for (const line of lines) {
          if (!line || !jar) continue;
          const pair = line.split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && String(res.headers['content-type'] || '').includes('json')) json = JSON.parse(text);
        resolve({
          status: res.statusCode,
          text,
          json,
          location: res.headers.location,
          robots: res.headers['x-robots-tag'],
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function redirectChecks() {
  const app = express();
  app.use(session({
    secret: 'landing-redirect-secret-landing-redirect',
    resave: false,
    saveUninitialized: false,
    name: 'pivit.sid',
  }));
  app.post('/__session', express.json(), (req, res) => {
    req.session.role = req.body && req.body.role;
    req.session.customer = req.body && req.body.customer === true;
    req.session.save(() => res.json({ ok: true }));
  });
  app.get('/', sendLandingPage);
  const server = await listen(app);
  try {
    const anon = await request(server, 'GET', '/');
    assert.strictEqual(anon.status, 200);
    assert.ok(anon.text.includes('A/B testing without the enterprise baggage'));
    assert.strictEqual(anon.robots, undefined);

    const ownerJar = {};
    const setOwner = await request(server, 'POST', '/__session', { role: 'owner', customer: true }, ownerJar);
    assert.strictEqual(setOwner.status, 200);
    const owner = await request(server, 'GET', '/', null, ownerJar);
    assert.strictEqual(owner.status, 302);
    assert.strictEqual(owner.location, '/index.html');

    const clientJar = {};
    await request(server, 'POST', '/__session', { role: 'client' }, clientJar);
    const client = await request(server, 'GET', '/', null, clientJar);
    assert.strictEqual(client.status, 302);
    assert.strictEqual(client.location, '/client.html');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function dbChecks() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('landing db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_landing_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  process.env.ADMIN_API_KEY = 'landing-admin-key-value';
  process.env.SESSION_SECRET = 'landing-session-secret-value-32chars';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  delete process.env.ACCESS_REQUEST_EMAIL;
  delete process.env.APP_ORIGIN;
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.ACCESS_REQUESTS_ENABLED = 'true';

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyAccessRequests } = require('../src/db/access-requests');
  const { takeLastLoggedEmail } = require('../src/mailer');
  const { csrfMiddleware } = require('../src/csrf');
  const sessionMiddleware = require('../src/session');
  const accessRouter = require('../src/routes/access-requests');
  const authRouter = require('../src/routes/auth');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(csrfMiddleware);
  app.get('/', sendLandingPage);
  app.use('/api/auth', authRouter);
  app.use('/api/access-requests', accessRouter);
  app.use('/api/access-requests', accessRouter.adminRouter);

  let server;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('003'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    takeLastLoggedEmail();
    server = await listen(app);
    const origin = { Origin: `http://127.0.0.1:${server.address().port}` };

    process.env.ACCESS_REQUESTS_ENABLED = '';
    const closed = await request(server, 'POST', '/api/access-requests', {
      name: 'Sam Taylor',
      email: 'sam@example.co.uk',
      website: 'example.co.uk',
    }, {}, origin);
    assert.strictEqual(closed.status, 404);
    const closedCount = await db.query('SELECT COUNT(*)::int AS n FROM access_requests');
    assert.strictEqual(closedCount.rows[0].n, 0);
    const closedPage = await request(server, 'GET', '/');
    assert.ok(closedPage.text.includes('email info@pivitlab.com'));
    assert.ok(!closedPage.text.includes('id="req-form"'));

    process.env.ACCESS_REQUESTS_ENABLED = 'true';
    const openPage = await request(server, 'GET', '/');
    assert.ok(openPage.text.includes('id="req-form"'));
    assert.ok(openPage.text.includes('name="pivit_hp"'));
    assert.ok(!openPage.text.includes('Request access: <a href="mailto:info@pivitlab.com">email info@pivitlab.com</a>'));

    const noOrigin = await request(server, 'POST', '/api/access-requests', {
      name: 'Sam Taylor',
      email: 'sam@example.co.uk',
      website: 'example.co.uk',
    });
    assert.strictEqual(noOrigin.status, 403);

    const bad = await request(server, 'POST', '/api/access-requests', {
      name: 'Sam',
      email: 'not-an-email',
      website: 'example.co.uk',
    }, {}, origin);
    assert.strictEqual(bad.status, 400);

    const bot = await request(server, 'POST', '/api/access-requests', {
      name: 'Bot',
      email: 'bot@example.co.uk',
      website: 'example.co.uk',
      pivit_hp: 'filled',
    }, {}, origin);
    assert.strictEqual(bot.status, 201);
    assert.deepStrictEqual(bot.json, { ok: true });
    assert.strictEqual(takeLastLoggedEmail(), null);
    const afterBot = await db.query('SELECT COUNT(*)::int AS n FROM access_requests');
    assert.strictEqual(afterBot.rows[0].n, 0);

    const created = await request(server, 'POST', '/api/access-requests', {
      name: 'Sam Taylor',
      email: 'Sam@Example.co.uk',
      website: 'https://www.Example.co.uk/pricing',
    }, {}, origin);
    assert.strictEqual(created.status, 201, created.text);
    const mailed = takeLastLoggedEmail();
    assert.ok(mailed);
    assert.strictEqual(mailed.to, 'info@heclr.com');
    assert.strictEqual(mailed.subject, 'New pivitlab access request');
    assert.ok(mailed.text.includes('Sam Taylor'));
    assert.ok(mailed.text.includes('sam@example.co.uk'));
    assert.ok(mailed.text.includes('https://example.co.uk'));
    const row = await db.query('SELECT name, email, website, invite_id FROM access_requests');
    assert.strictEqual(row.rows.length, 1);
    assert.strictEqual(row.rows[0].email, 'sam@example.co.uk');
    assert.strictEqual(row.rows[0].website, 'example.co.uk');
    assert.strictEqual(row.rows[0].invite_id, null);

    process.env.ACCESS_REQUEST_EMAIL = 'lyle@example.com';
    const second = await request(server, 'POST', '/api/access-requests', {
      name: 'Alex Kim',
      email: 'alex@shop.example',
      website: 'shop.example',
    }, {}, Object.assign({ 'X-Forwarded-For': '203.0.113.9' }, origin));
    assert.strictEqual(second.status, 201, second.text);
    const custom = takeLastLoggedEmail();
    assert.strictEqual(custom.to, 'lyle@example.com');
    delete process.env.ACCESS_REQUEST_EMAIL;

    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const blocked = await request(server, 'POST', '/api/access-requests', {
      name: 'Casey',
      email: 'casey@example.co.uk',
      website: 'casey.example',
    }, {}, Object.assign({ 'X-Forwarded-For': '203.0.113.10' }, origin));
    assert.strictEqual(blocked.status, 400);
    delete process.env.TURNSTILE_SECRET_KEY;
    const stillTwo = await db.query('SELECT COUNT(*)::int AS n FROM access_requests');
    assert.strictEqual(stillTwo.rows[0].n, 2);

    await db.query(`DELETE FROM rate_limits WHERE bucket LIKE 'access-%'`);
    for (let i = 0; i < 5; i += 1) {
      const attempt = await request(server, 'POST', '/api/access-requests', {
        name: 'Limited',
        email: 'limited@example.co.uk',
        website: 'limited.example',
      }, {}, Object.assign({ 'X-Forwarded-For': '203.0.113.20' }, origin));
      assert.strictEqual(attempt.status, 201, attempt.text);
      takeLastLoggedEmail();
    }
    const limited = await request(server, 'POST', '/api/access-requests', {
      name: 'Limited',
      email: 'limited@example.co.uk',
      website: 'limited.example',
    }, {}, Object.assign({ 'X-Forwarded-For': '203.0.113.20' }, origin));
    assert.strictEqual(limited.status, 429);

    const anonList = await request(server, 'GET', '/api/access-requests', null, {}, origin);
    assert.strictEqual(anonList.status, 404);

    const owner = {};
    const login = await request(server, 'POST', '/api/auth/login', {
      password: 'landing-admin-key-value',
    }, owner, origin);
    assert.strictEqual(login.status, 200, login.text);
    const home = await request(server, 'GET', '/', null, owner);
    assert.strictEqual(home.status, 302);
    assert.strictEqual(home.location, '/index.html');

    const list = await request(server, 'GET', '/api/access-requests', null, owner, origin);
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.json.enabled, true);
    const sam = list.json.requests.find((item) => item.email === 'sam@example.co.uk');
    assert.ok(sam);
    assert.strictEqual(sam.invite_id, null);

    const invite = await request(server, 'POST', `/api/access-requests/${sam.id}/invite`, {}, owner, origin);
    assert.strictEqual(invite.status, 201, invite.text);
    assert.ok(invite.json.code.startsWith('pivit-'));
    assert.ok(invite.json.invite.note.includes('sam@example.co.uk'));
    assert.ok(invite.json.invite.note.includes('example.co.uk'));

    const againInvite = await request(server, 'POST', `/api/access-requests/${sam.id}/invite`, {}, owner, origin);
    assert.strictEqual(againInvite.status, 200, againInvite.text);
    assert.strictEqual(againInvite.json.already, true);
    assert.strictEqual(againInvite.json.code, undefined);
    const codes = await db.query(
      `SELECT COUNT(*)::int AS n FROM invite_codes WHERE note LIKE '%sam@example.co.uk%'`
    );
    assert.strictEqual(codes.rows[0].n, 1);

    const missing = await request(server, 'POST', '/api/access-requests/not-a-uuid/invite', {}, owner, origin);
    assert.strictEqual(missing.status, 404);

    const client = await db.pool.connect();
    try {
      const before = await db.query('SELECT COUNT(*)::int AS n FROM access_requests');
      await applyAccessRequests(client);
      await applyAccessRequests(client);
      const after = await db.query('SELECT COUNT(*)::int AS n FROM access_requests');
      assert.strictEqual(after.rows[0].n, before.rows[0].n);
    } finally {
      client.release();
    }
    console.log('landing db tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

async function main() {
  staticChecks();
  await redirectChecks();
  await dbChecks();
  console.log('landing tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
