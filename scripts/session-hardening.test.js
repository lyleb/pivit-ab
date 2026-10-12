// Session idle and absolute expiry, sign-out everywhere, view-as rotation,
// emergency-key revocation, and the production cookie name. CSRF cross-origin
// cases live in scripts/csrf.test.js.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

process.env.NODE_ENV = 'test';

const {
  ACTIVE_COOKIE_NAME,
  sessionCookieName,
} = require('../src/session-cookie');
const {
  CUSTOMER_SESSION_MS,
  CUSTOMER_ABSOLUTE_MS,
  SUPERADMIN_SESSION_MS,
  emergencyKeyId,
  sessionExpiryReason,
} = require('../src/session-lifetime');
const pg = require('./test-postgres');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function unitChecks() {
  const schema = read('src/db/schema.sql');
  const migration = read('src/db/sessions.js');
  const migrateSrc = read('src/db/migrate.js');
  assert.ok(!schema.includes('session_user_id_idx'), 'session indexes stay out of schema.sql');
  assert.ok(migrateSrc.includes("{ version: '007', name: 'sessions', run: applySessions }"));
  assert.ok(!/\bDROP\b/i.test(migration));
  assert.ok(!/\bDELETE\b/i.test(migration));
  assert.ok(!/\bUPDATE\b/i.test(migration));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS "session"'));
  assert.ok(migration.includes('session_client_id_idx'));

  const dashboard = read('public/index.html');
  const portal = read('public/client.html');
  assert.ok(dashboard.includes('>Sign out everywhere</button>'));
  assert.ok(dashboard.includes('/api/auth/logout-all'));
  assert.ok(portal.includes('id="logout-all-btn"'));
  assert.ok(portal.includes('>Sign out everywhere</button>'));
  assert.ok(portal.includes('/api/auth/logout-all'));

  assert.strictEqual(ACTIVE_COOKIE_NAME, 'pivit.sid');
  process.env.NODE_ENV = 'production';
  assert.strictEqual(sessionCookieName(), '__Host-pivit.sid');
  process.env.NODE_ENV = 'test';
  assert.strictEqual(sessionCookieName(), 'pivit.sid');

  const sessionSrc = read('src/session.js');
  assert.ok(sessionSrc.includes('httpOnly: true'));
  assert.ok(sessionSrc.includes("sameSite: 'lax'"));
  assert.ok(sessionSrc.includes("path: '/'"));
  assert.ok(sessionSrc.includes('secure: sessionCookieSecure()'));

  const now = Date.now();
  const idle = {
    role: 'client',
    customer: true,
    signedInAt: now - CUSTOMER_SESSION_MS - 5000,
    lastSeenAt: now - CUSTOMER_SESSION_MS - 1000,
    absoluteExpiresAt: now + CUSTOMER_ABSOLUTE_MS,
  };
  assert.strictEqual(sessionExpiryReason(idle, now), 'idle');

  const absolute = {
    role: 'client',
    customer: true,
    signedInAt: now - CUSTOMER_ABSOLUTE_MS - 1000,
    lastSeenAt: now,
    absoluteExpiresAt: now - 1000,
  };
  assert.strictEqual(sessionExpiryReason(absolute, now), 'absolute');

  const rolling = {
    role: 'owner',
    customer: true,
    signedInAt: now - (2 * 24 * 60 * 60 * 1000),
    lastSeenAt: now - (2 * 24 * 60 * 60 * 1000),
    absoluteExpiresAt: now + (2 * 60 * 60 * 1000),
    cookie: {},
  };
  assert.strictEqual(sessionExpiryReason(rolling, now), null);
  assert.strictEqual(rolling.lastSeenAt, now);
  assert.ok(rolling.cookie.maxAge <= 2 * 60 * 60 * 1000);
  assert.ok(rolling.cookie.maxAge > 60 * 60 * 1000);

  const start = now - (60 * 60 * 1000);
  const admin = {
    role: 'owner',
    customer: false,
    superadmin: true,
    emergency: true,
    signedInAt: start,
    lastSeenAt: start,
    absoluteExpiresAt: start + SUPERADMIN_SESSION_MS,
  };
  process.env.ADMIN_API_KEY = 'unit-emergency-key';
  admin.emergencyKeyId = emergencyKeyId();
  assert.strictEqual(sessionExpiryReason(admin, now), null);
  assert.strictEqual(admin.lastSeenAt, start);
  assert.strictEqual(admin.absoluteExpiresAt, start + SUPERADMIN_SESSION_MS);
  process.env.ADMIN_API_KEY = 'unit-emergency-key-rotated';
  assert.strictEqual(sessionExpiryReason(admin, now), 'emergency-key');

  const kept = {
    role: 'owner',
    customer: true,
    emergency: false,
    signedInAt: now,
    lastSeenAt: now,
    absoluteExpiresAt: now + CUSTOMER_ABSOLUTE_MS,
  };
  assert.strictEqual(sessionExpiryReason(kept, now), null);
}

function request(server, method, urlPath, body, jar, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = Object.assign({
      Origin: `http://127.0.0.1:${port}`,
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
        let maxAge = null;
        for (const line of lines) {
          if (!line) continue;
          const pair = line.split(';')[0];
          const eq = pair.indexOf('=');
          if (jar && eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
          const age = /Max-Age=(\d+)/i.exec(line);
          if (age) maxAge = Number(age[1]);
          const expires = /Expires=([^;]+)/i.exec(line);
          if (expires && maxAge == null) {
            maxAge = Math.round((Date.parse(expires[1]) - Date.now()) / 1000);
          }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && String(res.headers['content-type'] || '').includes('json')) json = JSON.parse(text);
        resolve({ status: res.statusCode, text, json, maxAge, cookies: lines.filter(Boolean) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sidFromCookie(value) {
  let raw = value;
  try { raw = decodeURIComponent(value); } catch (err) { raw = value; }
  const body = raw.startsWith('s:') ? raw.slice(2) : raw;
  const dot = body.indexOf('.');
  return dot === -1 ? body : body.slice(0, dot);
}

async function loadSess(db, jar) {
  const sid = sidFromCookie(jar['pivit.sid']);
  const { rows } = await db.query('SELECT sess FROM "session" WHERE sid = $1', [sid]);
  assert.ok(rows[0], 'session row missing for ' + sid);
  return { sid, sess: rows[0].sess };
}

async function saveSess(db, sid, sess) {
  await db.query(
    `UPDATE "session" SET sess = $2::json, expire = now() + interval '40 days' WHERE sid = $1`,
    [sid, JSON.stringify(sess)]
  );
}

function linkToken(message) {
  const link = message.text.match(/https?:\/\/\S+/)[0];
  return new URL(link).searchParams.get('token');
}

async function main() {
  unitChecks();
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('session hardening db tests skipped: postgres not reachable');
    console.log('session hardening tests passed');
    return;
  }
  const dbName = 'pivit_session_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_API_KEY = 'session-admin-key-value';
  process.env.SESSION_SECRET = 'session-hardening-secret-value-32';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.APP_ORIGIN;
  delete process.env.APP_ORIGINS;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { takeLastLoggedEmail } = require('../src/mailer');
  const sessionMiddleware = require('../src/session');
  const { sessionLifetime } = require('../src/session-lifetime');
  const { csrfMiddleware } = require('../src/csrf');

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(sessionLifetime);
  app.use(csrfMiddleware);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/clients', require('../src/routes/clients'));

  let server;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('007'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    const indexes = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'session' ORDER BY indexname`
    );
    const names = indexes.rows.map((row) => row.indexname);
    assert.ok(names.includes('session_user_id_idx'));
    assert.ok(names.includes('session_client_id_idx'));

    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const blocked = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-value',
    }, {}, { Origin: 'https://evil.example' });
    assert.strictEqual(blocked.status, 403);

    takeLastLoggedEmail();
    const asked = await request(server, 'POST', '/api/auth/email', { email: 'info@heclr.com' }, {});
    assert.strictEqual(asked.status, 200);
    const magic = {};
    const signed = await request(server, 'POST', '/api/auth/magic', {
      token: linkToken(takeLastLoggedEmail()),
    }, magic);
    assert.strictEqual(signed.status, 200);
    assert.deepStrictEqual(signed.json, { role: 'owner' });
    assert.ok(signed.cookies.some((line) => line.startsWith('pivit.sid=')));
    assert.ok(/HttpOnly/i.test(signed.cookies[0]));
    assert.ok(/SameSite=Lax/i.test(signed.cookies[0]));
    assert.ok(!/Domain=/i.test(signed.cookies[0]));
    assert.ok(Math.abs(signed.maxAge - (12 * 60 * 60)) < 5, `superadmin max-age ${signed.maxAge}`);
    const magicRow = await loadSess(db, magic);
    assert.ok(magicRow.sess.absoluteExpiresAt - magicRow.sess.signedInAt === SUPERADMIN_SESSION_MS
      || Math.abs((magicRow.sess.absoluteExpiresAt - magicRow.sess.signedInAt) - SUPERADMIN_SESSION_MS) < 50);

    const owner = {};
    const login = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-value',
    }, owner);
    assert.strictEqual(login.status, 200);
    assert.deepStrictEqual(login.json, { role: 'owner' });
    const ownerSid = sidFromCookie(owner['pivit.sid']);

    const created = await request(server, 'POST', '/api/clients', {
      name: 'Ada',
      username: 'ada',
      password: 'correct-horse',
    }, owner);
    assert.strictEqual(created.status, 201, created.text);
    const clientId = created.json.id;

    const viewerA = {};
    const viewerB = {};
    const firstLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, viewerA);
    assert.strictEqual(firstLogin.status, 200);
    assert.ok(Math.abs(firstLogin.maxAge - (30 * 24 * 60 * 60)) < 5, `client max-age ${firstLogin.maxAge}`);
    const secondLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, viewerB);
    assert.strictEqual(secondLogin.status, 200);
    assert.notStrictEqual(viewerA['pivit.sid'], viewerB['pivit.sid']);
    const signins = await db.query(
      `SELECT action FROM audit_log WHERE action = 'signin' AND target_id = $1`,
      [String(clientId)]
    );
    assert.ok(signins.rows.length >= 2);

    const clientRow = await loadSess(db, viewerA);
    const span = clientRow.sess.absoluteExpiresAt - clientRow.sess.signedInAt;
    assert.ok(Math.abs(span - CUSTOMER_ABSOLUTE_MS) < 50, `absolute span ${span}`);

    clientRow.sess.lastSeenAt = Date.now() - CUSTOMER_SESSION_MS - 1000;
    await saveSess(db, clientRow.sid, clientRow.sess);
    const idled = await request(server, 'GET', '/api/auth/me', null, viewerA);
    assert.strictEqual(idled.json.role, null);

    const fresh = {};
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, fresh);
    const absoluteRow = await loadSess(db, fresh);
    absoluteRow.sess.absoluteExpiresAt = Date.now() - 1000;
    absoluteRow.sess.lastSeenAt = Date.now();
    await saveSess(db, absoluteRow.sid, absoluteRow.sess);
    const ended = await request(server, 'GET', '/api/auth/me', null, fresh);
    assert.strictEqual(ended.json.role, null);

    const rollingJar = {};
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, rollingJar);
    const before = await loadSess(db, rollingJar);
    before.sess.lastSeenAt = Date.now() - (24 * 60 * 60 * 1000);
    await saveSess(db, before.sid, before.sess);
    const still = await request(server, 'GET', '/api/auth/me', null, rollingJar);
    assert.strictEqual(still.json.role, 'client');
    const after = await loadSess(db, rollingJar);
    assert.ok(Date.now() - after.sess.lastSeenAt < 15000, 'idle window was not renewed');
    assert.strictEqual(after.sess.absoluteExpiresAt, before.sess.absoluteExpiresAt);

    const other = await db.query(`INSERT INTO accounts (name, legacy) VALUES ('Other Ltd', false) RETURNING id`);
    const viewSidBefore = sidFromCookie(magic['pivit.sid']);
    const started = await request(server, 'POST', '/api/auth/view-as', {
      account_id: other.rows[0].id,
    }, magic);
    assert.strictEqual(started.status, 200, started.text);
    assert.strictEqual(started.json.view_as.name, 'Other Ltd');
    const viewSidAfter = sidFromCookie(magic['pivit.sid']);
    assert.notStrictEqual(viewSidAfter, viewSidBefore);
    const viewing = await request(server, 'GET', '/api/auth/me', null, magic);
    assert.strictEqual(viewing.json.view_as.id, other.rows[0].id);
    const stopped = await request(server, 'POST', '/api/auth/view-as/stop', {}, magic);
    assert.strictEqual(stopped.status, 200);
    assert.strictEqual(stopped.json.view_as, null);
    assert.notStrictEqual(sidFromCookie(magic['pivit.sid']), viewSidAfter);
    const viewAudit = await db.query(
      `SELECT action FROM audit_log WHERE action IN ('view_as', 'view_as_stop') ORDER BY id`
    );
    assert.deepStrictEqual(viewAudit.rows.map((row) => row.action), ['view_as', 'view_as_stop']);

    const ownerAgain = {};
    const ownerAgainLogin = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-value',
    }, ownerAgain);
    assert.strictEqual(ownerAgainLogin.status, 200);
    assert.notStrictEqual(sidFromCookie(ownerAgain['pivit.sid']), ownerSid);
    const superUser = await db.query(`SELECT id FROM users WHERE email = 'info@heclr.com'`);
    const beforeLogout = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'userId' = $1`,
      [superUser.rows[0].id]
    );
    assert.ok(beforeLogout.rows[0].n >= 2);
    const gone = await request(server, 'POST', '/api/auth/logout-all', null, ownerAgain);
    assert.strictEqual(gone.status, 204);
    const left = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'userId' = $1`,
      [superUser.rows[0].id]
    );
    assert.strictEqual(left.rows[0].n, 0);
    const ownerAudit = await db.query(
      `SELECT action, target_id FROM audit_log WHERE action = 'signout_everywhere' AND target_type = 'user'`
    );
    assert.ok(ownerAudit.rows.some((row) => row.target_id === superUser.rows[0].id));
    const magicAfter = await request(server, 'GET', '/api/auth/me', null, magic);
    assert.strictEqual(magicAfter.json.role, null);

    const stillViewer = {};
    const stillOther = {};
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, stillViewer);
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, stillOther);
    const clientCount = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'clientId' = $1`,
      [String(clientId)]
    );
    assert.ok(clientCount.rows[0].n >= 2);
    const clientOut = await request(server, 'POST', '/api/auth/logout-all', null, stillViewer);
    assert.strictEqual(clientOut.status, 204);
    const clientLeft = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'clientId' = $1`,
      [String(clientId)]
    );
    assert.strictEqual(clientLeft.rows[0].n, 0);
    const clientAudit = await db.query(
      `SELECT action, target_id FROM audit_log WHERE action = 'signout_everywhere' AND target_type = 'client'`
    );
    assert.ok(clientAudit.rows.some((row) => row.target_id === String(clientId)));
    const otherMe = await request(server, 'GET', '/api/auth/me', null, stillOther);
    assert.strictEqual(otherMe.json.role, null);

    const ownerBack = {};
    await request(server, 'POST', '/api/auth/login', { password: 'session-admin-key-value' }, ownerBack);
    const kept = {};
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'correct-horse',
    }, kept);
    const reset = await request(server, 'PATCH', `/api/clients/${clientId}`, {
      password: 'brand-new-password',
    }, ownerBack);
    assert.strictEqual(reset.status, 200, reset.text);
    const resetMe = await request(server, 'GET', '/api/auth/me', null, kept);
    assert.strictEqual(resetMe.json.role, null);
    const relog = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'brand-new-password',
    }, {});
    assert.strictEqual(relog.status, 200);

    const emergency = {};
    const emergencyLogin = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-value',
    }, emergency);
    assert.strictEqual(emergencyLogin.status, 200);
    const survivor = {};
    await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada',
      password: 'brand-new-password',
    }, survivor);
    process.env.ADMIN_API_KEY = 'session-admin-key-rotated';
    const emergencyMe = await request(server, 'GET', '/api/auth/me', null, emergency);
    assert.strictEqual(emergencyMe.json.role, null);
    const survivorMe = await request(server, 'GET', '/api/auth/me', null, survivor);
    assert.strictEqual(survivorMe.json.role, 'client');
    const oldKey = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-value',
    }, {});
    assert.strictEqual(oldKey.status, 401);
    const newKey = await request(server, 'POST', '/api/auth/login', {
      password: 'session-admin-key-rotated',
    }, {});
    assert.strictEqual(newKey.status, 200);

    console.log('session hardening tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
