// Sign-up, magic link, invite codes, rate limits and site verification.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const pg = require('./test-postgres');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
}

function pageChecks() {
  const signup = read('signup.html');
  const check = read('check-email.html');
  const interstitial = read('sign-in.html');
  const legal = read('legal.html');
  assert.ok(signup.includes('Work email'));
  assert.ok(signup.includes('Your website'));
  assert.ok(signup.includes('By continuing you agree to the'));
  assert.ok(signup.includes('/legal.html'));
  assert.ok(check.includes('Check your email'));
  assert.ok(check.includes('6-digit code'));
  assert.ok(check.includes('Resend in'));
  assert.ok(interstitial.includes('>Sign in<'));
  assert.ok(interstitial.indexOf("addEventListener('submit'") < interstitial.indexOf("fetch('/api/auth/magic'"));
  assert.ok(!interstitial.includes('DOMContentLoaded'));
  assert.ok(legal.includes('Placeholder for Lyle to write'));
  assert.ok(legal.includes('beta-2026-10-09'));
  assert.ok(legal.includes('This page is a placeholder'));
  const flow = fs.readFileSync(path.join(__dirname, '../src/auth-flow.js'), 'utf8');
  assert.ok(flow.includes("const TERMS_VERSION = 'beta-2026-10-09'"));
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

function linkParts(message) {
  const link = message.text.match(/https?:\/\/\S+/)[0];
  const token = new URL(link).searchParams.get('token');
  const code = message.text.match(/sign-in page: (\d{6})/)[1];
  return { link, token, code };
}

async function main() {
  pageChecks();
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('signup db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_signup_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  process.env.ADMIN_API_KEY = 'signup-admin-key-value';
  process.env.SESSION_SECRET = 'signup-session-secret-value-32chars';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  delete process.env.APP_ORIGIN;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applySignup } = require('../src/db/signup');
  const { takeLastLoggedEmail } = require('../src/mailer');
  const { csrfMiddleware } = require('../src/csrf');
  const sessionMiddleware = require('../src/session');
  const { LINK_SENT } = require('../src/auth-flow');

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(csrfMiddleware);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/invites', require('../src/routes/invites'));
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use(express.static(path.join(__dirname, '../public')));

  let server;
  try {
    await migrate();
    takeLastLoggedEmail();
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const owner = {};
    const login = await request(server, 'POST', '/api/auth/login', { password: 'signup-admin-key-value' }, owner);
    assert.deepStrictEqual(login.json, { role: 'owner' });
    assert.deepStrictEqual(Object.keys(login.json), ['role']);
    assert.ok(login.cookies.some((line) => line.startsWith('pivit.sid=')));
    assert.ok(Math.abs(login.maxAge - (12 * 60 * 60)) < 5, `emergency max-age ${login.maxAge}`);
    const sid1 = owner['pivit.sid'];

    const created = await request(server, 'POST', '/api/invites', { note: 'Ada' }, owner);
    assert.strictEqual(created.status, 201);
    const code = created.json.code;
    assert.ok(/^pivit-[a-z2-9]{10}$/.test(code));
    const listed = await request(server, 'GET', '/api/invites', null, owner);
    assert.strictEqual(listed.status, 200);
    assert.ok(!JSON.stringify(listed.json).includes(code));
    assert.ok(listed.json.invites.some((row) => row.hint === code.slice(-4) && row.note === 'Ada'));

    const customer = {};
    const signup = await request(server, 'POST', '/api/auth/signup', {
      email: 'Ada@Example.co.uk',
      website: 'https://www.example.co.uk/pricing',
      invite_code: code,
    }, customer);
    assert.strictEqual(signup.status, 200);
    assert.strictEqual(signup.json.message, LINK_SENT);
    const mailed = takeLastLoggedEmail();
    assert.ok(mailed);
    assert.strictEqual(mailed.from, 'no-reply@pivitlab.com');
    assert.strictEqual(mailed.replyTo, 'info@heclr.com');
    assert.strictEqual(mailed.to, 'ada@example.co.uk');
    assert.strictEqual(mailed.subject, 'Finish creating your pivitlab account');
    assert.ok(!mailed.text.includes('<'));
    const first = linkParts(mailed);

    const scanned = await request(server, 'GET', '/sign-in.html?token=' + encodeURIComponent(first.token));
    assert.strictEqual(scanned.status, 200);
    assert.ok(scanned.text.includes('>Sign in<'));
    const unused = await db.query(`SELECT used_at FROM login_tokens WHERE token_hash = $1`, [
      require('crypto').createHash('sha256').update(first.token).digest('hex'),
    ]);
    assert.strictEqual(unused.rows[0].used_at, null);

    const blocked = await request(server, 'POST', '/api/auth/magic', { token: first.token }, customer, { Origin: 'https://evil.example' });
    assert.strictEqual(blocked.status, 403);
    const stillUnused = await db.query(`SELECT used_at FROM login_tokens WHERE email = 'ada@example.co.uk'`);
    assert.strictEqual(stillUnused.rows[0].used_at, null);

    const signed = await request(server, 'POST', '/api/auth/magic', { token: first.token }, customer);
    assert.strictEqual(signed.status, 200);
    assert.deepStrictEqual(signed.json, { role: 'owner' });
    assert.ok(Math.abs(signed.maxAge - (30 * 24 * 60 * 60)) < 5, `customer max-age ${signed.maxAge}`);
    assert.notStrictEqual(customer['pivit.sid'], sid1);
    const again = await request(server, 'POST', '/api/auth/magic', { token: first.token }, {});
    assert.strictEqual(again.status, 400);

    const me = await request(server, 'GET', '/api/auth/me', null, customer);
    assert.strictEqual(me.json.email, 'ada@example.co.uk');
    assert.strictEqual(me.json.account.name, 'example.co.uk');
    assert.strictEqual(me.json.emergency, false);
    const user = await db.query(`SELECT verified_at, terms_version FROM users WHERE email = 'ada@example.co.uk'`);
    assert.ok(user.rows[0].verified_at);
    assert.strictEqual(user.rows[0].terms_version, 'beta-2026-10-09');
    const spent = await db.query(`SELECT used_at FROM invite_codes WHERE hint = $1`, [code.slice(-4)]);
    assert.ok(spent.rows[0].used_at);

    const draft = await request(server, 'POST', '/api/experiments', {
      name: 'Home',
      url_match: '/pricing',
      allowed_hosts: ['example.co.uk'],
    }, customer);
    assert.strictEqual(draft.status, 201);
    const tooSoon = await request(server, 'PATCH', `/api/experiments/${draft.json.id}/status`, { status: 'running' }, customer);
    assert.strictEqual(tooSoon.status, 400);
    assert.ok(/snippet/i.test(tooSoon.json.error));

    const setupBefore = await request(server, 'GET', '/api/setup', null, customer);
    assert.strictEqual(setupBefore.json.needs_setup, false);
    assert.strictEqual(setupBefore.json.site.verified, false);
    assert.ok(/^site_[a-f0-9]+$/i.test(setupBefore.json.site.public_key));
    const seen = await request(
      server,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://example.co.uk/pricing') + '&site=' + setupBefore.json.site.public_key,
      null,
      null,
      { Origin: 'https://example.co.uk' }
    );
    assert.strictEqual(seen.status, 200);
    const setupAfter = await request(server, 'GET', '/api/setup', null, customer);
    assert.strictEqual(setupAfter.json.site.verified, true);
    const started = await request(server, 'PATCH', `/api/experiments/${draft.json.id}/status`, { status: 'running' }, customer);
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.json.status, 'running');

    const otherInvite = await request(server, 'POST', '/api/invites', {}, owner);
    const coder = {};
    const codeSignup = await request(server, 'POST', '/api/auth/signup', {
      email: 'code@shop.example',
      website: 'shop.example',
      invite_code: otherInvite.json.code,
    }, coder);
    assert.strictEqual(codeSignup.status, 200);
    const codeMail = linkParts(takeLastLoggedEmail());
    for (let i = 0; i < 5; i += 1) {
      const wrong = await request(server, 'POST', '/api/auth/code', { email: 'code@shop.example', code: '000000' }, coder);
      assert.strictEqual(wrong.status, 401);
    }
    const locked = await request(server, 'POST', '/api/auth/code', { email: 'code@shop.example', code: codeMail.code }, coder);
    assert.strictEqual(locked.status, 401);
    assert.ok(/too many times/i.test(locked.json.error));
    const byLink = await request(server, 'POST', '/api/auth/magic', { token: codeMail.token }, coder);
    assert.strictEqual(byLink.status, 200);
    const foreign = await request(server, 'GET', `/api/experiments/${draft.json.id}`, null, coder);
    assert.strictEqual(foreign.status, 404);
    const foreignAudit = await request(server, 'GET', '/api/audit', null, coder);
    assert.ok(!foreignAudit.json.entries.some((entry) => entry.detail && entry.detail.website === 'example.co.uk'));

    const clashInvite = await request(server, 'POST', '/api/invites', {}, owner);
    const clash = await request(server, 'POST', '/api/auth/signup', {
      email: 'second@example.co.uk',
      website: 'example.co.uk',
      invite_code: clashInvite.json.code,
    }, {});
    assert.strictEqual(clash.status, 200);
    const clashMail = linkParts(takeLastLoggedEmail());
    const clashJar = {};
    const clashIn = await request(server, 'POST', '/api/auth/magic', { token: clashMail.token }, clashJar);
    assert.strictEqual(clashIn.status, 200);
    const flags = await db.query(
      `SELECT conflict FROM sites WHERE 'example.co.uk' = ANY(domains) ORDER BY created_at`
    );
    assert.ok(flags.rows.length >= 2);
    assert.ok(flags.rows.every((row) => row.conflict === true));

    const doomed = await request(server, 'POST', '/api/invites', {}, owner);
    const revoked = await request(server, 'POST', `/api/invites/${doomed.json.invite.id}/revoke`, null, owner);
    assert.strictEqual(revoked.status, 200);
    const rejected = await request(server, 'POST', '/api/auth/signup', {
      email: 'late@elsewhere.example',
      website: 'elsewhere.example',
      invite_code: doomed.json.code,
    }, {});
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(rejected.json.error, 'That invite code is not valid.');
    assert.strictEqual(takeLastLoggedEmail(), null);

    const missing = await request(server, 'POST', '/api/auth/email', { email: 'nobody@example.co.uk' }, {});
    assert.strictEqual(missing.status, 200);
    assert.strictEqual(missing.json.message, LINK_SENT);
    assert.strictEqual(takeLastLoggedEmail(), null);

    const adminMail = await request(server, 'POST', '/api/auth/email', { email: 'info@heclr.com' }, {});
    assert.strictEqual(adminMail.status, 200);
    const adminLink = linkParts(takeLastLoggedEmail());
    assert.strictEqual(takeLastLoggedEmail(), null);
    const second = {};
    const adminIn = await request(server, 'POST', '/api/auth/magic', { token: adminLink.token }, second);
    assert.strictEqual(adminIn.status, 200);
    assert.ok(Math.abs(adminIn.maxAge - (12 * 60 * 60)) < 5);
    assert.notStrictEqual(second['pivit.sid'], sid1);
    const superUser = await db.query(`SELECT id, verified_at FROM users WHERE email = 'info@heclr.com'`);
    assert.ok(superUser.rows[0].verified_at);
    const sessions = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'userId' = $1`,
      [superUser.rows[0].id]
    );
    assert.ok(sessions.rows[0].n >= 2);
    const gone = await request(server, 'POST', '/api/auth/logout-all', null, second);
    assert.strictEqual(gone.status, 204);
    const left = await db.query(
      `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>'userId' = $1`,
      [superUser.rows[0].id]
    );
    assert.strictEqual(left.rows[0].n, 0);

    const limitedEmail = 'limited@example.co.uk';
    for (let i = 0; i < 5; i += 1) {
      const attempt = await request(server, 'POST', '/api/auth/signup', {
        email: limitedEmail,
        website: 'limited.example',
        invite_code: 'pivit-not-real',
      }, {});
      assert.strictEqual(attempt.status, 400, attempt.text);
    }
    const limited = await request(server, 'POST', '/api/auth/signup', {
      email: limitedEmail,
      website: 'limited.example',
      invite_code: 'pivit-not-real',
    }, {});
    assert.strictEqual(limited.status, 429);
    assert.ok(!/exist/i.test(limited.json.error));

    const legacy = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, account_id, allowed_hosts)
       VALUES ('Audit copy', '/audit', $1, '{}') RETURNING id`,
      [legacy.rows[0].id]
    );
    await db.query(
      `INSERT INTO test_traffic_audit (experiment_id, action, actor, criteria, visitor_count, event_count)
       VALUES ($1, 'remove', 'owner', '{"mode":"test"}'::jsonb, 2, 3)`,
      [exp.rows[0].id]
    );
    const client = await db.pool.connect();
    try {
      await applySignup(client);
      const once = await db.query(
        `SELECT COUNT(*)::int AS n FROM audit_log WHERE detail->>'source_audit_id' IS NOT NULL`
      );
      await applySignup(client);
      const twice = await db.query(
        `SELECT COUNT(*)::int AS n FROM audit_log WHERE detail->>'source_audit_id' IS NOT NULL`
      );
      assert.ok(once.rows[0].n >= 1);
      assert.strictEqual(twice.rows[0].n, once.rows[0].n);
    } finally {
      client.release();
    }

    console.log('signup db tests passed');
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
