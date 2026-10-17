// Agency invites: same agency, single-use, expiry, revoke, resend, isolation.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body, jar) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = {
      Origin: `http://127.0.0.1:${port}`,
      Host: `127.0.0.1:${port}`,
    };
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
          retryAfter: res.headers['retry-after'] || null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tokenFrom(link) {
  return new URL(link).searchParams.get('token');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('account invite db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_agency_invite_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_API_KEY = 'agency-invite-admin-key';
  process.env.SESSION_SECRET = 'agency-invite-session-secret-32chars';
  process.env.APP_ORIGIN = 'https://pivitlab.test';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.POSTMARK_STREAM;
  delete process.env.EMAIL_FROM;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { takeLastLoggedEmail } = require('../src/mailer');
  const { csrfMiddleware } = require('../src/csrf');
  const sessionMiddleware = require('../src/session');
  const { personAccess } = require('../src/person-state');
  const { LIMITED_MESSAGE } = require('../src/rate-limit');
  const { deleteUser } = require('../src/person-state');
  const {
      CANNOT_INVITE,
      ALREADY_MEMBER,
      ALREADY_PENDING,
      INVITE_INVALID,
      COOLDOWN,
      EXPIRED,
      EMAIL_INVALID,
    } = require('../src/account-invite');

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(personAccess);
  app.use(csrfMiddleware);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/invites', require('../src/routes/invites'));
  app.use('/api/account/members', require('../src/routes/members'));
  app.use(express.static(require('path').join(__dirname, '../public')));

  let server;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('017'));
    takeLastLoggedEmail();
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const owner = {};
    const login = await request(server, 'POST', '/api/auth/login', { password: 'agency-invite-admin-key' }, owner);
    assert.deepStrictEqual(login.json, { role: 'owner' });
    const me = await request(server, 'GET', '/api/auth/me', null, owner);
    assert.strictEqual(me.json.membership, 'owner');
    const heclrId = me.json.account.id;
    const ownerId = (await db.query(`SELECT id FROM users WHERE email = 'info@heclr.com'`)).rows[0].id;

    const accountsBefore = await db.query(`SELECT COUNT(*)::int AS n FROM accounts`);
    const sitesBefore = await db.query(`SELECT COUNT(*)::int AS n FROM sites`);

    const platform = await request(server, 'POST', '/api/invites', { note: 'new agency' }, owner);
    assert.strictEqual(platform.status, 201, platform.text);
    assert.ok(platform.json.code.startsWith('pivit-'));
    const platformRow = await db.query(`SELECT id FROM invite_codes WHERE hint = $1`, [platform.json.code.slice(-4)]);
    assert.strictEqual(platformRow.rows.length, 1);
    const agencyRowsAfterPlatform = await db.query(`SELECT COUNT(*)::int AS n FROM account_invites`);
    assert.strictEqual(agencyRowsAfterPlatform.rows[0].n, 0);

    const created = await request(server, 'POST', '/api/account/members/invites', {
      email: 'Ada@Example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(created.status, 201, created.text);
    assert.strictEqual(created.json.emailed, false);
    assert.strictEqual(created.json.invite.email, 'ada@example.co.uk');
    assert.strictEqual(created.json.invite.role, 'member');
    assert.ok(created.json.link.startsWith('https://pivitlab.test/join.html?token='));
    assert.ok(!created.text.includes('token_hash'));
    const token = tokenFrom(created.json.link);
    const stored = await db.query(`SELECT token_hash, account_id FROM account_invites WHERE id = $1`, [created.json.invite.id]);
    assert.strictEqual(stored.rows[0].token_hash, sha256(token));
    assert.notStrictEqual(stored.rows[0].token_hash, token);
    assert.strictEqual(stored.rows[0].account_id, heclrId);

    const duplicate = await request(server, 'POST', '/api/account/members/invites', {
      email: 'ada@example.co.uk',
      role: 'owner',
      send: false,
    }, owner);
    assert.strictEqual(duplicate.status, 400, duplicate.text);
    assert.strictEqual(duplicate.json.error, ALREADY_PENDING);

    const page = await request(server, 'GET', '/join.html?token=' + encodeURIComponent(token));
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Join this agency'));
    const unused = await db.query(`SELECT used_at FROM account_invites WHERE id = $1`, [created.json.invite.id]);
    assert.strictEqual(unused.rows[0].used_at, null);

    const preview = await request(server, 'GET', '/api/auth/join?token=' + encodeURIComponent(token));
    assert.strictEqual(preview.status, 200, preview.text);
    assert.strictEqual(preview.json.email, 'ada@example.co.uk');
    assert.strictEqual(preview.json.role, 'member');
    assert.strictEqual(preview.json.agency_name, me.json.account.name);
    const stillUnused = await db.query(`SELECT used_at FROM account_invites WHERE id = $1`, [created.json.invite.id]);
    assert.strictEqual(stillUnused.rows[0].used_at, null);

    const hostile = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ token });
      const { port } = server.address();
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/join',
        headers: {
          Origin: 'https://evil.example',
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    assert.strictEqual(hostile.status, 403);
    assert.strictEqual((await db.query(`SELECT used_at FROM account_invites WHERE id = $1`, [created.json.invite.id])).rows[0].used_at, null);

    const joiner = {};
    const joined = await request(server, 'POST', '/api/auth/join', { token }, joiner);
    assert.strictEqual(joined.status, 200, joined.text);
    assert.deepStrictEqual(joined.json, { role: 'owner' });
    const again = await request(server, 'POST', '/api/auth/join', { token }, {});
    assert.strictEqual(again.status, 400);
    assert.strictEqual(again.json.error, INVITE_INVALID);

    const accountsAfter = await db.query(`SELECT COUNT(*)::int AS n FROM accounts`);
    const sitesAfter = await db.query(`SELECT COUNT(*)::int AS n FROM sites`);
    assert.strictEqual(accountsAfter.rows[0].n, accountsBefore.rows[0].n);
    assert.strictEqual(sitesAfter.rows[0].n, sitesBefore.rows[0].n);
    const ada = await db.query(
      `SELECT id, verified_at, terms_version FROM users WHERE email = 'ada@example.co.uk'`
    );
    assert.ok(ada.rows[0].verified_at);
    assert.strictEqual(ada.rows[0].terms_version, 'beta-2026-10-09');
    const adaMembership = await db.query(
      `SELECT role, removed_at FROM memberships WHERE user_id = $1 AND account_id = $2`,
      [ada.rows[0].id, heclrId]
    );
    assert.strictEqual(adaMembership.rows[0].role, 'member');
    assert.strictEqual(adaMembership.rows[0].removed_at, null);
    const adaMe = await request(server, 'GET', '/api/auth/me', null, joiner);
    assert.strictEqual(adaMe.json.account.id, heclrId);
    assert.strictEqual(adaMe.json.membership, 'member');
    assert.strictEqual(adaMe.json.email, 'ada@example.co.uk');

    const memberCreate = await request(server, 'POST', '/api/account/members/invites', {
      email: 'other@example.co.uk',
      role: 'member',
      send: false,
    }, joiner);
    assert.strictEqual(memberCreate.status, 404, memberCreate.text);

    const betaAccount = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Beta Ltd', false) RETURNING id`
    );
    const betaUser = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('bea@beta.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [betaAccount.rows[0].id, betaUser.rows[0].id]
    );
    const accountsMid = (await db.query(`SELECT COUNT(*)::int AS n FROM accounts`)).rows[0].n;
    const emailed = await request(server, 'POST', '/api/account/members/invites', {
      email: 'bea@beta.example',
      role: 'owner',
      send: true,
    }, owner);
    assert.strictEqual(emailed.status, 201, emailed.text);
    assert.strictEqual(emailed.json.emailed, true);
    assert.ok(emailed.json.link.startsWith('https://pivitlab.test/join.html?token='));
    const mailed = takeLastLoggedEmail();
    assert.strictEqual(mailed.to, 'bea@beta.example');
    assert.ok(mailed.subject.includes('pivitlab'));
    assert.ok(!mailed.subject.includes('Pivitlab'));
    assert.ok(mailed.text.includes(emailed.json.link));
    assert.ok(mailed.text.includes('as an Owner'));
    assert.ok(mailed.text.includes('does not create a new agency'));
    assert.strictEqual(mailed.tag, 'agency-invite');
    assert.ok(mailed.html.includes('>Join this agency<'));
    assert.ok(mailed.html.includes('pivitlab'));
    assert.ok(!mailed.html.includes('Pivitlab'));
    const beaJar = {};
    const beaJoin = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(emailed.json.link) }, beaJar);
    assert.strictEqual(beaJoin.status, 200, beaJoin.text);
    const beaMe = await request(server, 'GET', '/api/auth/me', null, beaJar);
    assert.strictEqual(beaMe.json.account.id, heclrId);
    assert.strictEqual(beaMe.json.membership, 'owner');
    assert.strictEqual(beaMe.json.email, 'bea@beta.example');
    const beaStill = await db.query(
      `SELECT role FROM memberships WHERE user_id = $1 AND account_id = $2`,
      [betaUser.rows[0].id, betaAccount.rows[0].id]
    );
    assert.strictEqual(beaStill.rows[0].role, 'owner');
    assert.strictEqual((await db.query(`SELECT COUNT(*)::int AS n FROM accounts`)).rows[0].n, accountsMid);
    const beaUsers = await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE email = 'bea@beta.example'`);
    assert.strictEqual(beaUsers.rows[0].n, 1);

    const self = await request(server, 'POST', '/api/account/members/invites', {
      email: 'info@heclr.com',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(self.status, 400);
    assert.strictEqual(self.json.error, ALREADY_MEMBER);

    await db.query(
      `INSERT INTO users (email, verified_at, suspended_at) VALUES ('suspended@example.co.uk', now(), now())`
    );
    const suspended = await request(server, 'POST', '/api/account/members/invites', {
      email: 'suspended@example.co.uk',
      role: 'member',
      send: true,
    }, owner);
    assert.strictEqual(suspended.status, 400);
    assert.strictEqual(suspended.json.error, CANNOT_INVITE);
    assert.strictEqual(takeLastLoggedEmail(), null);
    const suspendedRows = await db.query(`SELECT id FROM account_invites WHERE email = 'suspended@example.co.uk'`);
    assert.strictEqual(suspendedRows.rows.length, 0);

    const deletedPerson = await db.query(
      `INSERT INTO users (email, verified_at, deleted_at) VALUES ('gone@example.co.uk', now(), now()) RETURNING id`
    );
    const deletedInvite = await request(server, 'POST', '/api/account/members/invites', {
      email: 'gone@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(deletedInvite.status, 400);
    assert.strictEqual(deletedInvite.json.error, CANNOT_INVITE);
    const anon = `deleted-${deletedPerson.rows[0].id}@invalid`;
    await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [deletedPerson.rows[0].id, anon]);
    const anonInvite = await request(server, 'POST', '/api/account/members/invites', {
      email: anon,
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(anonInvite.status, 400);
    assert.strictEqual(anonInvite.json.error, EMAIL_INVALID);
    const reused = await request(server, 'POST', '/api/account/members/invites', {
      email: 'gone@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(reused.status, 201, reused.text);
    const reusedJoin = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(reused.json.link) }, {});
    assert.strictEqual(reusedJoin.status, 200, reusedJoin.text);
    const reusedUser = await db.query(`SELECT id, deleted_at FROM users WHERE email = 'gone@example.co.uk'`);
    assert.notStrictEqual(reusedUser.rows[0].id, deletedPerson.rows[0].id);
    assert.strictEqual(reusedUser.rows[0].deleted_at, null);

    await db.query(
      `INSERT INTO users (email, verified_at, archived_at) VALUES ('archived@example.co.uk', now(), now())`
    );
    const archived = await request(server, 'POST', '/api/account/members/invites', {
      email: 'archived@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(archived.status, 201, archived.text);
    const archivedJar = {};
    const archivedJoin = await request(server, 'POST', '/api/auth/join', {
      token: tokenFrom(archived.json.link),
    }, archivedJar);
    assert.strictEqual(archivedJoin.status, 200, archivedJoin.text);

    const held = await request(server, 'POST', '/api/account/members/invites', {
      email: 'held@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(held.status, 201, held.text);
    await db.query(
      `INSERT INTO users (email, verified_at, suspended_at) VALUES ('held@example.co.uk', now(), now())`
    );
    const heldClosed = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(held.json.link) }, {});
    assert.strictEqual(heldClosed.status, 401, heldClosed.text);
    assert.strictEqual(
      (await db.query(`SELECT used_at FROM account_invites WHERE id = $1`, [held.json.invite.id])).rows[0].used_at,
      null
    );
    await db.query(`UPDATE users SET suspended_at = NULL WHERE email = 'held@example.co.uk'`);
    const heldJar = {};
    const heldOpen = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(held.json.link) }, heldJar);
    assert.strictEqual(heldOpen.status, 200, heldOpen.text);

    const doomed = await db.query(
      `INSERT INTO users (email, verified_at, suspended_at) VALUES ('doomed@example.co.uk', now(), now()) RETURNING id`
    );
    await db.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [doomed.rows[0].id]);
    const doomedInvite = await request(server, 'POST', '/api/account/members/invites', {
      email: 'doomed@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(doomedInvite.status, 201, doomedInvite.text);
    await db.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [doomed.rows[0].id]);
    const removed = await deleteUser({
      actorUserId: ownerId,
      actorEmail: 'info@heclr.com',
      userId: doomed.rows[0].id,
      body: { confirm: 'doomed@example.co.uk' },
      ip: '127.0.0.1',
    });
    assert.strictEqual(removed.ok, true, JSON.stringify(removed));
    const doomedRow = await db.query(`SELECT revoked_at FROM account_invites WHERE id = $1`, [doomedInvite.json.invite.id]);
    assert.ok(doomedRow.rows[0].revoked_at);
    const doomedAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(doomedInvite.json.link) }, {});
    assert.strictEqual(doomedAccept.status, 400);
    assert.strictEqual(doomedAccept.json.error, INVITE_INVALID);

    const revocable = await request(server, 'POST', '/api/account/members/invites', {
      email: 'revoke@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(revocable.status, 201, revocable.text);
    const listed = await request(server, 'GET', '/api/account/members/invites', null, owner);
    assert.ok(listed.json.invites.some((row) => row.email === 'revoke@example.co.uk'));
    const revoked = await request(server, 'POST', `/api/account/members/invites/${revocable.json.invite.id}/revoke`, {}, owner);
    assert.strictEqual(revoked.status, 200, revoked.text);
    assert.ok(revoked.json.invite.revoked_at);
    const afterRevoke = await request(server, 'GET', '/api/account/members/invites', null, owner);
    assert.ok(!afterRevoke.json.invites.some((row) => row.id === revocable.json.invite.id));
    const revokedAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(revocable.json.link) }, {});
    assert.strictEqual(revokedAccept.status, 400);

    const expiring = await request(server, 'POST', '/api/account/members/invites', {
      email: 'expire@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    await db.query(`UPDATE account_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring.json.invite.id]);
    const expiredAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(expiring.json.link) }, {});
    assert.strictEqual(expiredAccept.status, 400);
    const expiredResend = await request(server, 'POST', `/api/account/members/invites/${expiring.json.invite.id}/resend`, {}, owner);
    assert.strictEqual(expiredResend.status, 400);
    assert.strictEqual(expiredResend.json.error, EXPIRED);

    const resent = await request(server, 'POST', '/api/account/members/invites', {
      email: 'resend@example.co.uk',
      role: 'member',
      send: true,
    }, owner);
    assert.strictEqual(resent.status, 201, resent.text);
    takeLastLoggedEmail();
    const cooled = await request(server, 'POST', `/api/account/members/invites/${resent.json.invite.id}/resend`, {}, owner);
    assert.strictEqual(cooled.status, 400, cooled.text);
    assert.strictEqual(cooled.json.error, COOLDOWN);
    const hashBefore = (await db.query(`SELECT token_hash FROM account_invites WHERE id = $1`, [resent.json.invite.id])).rows[0].token_hash;
    assert.strictEqual(hashBefore, sha256(tokenFrom(resent.json.link)));
    await db.query(
      `UPDATE account_invites SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`,
      [resent.json.invite.id]
    );
    const resentOk = await request(server, 'POST', `/api/account/members/invites/${resent.json.invite.id}/resend`, {}, owner);
    assert.strictEqual(resentOk.status, 200, resentOk.text);
    assert.strictEqual(resentOk.json.resent, true);
    assert.strictEqual(resentOk.json.emailed, true);
    assert.notStrictEqual(tokenFrom(resentOk.json.link), tokenFrom(resent.json.link));
    assert.ok(resentOk.json.link.startsWith('https://pivitlab.test/join.html?token='));
    const resentMail = takeLastLoggedEmail();
    assert.ok(resentMail.text.includes(resentOk.json.link));
    const oldAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(resent.json.link) }, {});
    assert.strictEqual(oldAccept.status, 400);
    const newJar = {};
    const newAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(resentOk.json.link) }, newJar);
    assert.strictEqual(newAccept.status, 200, newAccept.text);

    const removedMember = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('returned@example.co.uk', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role, removed_at)
       VALUES ($1, $2, 'member', now())`,
      [heclrId, removedMember.rows[0].id]
    );
    const returned = await request(server, 'POST', '/api/account/members/invites', {
      email: 'returned@example.co.uk',
      role: 'owner',
      send: false,
    }, owner);
    assert.strictEqual(returned.status, 201, returned.text);
    const returnedJoin = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(returned.json.link) }, {});
    assert.strictEqual(returnedJoin.status, 200, returnedJoin.text);
    const returnedRow = await db.query(
      `SELECT role, removed_at FROM memberships WHERE user_id = $1 AND account_id = $2`,
      [removedMember.rows[0].id, heclrId]
    );
    assert.strictEqual(returnedRow.rows[0].role, 'owner');
    assert.strictEqual(returnedRow.rows[0].removed_at, null);

    const badRole = await request(server, 'POST', '/api/account/members/invites', {
      email: 'role@example.co.uk',
      role: 'viewer',
      send: false,
    }, owner);
    assert.strictEqual(badRole.status, 400);
    assert.ok(badRole.json.error.includes('Member or Owner'));

    const other = await db.query(`SELECT id FROM accounts WHERE name = 'Beta Ltd'`);
    const forgedApp = express();
    forgedApp.use(express.json());
    forgedApp.use((req, res, next) => {
      req.session = {
        role: 'owner',
        userId: ownerId,
        accountId: heclrId,
        viewAsAccountId: other.rows[0].id,
        superadmin: true,
      };
      next();
    });
    forgedApp.use('/api/account/members', require('../src/routes/members'));
    const forged = await new Promise((resolve) => {
      const listening = forgedApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const viewList = await request(forged, 'GET', '/api/account/members/invites');
      assert.strictEqual(viewList.status, 404, viewList.text);
      const viewCreate = await request(forged, 'POST', '/api/account/members/invites', {
        email: 'view@example.co.uk',
        role: 'member',
        send: false,
      });
      assert.strictEqual(viewCreate.status, 403, viewCreate.text);
    } finally {
      await new Promise((resolve) => forged.close(resolve));
    }

    const audit = await db.query(
      `SELECT action, detail::text AS detail
       FROM audit_log
       WHERE action LIKE 'account_invite_%'
       ORDER BY id`
    );
    assert.ok(audit.rows.some((row) => row.action === 'account_invite_created'));
    assert.ok(audit.rows.some((row) => row.action === 'account_invite_accepted'));
    assert.ok(audit.rows.some((row) => row.action === 'account_invite_revoked'));
    assert.ok(audit.rows.some((row) => row.action === 'account_invite_resent'));
    for (const row of audit.rows) {
      assert.ok(!row.detail.includes(tokenFrom(resentOk.json.link)));
      assert.ok(!row.detail.includes('token_hash'));
    }
    const heclrAudit = await db.query(
      `SELECT account_id FROM audit_log WHERE action = 'account_invite_created' AND detail->>'email' = 'ada@example.co.uk'`
    );
    assert.strictEqual(heclrAudit.rows[0].account_id, heclrId);

    await db.query(`DELETE FROM rate_limits WHERE bucket LIKE 'account-invite-%'`);
    const windowMs = 60 * 60 * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
    await db.query(
      `INSERT INTO rate_limits (bucket, hits, window_start)
       VALUES ($1, 5, $2)
       ON CONFLICT (bucket) DO UPDATE SET hits = 5, window_start = EXCLUDED.window_start`,
      ['account-invite-email:capped@example.co.uk', windowStart]
    );
    const capped = await request(server, 'POST', '/api/account/members/invites', {
      email: 'capped@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(capped.status, 429, capped.text);
    assert.strictEqual(capped.json.error, LIMITED_MESSAGE);
    assert.ok(capped.retryAfter);
    assert.strictEqual((await db.query(`SELECT id FROM account_invites WHERE email = 'capped@example.co.uk'`)).rows.length, 0);

    const probe = await request(server, 'POST', '/api/auth/join', { token: 'not-a-real-token' }, {});
    assert.strictEqual(probe.status, 400);
    const acceptBuckets = await db.query(
      `SELECT bucket FROM rate_limits WHERE bucket LIKE 'account-invite-accept:%'`
    );
    assert.ok(acceptBuckets.rows.length >= 1);
    await db.query(`UPDATE rate_limits SET hits = 20, window_start = $2 WHERE bucket = $1`, [
      acceptBuckets.rows[0].bucket,
      windowStart,
    ]);
    const fresh = await request(server, 'POST', '/api/account/members/invites', {
      email: 'limited-accept@example.co.uk',
      role: 'member',
      send: false,
    }, owner);
    assert.strictEqual(fresh.status, 201, fresh.text);
    const limitedAccept = await request(server, 'POST', '/api/auth/join', { token: tokenFrom(fresh.json.link) }, {});
    assert.strictEqual(limitedAccept.status, 429, limitedAccept.text);
    assert.strictEqual(
      (await db.query(`SELECT used_at FROM account_invites WHERE id = $1`, [fresh.json.invite.id])).rows[0].used_at,
      null
    );

    console.log('account invite db tests passed');
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
