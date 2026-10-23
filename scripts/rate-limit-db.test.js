// Postgres rate limits and Turnstile. The counters live in rate_limits, so a
// second call sees the same window. Turnstile stays off unless both keys are
// set, and the Cloudflare script is not part of the HTML.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const pg = require('./test-postgres');

const LIMITED = 'Please wait a moment and try again.';
const LINK_SENT = "If that address can be used, we've sent a link.";
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function staticChecks() {
  const turnstile = require('../src/turnstile');
  const { landingHtml } = require('../src/landing');
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.ACCESS_REQUESTS_ENABLED;

  assert.deepStrictEqual(turnstile.turnstilePublicConfig(), { enabled: false });
  assert.strictEqual(turnstile.turnstileScriptUrl(), null);

  process.env.TURNSTILE_SECRET_KEY = 'only-secret';
  assert.strictEqual(turnstile.turnstileKeys().enabled, false);
  assert.strictEqual(turnstile.turnstileScriptUrl(), null);
  delete process.env.TURNSTILE_SECRET_KEY;

  process.env.TURNSTILE_SITE_KEY = 'only-site';
  assert.strictEqual(turnstile.turnstileKeys().enabled, false);
  assert.strictEqual(turnstile.turnstileScriptUrl(), null);
  delete process.env.TURNSTILE_SITE_KEY;

  process.env.TURNSTILE_SITE_KEY = 'site-key';
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  const pub = turnstile.turnstilePublicConfig();
  assert.deepStrictEqual(pub, { enabled: true, siteKey: 'site-key' });
  assert.ok(!JSON.stringify(pub).includes('secret-key'));
  assert.strictEqual(turnstile.turnstileScriptUrl(pub), turnstile.SCRIPT_URL);
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;

  const migrateSrc = read('src/db/migrate.js');
  const schema = read('src/db/schema.sql');
  assert.ok(migrateSrc.includes("{ version: '008', name: 'rate-limits', run: applyRateLimits }"));
  assert.ok(!schema.includes('idx_rate_limits_window_start'));
  assert.ok(!schema.includes('rate_limits'));

  const pages = [
    'public/login.html',
    'public/signup.html',
    'src/pages/owner.html',
    'src/pages/landing.html',
  ];
  for (const file of pages) {
    const html = read(file);
    assert.ok(!html.includes('challenges.cloudflare.com'), file);
    assert.ok(!/Pivitlab|PivitLab|PIVITLAB/.test(html), file);
  }
  assert.ok(read('public/login.html').includes('/turnstile-widget.js'));
  assert.ok(read('public/signup.html').includes('/turnstile-widget.js'));
  assert.ok(read('src/pages/owner.html').includes('/turnstile-widget.js'));

  const off = landingHtml();
  assert.ok(!off.includes('/turnstile-widget.js'));
  assert.ok(!off.includes('challenges.cloudflare.com'));
  process.env.ACCESS_REQUESTS_ENABLED = 'true';
  const on = landingHtml();
  assert.ok(on.includes('/turnstile-widget.js'));
  assert.ok(on.includes('id="turnstile-slot"'));
  assert.ok(!on.includes('challenges.cloudflare.com'));
  delete process.env.ACCESS_REQUESTS_ENABLED;

  const widget = read('public/turnstile-widget.js');
  const guard = widget.indexOf('data.enabled !== true');
  const script = widget.indexOf('challenges.cloudflare.com/turnstile/v0/api.js');
  assert.ok(guard > -1 && script > guard);
}

function request(server, method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = Object.assign({
      Origin: `http://127.0.0.1:${port}`,
      Host: `127.0.0.1:${port}`,
    }, extraHeaders || {});
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
          retry: res.headers['retry-after'],
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function forwarded(ip) {
  return { 'X-Forwarded-For': ip };
}

async function main() {
  staticChecks();

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('rate limit db tests skipped: postgres not reachable');
    console.log('rate limit tests passed');
    return;
  }
  const dbName = 'pivit_rate_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  process.env.ADMIN_API_KEY = 'rate-limit-admin-key';
  process.env.SESSION_SECRET = 'rate-limit-session-secret-32chars';
  process.env.ACCESS_REQUESTS_ENABLED = 'true';
  process.env.EVENT_RATE_LIMIT = '2';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.APP_ORIGIN;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { hit, LIMITED_MESSAGE, eventAllowed } = require('../src/rate-limit');
  const sessionMiddleware = require('../src/session');
  const { csrfMiddleware } = require('../src/csrf');
  const authRouter = require('../src/routes/auth');
  const accessRouter = require('../src/routes/access-requests');
  const eventsRouter = require('../src/routes/events');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(csrfMiddleware);
  app.use('/api/auth', authRouter);
  app.use('/api/access-requests', accessRouter);
  app.use('/api/event', eventsRouter);

  let server;
  const originalFetch = global.fetch;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('008'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    const index = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_rate_limits_window_start'`
    );
    assert.strictEqual(index.rows.length, 1);

    const windowMs = 60 * 1000;
    const start = Date.UTC(2026, 9, 12, 12, 0, 0);
    const first = await hit('unit:window', 1, windowMs, db, start);
    assert.strictEqual(first.ok, true);
    const blockedHit = await hit('unit:window', 1, windowMs, db, start + 1000);
    assert.strictEqual(blockedHit.ok, false);
    assert.ok(blockedHit.retryAfter >= 1);
    const reset = await hit('unit:window', 1, windowMs, db, start + windowMs);
    assert.strictEqual(reset.ok, true);
    assert.strictEqual(reset.hits, 1);

    const logs = [];
    const previousError = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    const open = await eventAllowed('203.0.113.50', {
      query() { throw new Error('db down'); },
    });
    console.error = previousError;
    assert.strictEqual(open, true);
    assert.ok(logs.some((line) => line.includes('rate limit check failed')));

    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const offConfig = await request(server, 'GET', '/api/auth/turnstile');
    assert.strictEqual(offConfig.status, 200);
    assert.deepStrictEqual(offConfig.json, { enabled: false });

    const emailed = await request(server, 'POST', '/api/auth/email', {
      email: 'ada@example.co.uk',
    }, forwarded('198.51.100.10'));
    assert.strictEqual(emailed.status, 200, emailed.text);
    assert.strictEqual(emailed.json.message, LINK_SENT);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await request(server, 'POST', '/api/auth/email', {
        email: 'limited@example.co.uk',
      }, forwarded('198.51.100.11'));
      assert.strictEqual(attempt.status, 200, attempt.text);
    }
    const limited = await request(server, 'POST', '/api/auth/email', {
      email: 'limited@example.co.uk',
    }, forwarded('198.51.100.11'));
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.json.error, LIMITED_MESSAGE);
    assert.ok(Number(limited.retry) >= 1);
    assert.ok(!/exist/i.test(limited.json.error));
    const stored = await db.query(
      `SELECT hits FROM rate_limits WHERE bucket = 'auth-email:limited@example.co.uk'`
    );
    assert.ok(stored.rows[0].hits > 5);

    await db.query(
      `UPDATE rate_limits
       SET window_start = window_start - interval '2 hours'
       WHERE bucket = 'auth-email:limited@example.co.uk'`
    );
    const afterWindow = await request(server, 'POST', '/api/auth/email', {
      email: 'limited@example.co.uk',
    }, forwarded('198.51.100.11'));
    assert.strictEqual(afterWindow.status, 200, afterWindow.text);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await request(server, 'POST', '/api/auth/signup', {
        email: 'invite@example.co.uk',
        website: 'invite.example',
        invite_code: 'pivit-not-real',
      }, forwarded('198.51.100.12'));
      assert.strictEqual(attempt.status, 400, attempt.text);
    }
    const inviteLimited = await request(server, 'POST', '/api/auth/signup', {
      email: 'invite@example.co.uk',
      website: 'invite.example',
      invite_code: 'pivit-not-real',
    }, forwarded('198.51.100.12'));
    assert.strictEqual(inviteLimited.status, 429);
    assert.strictEqual(inviteLimited.json.error, LIMITED);
    assert.ok(Number(inviteLimited.retry) >= 1);
    const inviteBucket = await db.query(
      `SELECT hits FROM rate_limits WHERE bucket = 'auth-invite:198.51.100.12'`
    );
    assert.ok(inviteBucket.rows[0].hits >= 5);

    const ownerOk = await request(server, 'POST', '/api/auth/login', {
      password: 'rate-limit-admin-key',
    }, forwarded('198.51.100.20'));
    assert.strictEqual(ownerOk.status, 200, ownerOk.text);

    for (let i = 0; i < 5; i += 1) {
      const wrong = await request(server, 'POST', '/api/auth/login', {
        password: 'nope',
      }, forwarded('198.51.100.21'));
      assert.strictEqual(wrong.status, 401);
      assert.strictEqual(wrong.json.error, 'incorrect password');
    }
    const ownerLocked = await request(server, 'POST', '/api/auth/login', {
      password: 'rate-limit-admin-key',
    }, forwarded('198.51.100.21'));
    assert.strictEqual(ownerLocked.status, 429);
    assert.strictEqual(ownerLocked.json.error, LIMITED);
    assert.ok(Number(ownerLocked.retry) >= 1);

    for (let i = 0; i < 5; i += 1) {
      const wrong = await request(server, 'POST', '/api/auth/client-login', {
        username: 'nobody',
        password: 'nope',
      }, forwarded('198.51.100.22'));
      assert.strictEqual(wrong.status, 401);
    }
    const clientLocked = await request(server, 'POST', '/api/auth/client-login', {
      username: 'nobody',
      password: 'nope',
    }, forwarded('198.51.100.22'));
    assert.strictEqual(clientLocked.status, 429);
    assert.strictEqual(clientLocked.json.error, LIMITED);
    assert.ok(Number(clientLocked.retry) >= 1);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await request(server, 'POST', '/api/access-requests', {
        name: 'Limited',
        email: 'access@example.co.uk',
        website: 'access.example',
      }, forwarded('198.51.100.30'));
      assert.strictEqual(attempt.status, 201, attempt.text);
    }
    const accessLimited = await request(server, 'POST', '/api/access-requests', {
      name: 'Limited',
      email: 'access@example.co.uk',
      website: 'access.example',
    }, forwarded('198.51.100.30'));
    assert.strictEqual(accessLimited.status, 429);
    assert.strictEqual(accessLimited.json.error, LIMITED);
    assert.ok(Number(accessLimited.retry) >= 1);

    const account = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, status, goals, goals_scope, goals_migrated, account_id)
       VALUES ('Snippet', 'https://example.co.uk/', 'running', $1::jsonb, 'shared', true, $2)
       RETURNING id`,
      [JSON.stringify([{ type: 'click', selector: '.buy', id: 'buy', name: 'Buy', primary: true }]), account.rows[0].id]
    );
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
      [exp.rows[0].id]
    );
    async function postEvent(visitorId, ip) {
      return request(server, 'POST', '/api/event', {
        experiment_id: exp.rows[0].id,
        variant_id: variant.rows[0].id,
        visitor_id: visitorId,
        event_type: 'view',
      }, Object.assign({ 'User-Agent': BROWSER }, forwarded(ip)));
    }
    async function eventCount() {
      const rows = await db.query(
        `SELECT COUNT(*)::int AS n FROM events WHERE experiment_id = $1`,
        [exp.rows[0].id]
      );
      return rows.rows[0].n;
    }

    // The cap is a fixed one-minute window. Wait out the tail so these posts
    // stay in the same window. Crossing a minute boundary would let the third
    // event through and fail the assertion below.
    const windowTail = 60 * 1000 - (Date.now() % (60 * 1000));
    if (windowTail < 5000) {
      await new Promise((resolve) => setTimeout(resolve, windowTail + 50));
    }

    const seen = await postEvent('v_normal', '198.51.100.40');
    assert.strictEqual(seen.status, 204);
    assert.strictEqual(seen.retry, undefined);
    assert.strictEqual(await eventCount(), 1);
    const second = await postEvent('v_normal_2', '198.51.100.40');
    assert.strictEqual(second.status, 204);
    assert.strictEqual(await eventCount(), 2);
    const flood = await postEvent('v_flood', '198.51.100.40');
    assert.strictEqual(flood.status, 204);
    assert.strictEqual(await eventCount(), 2);
    await db.query(
      `UPDATE rate_limits
       SET window_start = window_start - interval '2 minutes'
       WHERE bucket = 'event-ip:198.51.100.40'`
    );
    const after = await postEvent('v_after', '198.51.100.40');
    assert.strictEqual(after.status, 204);
    assert.strictEqual(await eventCount(), 3);

    let verifyCalls = 0;
    global.fetch = async () => {
      verifyCalls += 1;
      throw new Error('Turnstile should stay off');
    };
    const stillOff = await request(server, 'POST', '/api/auth/email', {
      email: 'off@example.co.uk',
    }, forwarded('198.51.100.50'));
    assert.strictEqual(stillOff.status, 200, stillOff.text);
    assert.strictEqual(verifyCalls, 0);

    process.env.TURNSTILE_SITE_KEY = 'site-only';
    const siteOnly = await request(server, 'POST', '/api/auth/email', {
      email: 'site-only@example.co.uk',
    }, forwarded('198.51.100.51'));
    assert.strictEqual(siteOnly.status, 200, siteOnly.text);
    process.env.TURNSTILE_SECRET_KEY = 'secret-only';
    delete process.env.TURNSTILE_SITE_KEY;
    const secretOnly = await request(server, 'POST', '/api/auth/email', {
      email: 'secret-only@example.co.uk',
    }, forwarded('198.51.100.52'));
    assert.strictEqual(secretOnly.status, 200, secretOnly.text);
    assert.strictEqual(verifyCalls, 0);

    process.env.TURNSTILE_SITE_KEY = 'site-key';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key';
    const missingToken = await request(server, 'POST', '/api/auth/email', {
      email: 'needs-token@example.co.uk',
    }, forwarded('198.51.100.53'));
    assert.strictEqual(missingToken.status, 400);
    assert.strictEqual(verifyCalls, 0);
    const onConfig = await request(server, 'GET', '/api/auth/turnstile');
    assert.deepStrictEqual(onConfig.json, { enabled: true, siteKey: 'site-key' });
    assert.ok(!onConfig.text.includes('secret-key'));

    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: String(options && options.body) });
      const token = String(options && options.body);
      const success = token.includes('response=good-token');
      return { ok: true, json: async () => ({ success }) };
    };
    const badToken = await request(server, 'POST', '/api/auth/signup', {
      email: 'bot@example.co.uk',
      website: 'bot.example',
      invite_code: 'pivit-not-real',
      turnstile_token: 'bad-token',
    }, forwarded('198.51.100.54'));
    assert.strictEqual(badToken.status, 400);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/turnstile/v0/siteverify'));
    assert.ok(calls[0].body.includes('secret=secret-key'));
    assert.ok(!badToken.text.includes('secret-key'));

    const goodToken = await request(server, 'POST', '/api/auth/email', {
      email: 'human@example.co.uk',
      turnstile_token: 'good-token',
    }, forwarded('198.51.100.55'));
    assert.strictEqual(goodToken.status, 200, goodToken.text);
    assert.strictEqual(goodToken.json.message, LINK_SENT);
    assert.strictEqual(calls.length, 2);

    const accessOn = await request(server, 'POST', '/api/access-requests', {
      name: 'Casey',
      email: 'casey-turnstile@example.co.uk',
      website: 'casey.example',
      turnstile_token: 'good-token',
    }, forwarded('198.51.100.56'));
    assert.strictEqual(accessOn.status, 201, accessOn.text);

    console.log('rate limit tests passed');
  } finally {
    global.fetch = originalFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.EVENT_RATE_LIMIT;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
