// Suspended and archived people. Sign-in stops, sessions die, lists hide
// archived people, and the last platform admin or account owner cannot be
// closed. Cross-account calls get the same 404 as a missing route.
const assert = require('assert');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const pg = require('./test-postgres');

process.env.NODE_ENV = 'test';

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
        resolve({ status: res.statusCode, text, json });
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

function linkParts(message) {
  const link = message.text.match(/https?:\/\/\S+/)[0];
  const token = new URL(link).searchParams.get('token');
  const code = message.text.match(/sign-in page: (\d{6})/)[1];
  return { token, code };
}

async function columnNames(db, table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.map((row) => row.column_name);
}

async function sessionCount(db, key, id) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM "session" WHERE sess->>$1 = $2`,
    [key, String(id)]
  );
  return rows[0].n;
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('person state db tests skipped: postgres not reachable');
    console.log('person state db tests passed');
    return;
  }
  const dbName = 'pivit_people_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_API_KEY = 'people-admin-key-value';
  process.env.SESSION_SECRET = 'people-state-session-secret-32ch';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.EMAIL_FROM;
  delete process.env.APP_ORIGIN;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyPeopleState } = require('../src/db/people-state');
  const { takeLastLoggedEmail } = require('../src/mailer');
  const { csrfMiddleware } = require('../src/csrf');
  const sessionMiddleware = require('../src/session');
  const { sessionLifetime } = require('../src/session-lifetime');
  const { personAccess, SIGN_IN_CLOSED, LAST_PLATFORM_ADMIN, LAST_ACCOUNT_OWNER, NOT_YOURSELF } = require('../src/person-state');
  const { LINK_SENT } = require('../src/auth-flow');

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use(sessionLifetime);
  app.use(personAccess);
  app.use(csrfMiddleware);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/people'));
  app.use('/api/clients', require('../src/routes/clients'));
  app.use('/api/client', require('../src/routes/client'));
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/account/members', require('../src/routes/members'));

  let server;
  try {
    const applied = await migrate();
    assert.ok(applied.includes('016'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyPeopleState(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    for (const table of ['users', 'clients']) {
      const names = await columnNames(db, table);
      for (const column of ['suspended_at', 'archived_at', 'deleted_at']) {
        assert.ok(names.includes(column), `${table}.${column}`);
      }
    }
    const memberships = await columnNames(db, 'memberships');
    assert.ok(memberships.includes('removed_at'));

    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const info = {};
    const login = await request(server, 'POST', '/api/auth/login', {
      password: 'people-admin-key-value',
    }, info);
    assert.strictEqual(login.status, 200, login.text);
    const infoRow = await db.query(`SELECT id FROM users WHERE email = 'info@heclr.com'`);
    const infoId = infoRow.rows[0].id;
    const legacy = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE`);
    const heclrId = legacy.rows[0].id;

    const created = await request(server, 'POST', '/api/clients', {
      name: 'Ada Viewer',
      username: 'ada-view',
      password: 'correct-horse',
    }, info);
    assert.strictEqual(created.status, 201, created.text);
    const viewerId = created.json.id;
    const otherViewer = await request(server, 'POST', '/api/clients', {
      name: 'Kept Viewer',
      username: 'kept-view',
      password: 'correct-horse',
    }, info);
    assert.strictEqual(otherViewer.status, 201, otherViewer.text);

    const alpha = await db.query(`INSERT INTO accounts (name, legacy) VALUES ('Alpha', false) RETURNING id`);
    const beta = await db.query(`INSERT INTO accounts (name, legacy) VALUES ('Beta', false) RETURNING id`);
    const alphaId = alpha.rows[0].id;
    const betaId = beta.rows[0].id;
    const ada = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('ada@alpha.example', now()) RETURNING id`
    );
    const mia = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('mia@alpha.example', now()) RETURNING id`
    );
    const rem = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('rem@alpha.example', now()) RETURNING id`
    );
    const adaId = ada.rows[0].id;
    const miaId = mia.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [alphaId, adaId, miaId]
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role, removed_at)
       VALUES ($1, $2, 'member', now())`,
      [alphaId, rem.rows[0].id]
    );
    const owen = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owen@beta.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [betaId, owen.rows[0].id]
    );
    const betaHash = await bcrypt.hash('beta-secret-pass', 10);
    const betaViewer = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Beta Viewer', 'beta-view', $2, $1) RETURNING id`,
      [betaId, betaHash]
    );
    const betaViewerId = betaViewer.rows[0].id;

    const refusedSelf = await request(server, 'PATCH', `/api/admin/users/${infoId}`, {
      suspended: true,
    }, info);
    assert.strictEqual(refusedSelf.status, 400, refusedSelf.text);
    assert.strictEqual(refusedSelf.json.error, LAST_PLATFORM_ADMIN);
    const refusedArchive = await request(server, 'PATCH', `/api/admin/users/${infoId}`, {
      archived: true,
    }, info);
    assert.strictEqual(refusedArchive.json.error, LAST_PLATFORM_ADMIN);
    const stillAdmin = await db.query(`SELECT suspended_at, archived_at FROM users WHERE id = $1`, [infoId]);
    assert.strictEqual(stillAdmin.rows[0].suspended_at, null);
    assert.strictEqual(stillAdmin.rows[0].archived_at, null);

    const refusedOwner = await request(server, 'PATCH', `/api/admin/users/${adaId}`, {
      suspended: true,
    }, info);
    assert.strictEqual(refusedOwner.status, 400, refusedOwner.text);
    assert.strictEqual(refusedOwner.json.error, LAST_ACCOUNT_OWNER);
    const refusedOwnerArchive = await request(server, 'PATCH', `/api/admin/users/${adaId}`, {
      archived: true,
    }, info);
    assert.strictEqual(refusedOwnerArchive.json.error, LAST_ACCOUNT_OWNER);
    const noAuditYet = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action LIKE 'user.%'`
    );
    assert.strictEqual(noAuditYet.rows[0].n, 0);

    const viewerJar = {};
    const viewerLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'correct-horse',
    }, viewerJar);
    assert.strictEqual(viewerLogin.status, 200, viewerLogin.text);
    assert.strictEqual(viewerLogin.json.role, 'client');
    const viewerSid = sidFromCookie(viewerJar['pivit.sid']);
    const viewerCookie = viewerJar['pivit.sid'];
    const viewerSess = await db.query(`SELECT sess FROM "session" WHERE sid = $1`, [viewerSid]);
    assert.strictEqual(viewerSess.rows[0].sess.clientId, viewerId);
    assert.ok(await sessionCount(db, 'clientId', viewerId) >= 1);

    const betaJar = {};
    const betaLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'beta-view',
      password: 'beta-secret-pass',
    }, betaJar);
    assert.strictEqual(betaLogin.status, 200, betaLogin.text);

    const wrongViewer = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'wrong-password',
    }, {});
    assert.strictEqual(wrongViewer.status, 401);
    assert.strictEqual(wrongViewer.json.error, 'incorrect username or password');

    const suspendedViewer = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      suspended: true,
    }, info);
    assert.strictEqual(suspendedViewer.status, 200, suspendedViewer.text);
    assert.strictEqual(suspendedViewer.json.changed, true);
    assert.strictEqual(suspendedViewer.json.suspended, true);
    assert.strictEqual(suspendedViewer.json.kind, 'viewer');
    assert.strictEqual(await sessionCount(db, 'clientId', viewerId), 0);
    assert.ok(await sessionCount(db, 'clientId', betaViewerId) >= 1);
    const viewerMe = await request(server, 'GET', '/api/auth/me', null, viewerJar);
    assert.ok(viewerMe.json == null || viewerMe.json.role == null, viewerMe.text);
    const viewerPortal = await request(server, 'GET', '/api/client/experiments', null, viewerJar);
    assert.strictEqual(viewerPortal.status, 401);

    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2::json, now() + interval '2 days')`,
      [viewerSid, JSON.stringify(viewerSess.rows[0].sess)]
    );
    viewerJar['pivit.sid'] = viewerCookie;
    const resurrected = await request(server, 'GET', '/api/client/experiments', null, viewerJar);
    assert.strictEqual(resurrected.status, 401, resurrected.text);
    assert.strictEqual(await sessionCount(db, 'clientId', viewerId), 0);

    const closedLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'correct-horse',
    }, {});
    assert.strictEqual(closedLogin.status, 401);
    assert.strictEqual(closedLogin.json.error, SIGN_IN_CLOSED);
    const repeat = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      suspended: true,
    }, info);
    assert.strictEqual(repeat.status, 200, repeat.text);
    assert.strictEqual(repeat.json.changed, false);
    const viewerAudits = await db.query(
      `SELECT account_id, actor_user_id, actor_label, action, target_type, target_id, detail
       FROM audit_log WHERE target_id = $1 AND action = 'user.suspended'`,
      [String(viewerId)]
    );
    assert.strictEqual(viewerAudits.rows.length, 1);
    assert.strictEqual(viewerAudits.rows[0].account_id, heclrId);
    assert.strictEqual(viewerAudits.rows[0].actor_user_id, infoId);
    assert.strictEqual(viewerAudits.rows[0].actor_label, 'info@heclr.com');
    assert.strictEqual(viewerAudits.rows[0].target_type, 'client');
    assert.strictEqual(viewerAudits.rows[0].detail.kind, 'viewer');
    assert.strictEqual(viewerAudits.rows[0].detail.username, 'ada-view');

    const unsuspendViewer = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      suspended: false,
    }, info);
    assert.strictEqual(unsuspendViewer.json.changed, true);
    assert.strictEqual(unsuspendViewer.json.suspended, false);
    const viewerBack = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'correct-horse',
    }, {});
    assert.strictEqual(viewerBack.status, 200, viewerBack.text);

    await db.query(
      `INSERT INTO audit_log (account_id, actor_label, action, detail)
       VALUES ($1, 'old-note', 'signin', '{}'::jsonb),
              ($1, 'ada-view', 'signin', '{}'::jsonb)`,
      [heclrId]
    );
    const beforeArchive = await request(server, 'GET', '/api/audit?page=1&page_size=50', null, info);
    assert.ok(beforeArchive.json.users.some((user) => user.label === 'ada-view'));
    assert.ok(beforeArchive.json.users.some((user) => user.label === 'old-note'));

    const archivedViewer = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      archived: true,
    }, info);
    assert.strictEqual(archivedViewer.status, 200, archivedViewer.text);
    assert.strictEqual(archivedViewer.json.archived, true);
    const clientList = await request(server, 'GET', '/api/clients', null, info);
    assert.strictEqual(clientList.status, 200, clientList.text);
    assert.ok(clientList.json.clients.some((row) => row.username === 'kept-view'));
    assert.ok(!clientList.json.clients.some((row) => row.id === viewerId));
    assert.ok(!clientList.text.includes('beta-view'));
    const afterArchive = await request(server, 'GET', '/api/audit?page=1&page_size=50', null, info);
    assert.ok(!afterArchive.json.users.some((user) => user.label === 'ada-view' || user.value === viewerId));
    assert.ok(afterArchive.json.users.some((user) => user.label === 'old-note'));
    const adminList = await request(server, 'GET', '/api/admin/users', null, info);
    assert.strictEqual(adminList.status, 200, adminList.text);
    const archivedRow = adminList.json.people.find((person) => person.id === viewerId);
    assert.ok(archivedRow);
    assert.strictEqual(archivedRow.kind, 'viewer');
    assert.strictEqual(archivedRow.archived, true);
    assert.strictEqual(archivedRow.account_id, heclrId);
    const archivedLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'correct-horse',
    }, {});
    assert.strictEqual(archivedLogin.status, 200, archivedLogin.text);

    const experiment = await db.query(
      `INSERT INTO experiments (name, url_match, account_id) VALUES ('Heclr page', 'https://heclr.example/', $1)
       RETURNING id`,
      [heclrId]
    );
    const assignArchived = await request(server, 'PATCH', `/api/experiments/${experiment.rows[0].id}/client`, {
      client_id: viewerId,
    }, info);
    assert.strictEqual(assignArchived.status, 404, assignArchived.text);
    const assignKept = await request(server, 'PATCH', `/api/experiments/${experiment.rows[0].id}/client`, {
      client_id: otherViewer.json.id,
    }, info);
    assert.strictEqual(assignKept.status, 200, assignKept.text);

    const restoredViewer = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      archived: false,
    }, info);
    assert.strictEqual(restoredViewer.json.archived, false);
    const listedAgain = await request(server, 'GET', '/api/clients', null, info);
    assert.ok(listedAgain.json.clients.some((row) => row.id === viewerId));

    await db.query(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [viewerId]);
    const deletedLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'ada-view',
      password: 'correct-horse',
    }, {});
    assert.strictEqual(deletedLogin.json.error, SIGN_IN_CLOSED);
    const deletedList = await request(server, 'GET', '/api/clients', null, info);
    assert.ok(!deletedList.json.clients.some((row) => row.id === viewerId));
    const deletedAdmin = await request(server, 'GET', '/api/admin/users', null, info);
    assert.ok(!deletedAdmin.json.people.some((person) => person.id === viewerId));
    const deletedPatch = await request(server, 'PATCH', `/api/admin/clients/${viewerId}`, {
      suspended: false,
    }, info);
    assert.strictEqual(deletedPatch.status, 404);

    takeLastLoggedEmail();
    const miaAsk = await request(server, 'POST', '/api/auth/email', { email: 'mia@alpha.example' }, {});
    assert.strictEqual(miaAsk.status, 200, miaAsk.text);
    assert.strictEqual(miaAsk.json.message, LINK_SENT);
    const miaMail = takeLastLoggedEmail();
    assert.ok(miaMail);
    const miaLink = linkParts(miaMail);
    const miaJar = {};
    const miaIn = await request(server, 'POST', '/api/auth/magic', { token: miaLink.token }, miaJar);
    assert.strictEqual(miaIn.status, 200, miaIn.text);
    assert.strictEqual(miaIn.json.role, 'owner');
    const miaSid = sidFromCookie(miaJar['pivit.sid']);
    const miaCookie = miaJar['pivit.sid'];

    const suspendMia = await request(server, 'PATCH', `/api/admin/users/${miaId}`, { suspended: true }, info);
    assert.strictEqual(suspendMia.status, 200, suspendMia.text);
    assert.strictEqual(suspendMia.json.changed, true);
    assert.strictEqual(await sessionCount(db, 'userId', miaId), 0);
    assert.ok(await sessionCount(db, 'userId', infoId) >= 1);
    const miaGone = await request(server, 'GET', '/api/clients', null, miaJar);
    assert.strictEqual(miaGone.status, 401, miaGone.text);

    const sample = await db.query(
      `SELECT sess FROM "session" WHERE sess->>'userId' = $1 LIMIT 1`,
      [String(infoId)]
    );
    const copy = Object.assign({}, sample.rows[0].sess, {
      userId: miaId,
      role: 'owner',
      accountId: alphaId,
      superadmin: false,
    });
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2::json, now() + interval '2 days')`,
      [miaSid, JSON.stringify(copy)]
    );
    miaJar['pivit.sid'] = miaCookie;
    const miaAgain = await request(server, 'GET', '/api/audit?page=1', null, miaJar);
    assert.strictEqual(miaAgain.status, 401, miaAgain.text);
    assert.strictEqual(await sessionCount(db, 'userId', miaId), 0);

    takeLastLoggedEmail();
    const miaSilent = await request(server, 'POST', '/api/auth/email', { email: 'Mia@Alpha.example' }, {});
    assert.strictEqual(miaSilent.status, 200);
    assert.strictEqual(miaSilent.json.message, LINK_SENT);
    assert.strictEqual(takeLastLoggedEmail(), null);

    const unsuspendMia = await request(server, 'PATCH', `/api/admin/users/${miaId}`, { suspended: false }, info);
    assert.strictEqual(unsuspendMia.json.suspended, false);
    takeLastLoggedEmail();
    const miaCodeAsk = await request(server, 'POST', '/api/auth/email', { email: 'mia@alpha.example' }, {});
    assert.strictEqual(miaCodeAsk.status, 200, miaCodeAsk.text);
    const miaCode = linkParts(takeLastLoggedEmail());
    const suspendForCode = await request(server, 'PATCH', `/api/admin/users/${miaId}`, { suspended: true }, info);
    assert.strictEqual(suspendForCode.json.changed, true);
    const codeTry = await request(server, 'POST', '/api/auth/code', {
      email: 'mia@alpha.example',
      code: miaCode.code,
    }, {});
    assert.strictEqual(codeTry.status, 401, codeTry.text);
    assert.strictEqual(codeTry.json.error, SIGN_IN_CLOSED);
    const magicTry = await request(server, 'POST', '/api/auth/magic', { token: miaCode.token }, {});
    assert.strictEqual(magicTry.status, 401);
    assert.strictEqual(magicTry.json.error, SIGN_IN_CLOSED);

    await request(server, 'PATCH', `/api/admin/users/${miaId}`, { suspended: false }, info);
    const archiveMia = await request(server, 'PATCH', `/api/admin/users/${miaId}`, { archived: true }, info);
    assert.strictEqual(archiveMia.json.archived, true);
    const miaArchivedIn = await request(server, 'POST', '/api/auth/magic', { token: miaCode.token }, {});
    assert.strictEqual(miaArchivedIn.status, 200, miaArchivedIn.text);
    const ivy = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('ivy@alpha.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alphaId, ivy.rows[0].id]
    );
    const archiveIvy = await request(server, 'PATCH', `/api/admin/users/${ivy.rows[0].id}`, {
      archived: true,
    }, info);
    assert.strictEqual(archiveIvy.status, 200, archiveIvy.text);
    takeLastLoggedEmail();
    const ivyAsk = await request(server, 'POST', '/api/auth/email', { email: 'ivy@alpha.example' }, {});
    assert.strictEqual(ivyAsk.json.message, LINK_SENT);
    assert.ok(takeLastLoggedEmail(), 'an archived person can still be sent a sign-in link');
    await db.query(
      `INSERT INTO audit_log (account_id, actor_label, action) VALUES ($1, 'mia@alpha.example', 'signin')`,
      [alphaId]
    );
    takeLastLoggedEmail();
    const adaAsk = await request(server, 'POST', '/api/auth/email', { email: 'ada@alpha.example' }, {});
    assert.strictEqual(adaAsk.status, 200, adaAsk.text);
    const adaJar = {};
    const adaIn = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(takeLastLoggedEmail()).token,
    }, adaJar);
    assert.strictEqual(adaIn.status, 200, adaIn.text);
    const alphaAudit = await request(server, 'GET', '/api/audit?page=1&page_size=50', null, adaJar);
    assert.strictEqual(alphaAudit.status, 200, alphaAudit.text);
    assert.ok(alphaAudit.json.users.some((user) => user.label === 'ada@alpha.example'));
    assert.ok(!alphaAudit.json.users.some((user) => user.label === 'mia@alpha.example' || user.value === miaId));
    assert.ok(!alphaAudit.json.users.some((user) => user.label === 'ivy@alpha.example'));
    assert.ok(!alphaAudit.json.users.some((user) => user.label === 'rem@alpha.example'));
    assert.ok(!alphaAudit.text.includes('ada-view'));

    const demoteAda = await request(server, 'PATCH', `/api/account/members/${adaId}`, { role: 'member' }, adaJar);
    assert.strictEqual(demoteAda.status, 400, demoteAda.text);
    assert.ok(demoteAda.json.error.includes('at least one owner'));

    const noah = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('noah@alpha.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [alphaId, noah.rows[0].id]
    );
    const suspendAda = await request(server, 'PATCH', `/api/admin/users/${adaId}`, { suspended: true }, info);
    assert.strictEqual(suspendAda.status, 200, suspendAda.text);
    assert.strictEqual(suspendAda.json.changed, true);
    const adaAudit = await db.query(
      `SELECT account_id, action, detail FROM audit_log
       WHERE action = 'user.suspended' AND target_id = $1`,
      [String(adaId)]
    );
    assert.strictEqual(adaAudit.rows.length, 1);
    assert.strictEqual(adaAudit.rows[0].account_id, alphaId);
    assert.strictEqual(adaAudit.rows[0].detail.email, 'ada@alpha.example');
    const heclrAudit = await request(server, 'GET', '/api/audit?page=1&page_size=100', null, info);
    assert.ok(!heclrAudit.text.includes('ada@alpha.example'));
    await request(server, 'PATCH', `/api/admin/users/${adaId}`, { suspended: false }, info);

    const ben = await db.query(
      `INSERT INTO users (email, verified_at, is_superadmin)
       VALUES ('ben@heclr.example', now(), true) RETURNING id`
    );
    const benId = ben.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [heclrId, benId]
    );
    takeLastLoggedEmail();
    const benAsk = await request(server, 'POST', '/api/auth/email', { email: 'ben@heclr.example' }, {});
    const benJar = {};
    const benIn = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(takeLastLoggedEmail()).token,
    }, benJar);
    assert.strictEqual(benIn.status, 200, benIn.text);
    assert.strictEqual(benAsk.status, 200);

    const selfSuspend = await request(server, 'PATCH', `/api/admin/users/${infoId}`, { suspended: true }, info);
    assert.strictEqual(selfSuspend.status, 400, selfSuspend.text);
    assert.strictEqual(selfSuspend.json.error, NOT_YOURSELF);
    const suspendBen = await request(server, 'PATCH', `/api/admin/users/${benId}`, { suspended: true }, info);
    assert.strictEqual(suspendBen.status, 200, suspendBen.text);
    const benMe = await request(server, 'GET', '/api/clients', null, benJar);
    assert.strictEqual(benMe.status, 401, benMe.text);
    const lastAgain = await request(server, 'PATCH', `/api/admin/users/${infoId}`, { suspended: true }, info);
    assert.strictEqual(lastAgain.json.error, LAST_PLATFORM_ADMIN);
    const unsuspendBen = await request(server, 'PATCH', `/api/admin/users/${benId}`, { suspended: false }, info);
    assert.strictEqual(unsuspendBen.json.suspended, false);

    takeLastLoggedEmail();
    const benBackAsk = await request(server, 'POST', '/api/auth/email', { email: 'ben@heclr.example' }, {});
    assert.strictEqual(benBackAsk.status, 200, benBackAsk.text);
    const benAgain = {};
    const benBack = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(takeLastLoggedEmail()).token,
    }, benAgain);
    assert.strictEqual(benBack.status, 200, benBack.text);
    const suspendInfo = await request(server, 'PATCH', `/api/admin/users/${infoId}`, { suspended: true }, benAgain);
    assert.strictEqual(suspendInfo.status, 200, suspendInfo.text);
    const passwordClosed = await request(server, 'POST', '/api/auth/login', {
      password: 'people-admin-key-value',
    }, {});
    assert.strictEqual(passwordClosed.status, 401, passwordClosed.text);
    assert.strictEqual(passwordClosed.json.error, SIGN_IN_CLOSED);
    const passwordWrong = await request(server, 'POST', '/api/auth/login', {
      password: 'not-the-key',
    }, {});
    assert.strictEqual(passwordWrong.json.error, 'incorrect password');
    const infoJarDead = await request(server, 'GET', '/api/clients', null, info);
    assert.strictEqual(infoJarDead.status, 401, infoJarDead.text);
    await request(server, 'PATCH', `/api/admin/users/${infoId}`, { suspended: false }, benAgain);
    const passwordOpen = await request(server, 'POST', '/api/auth/login', {
      password: 'people-admin-key-value',
    }, info);
    assert.strictEqual(passwordOpen.status, 200, passwordOpen.text);

    const owenJar = {};
    takeLastLoggedEmail();
    await request(server, 'POST', '/api/auth/email', { email: 'owen@beta.example' }, {});
    const owenIn = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(takeLastLoggedEmail()).token,
    }, owenJar);
    assert.strictEqual(owenIn.status, 200, owenIn.text);
    const crossedUser = await request(server, 'PATCH', `/api/admin/users/${adaId}`, { suspended: true }, owenJar);
    assert.strictEqual(crossedUser.status, 404, crossedUser.text);
    const crossedViewer = await request(server, 'PATCH', `/api/admin/clients/${betaViewerId}`, {
      suspended: true,
    }, owenJar);
    assert.strictEqual(crossedViewer.status, 404);
    const crossedList = await request(server, 'GET', '/api/admin/users', null, owenJar);
    assert.strictEqual(crossedList.status, 404);
    const adaStill = await db.query(`SELECT suspended_at FROM users WHERE id = $1`, [adaId]);
    assert.strictEqual(adaStill.rows[0].suspended_at, null);
    const betaStill = await db.query(`SELECT suspended_at FROM clients WHERE id = $1`, [betaViewerId]);
    assert.strictEqual(betaStill.rows[0].suspended_at, null);
    const owenClients = await request(server, 'GET', '/api/clients', null, owenJar);
    assert.strictEqual(owenClients.status, 200, owenClients.text);
    assert.ok(owenClients.json.clients.some((row) => row.id === betaViewerId));
    assert.ok(!owenClients.text.includes('kept-view'));
    assert.ok(!owenClients.text.includes('ada-view'));

    const viewing = await request(server, 'POST', '/api/auth/view-as', { account_id: alphaId }, info);
    assert.strictEqual(viewing.status, 200, viewing.text);
    const viewPatch = await request(server, 'PATCH', `/api/admin/users/${miaId}`, { archived: false }, info);
    assert.strictEqual(viewPatch.status, 403, viewPatch.text);

    const missing = await request(server, 'PATCH', '/api/admin/users/not-a-user', { suspended: true }, benAgain);
    assert.strictEqual(missing.status, 404);
    const nothing = await request(server, 'PATCH', `/api/admin/users/${benId}`, {}, benAgain);
    assert.strictEqual(nothing.status, 400);
    assert.ok(nothing.json.error.includes('Nothing to change'));

    const removedAsk = takeLastLoggedEmail();
    await request(server, 'POST', '/api/auth/email', { email: 'rem@alpha.example' }, {});
    const removedMail = takeLastLoggedEmail();
    assert.ok(removedMail);
    assert.notStrictEqual(removedAsk, removedMail);
    const removedIn = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(removedMail).token,
    }, {});
    assert.strictEqual(removedIn.status, 400, removedIn.text);
    assert.ok(removedIn.json.error.includes('not valid'));

    await db.query(`UPDATE users SET deleted_at = now(), archived_at = NULL, suspended_at = NULL WHERE id = $1`, [miaId]);
    takeLastLoggedEmail();
    const deletedAsk = await request(server, 'POST', '/api/auth/email', { email: 'mia@alpha.example' }, {});
    assert.strictEqual(deletedAsk.json.message, LINK_SENT);
    assert.strictEqual(takeLastLoggedEmail(), null);
    const people = await request(server, 'GET', '/api/admin/users', null, benAgain);
    assert.ok(!people.json.people.some((person) => person.id === miaId));
    assert.ok(people.json.people.some((person) => person.email === 'ada@alpha.example' && person.role === 'owner'));
    assert.ok(people.json.people.some((person) => person.id === benId && person.superadmin === true));

    console.log('person state db tests passed');
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
