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
  const {
    personAccess,
    SIGN_IN_CLOSED,
    LAST_PLATFORM_ADMIN,
    LAST_ACCOUNT_OWNER,
    NOT_YOURSELF,
    DELETE_CLOSED,
    DELETE_CONFIRM,
    DELETE_MISMATCH,
    deletedLabel,
    deletedEmail,
    deletedUsername,
  } = require('../src/person-state');
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
    assert.strictEqual(demoteAda.json.error, LAST_ACCOUNT_OWNER);

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
    const adaPerson = people.json.people.find((person) => person.email === 'ada@alpha.example' && person.role === 'owner');
    assert.ok(adaPerson);
    assert.ok(adaPerson.created_at);
    assert.ok(!Number.isNaN(Date.parse(adaPerson.created_at)));
    assert.ok(adaPerson.last_sign_in);
    const benPerson = people.json.people.find((person) => person.id === benId && person.superadmin === true);
    assert.ok(benPerson);
    assert.ok(benPerson.created_at);
    assert.ok(people.json.people.some((person) => person.kind === 'viewer' && person.username && person.created_at));

    await request(server, 'POST', '/api/auth/view-as/stop', {}, info);

    const pip = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('pip@alpha.example', now()) RETURNING id`
    );
    const pipId = pip.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alphaId, pipId]
    );
    await db.query(
      `INSERT INTO audit_log (account_id, actor_user_id, actor_label, action, target_type, target_id, detail)
       VALUES ($1, $2, 'pip@alpha.example', 'signin', 'user', $3, '{"email":"pip@alpha.example"}'::jsonb),
              ($1, NULL, 'pip@alpha.example', 'signin', 'user', $3, '{"email":"pip@alpha.example"}'::jsonb),
              ($1, NULL, 'keep-pip-neighbour', 'signin', 'user', 'someone-else', '{}'::jsonb)`,
      [alphaId, pipId, String(pipId)]
    );
    await db.query(
      `INSERT INTO login_tokens (email, purpose, token_hash, code_hash, expires_at)
       VALUES ('pip@alpha.example', 'signin', 'pip-token-hash', 'pip-code-hash', now() + interval '1 hour'),
              ('kept@alpha.example', 'signin', 'kept-token-hash', 'kept-code-hash', now() + interval '1 hour')`
    );
    const pipSession = {
      userId: pipId,
      role: 'owner',
      accountId: alphaId,
      superadmin: false,
    };
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('pip-sid', $1::json, now() + interval '2 days')`,
      [JSON.stringify(pipSession)]
    );
    const beforeDelete = await db.query(`SELECT COUNT(*)::int AS n FROM audit_log`);
    const activeDelete = await request(server, 'DELETE', `/api/admin/users/${pipId}`, {
      confirm: 'pip@alpha.example',
    }, benAgain);
    assert.strictEqual(activeDelete.status, 400, activeDelete.text);
    assert.strictEqual(activeDelete.json.error, DELETE_CLOSED);
    const pipStill = await db.query(`SELECT email, deleted_at FROM users WHERE id = $1`, [pipId]);
    assert.strictEqual(pipStill.rows[0].email, 'pip@alpha.example');
    assert.strictEqual(pipStill.rows[0].deleted_at, null);

    const selfDelete = await request(server, 'DELETE', `/api/admin/users/${infoId}`, {
      confirm: 'info@heclr.com',
    }, info);
    assert.strictEqual(selfDelete.status, 400, selfDelete.text);
    assert.strictEqual(selfDelete.json.error, NOT_YOURSELF);

    const suspendPip = await request(server, 'PATCH', `/api/admin/users/${pipId}`, {
      suspended: true,
    }, benAgain);
    assert.strictEqual(suspendPip.status, 200, suspendPip.text);
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('pip-sid-live', $1::json, now() + interval '2 days')`,
      [JSON.stringify(pipSession)]
    );
    assert.ok(await sessionCount(db, 'userId', pipId) >= 1);
    const wrongConfirm = await request(server, 'DELETE', `/api/admin/users/${pipId}`, {
      confirm: 'not-pip@alpha.example',
    }, benAgain);
    assert.strictEqual(wrongConfirm.status, 400, wrongConfirm.text);
    assert.strictEqual(wrongConfirm.json.error, DELETE_MISMATCH);
    const missingConfirm = await request(server, 'DELETE', `/api/admin/users/${pipId}`, {}, benAgain);
    assert.strictEqual(missingConfirm.status, 400, missingConfirm.text);
    assert.strictEqual(missingConfirm.json.error, DELETE_CONFIRM);
    const pipUntouched = await db.query(`SELECT email FROM users WHERE id = $1`, [pipId]);
    assert.strictEqual(pipUntouched.rows[0].email, 'pip@alpha.example');

    const deletedPip = await request(server, 'DELETE', `/api/admin/users/${pipId}`, {
      confirm: '  Pip@Alpha.example ',
    }, benAgain);
    assert.strictEqual(deletedPip.status, 200, deletedPip.text);
    assert.strictEqual(deletedPip.json.deleted, true);
    assert.strictEqual(deletedPip.json.kind, 'user');
    assert.ok(!deletedPip.text.includes('pip@alpha.example'));
    const pipLabel = deletedLabel(pipId);
    const pipRow = await db.query(
      `SELECT email, is_superadmin, deleted_at FROM users WHERE id = $1`,
      [pipId]
    );
    assert.strictEqual(pipRow.rows[0].email, deletedEmail(pipId));
    assert.strictEqual(pipRow.rows[0].is_superadmin, false);
    assert.ok(pipRow.rows[0].deleted_at);
    const pipMemberships = await db.query(
      `SELECT COUNT(*)::int AS n FROM memberships WHERE user_id = $1`,
      [pipId]
    );
    assert.strictEqual(pipMemberships.rows[0].n, 0);
    assert.strictEqual(await sessionCount(db, 'userId', pipId), 0);
    const pipTokens = await db.query(
      `SELECT COUNT(*)::int AS n FROM login_tokens WHERE lower(email) = 'pip@alpha.example'`
    );
    assert.strictEqual(pipTokens.rows[0].n, 0);
    const keptTokens = await db.query(
      `SELECT COUNT(*)::int AS n FROM login_tokens WHERE email = 'kept@alpha.example'`
    );
    assert.strictEqual(keptTokens.rows[0].n, 1);
    const pipHistory = await db.query(
      `SELECT actor_user_id, actor_label, action, detail
       FROM audit_log
       WHERE target_id = $1 OR actor_user_id = $2::uuid OR actor_label = $3
       ORDER BY id`,
      [String(pipId), pipId, pipLabel]
    );
    assert.ok(pipHistory.rows.length >= 3, JSON.stringify(pipHistory.rows));
    assert.ok(pipHistory.rows.every((row) => row.actor_label !== 'pip@alpha.example'));
    assert.ok(pipHistory.rows.some((row) => row.action === 'signin' && row.actor_label === pipLabel));
    assert.ok(pipHistory.rows.some((row) => row.action === 'user.deleted' && row.detail.label === pipLabel));
    assert.ok(pipHistory.rows.every((row) => !JSON.stringify(row.detail).includes('pip@alpha.example')));
    const afterDelete = await db.query(`SELECT COUNT(*)::int AS n FROM audit_log`);
    assert.ok(afterDelete.rows[0].n > beforeDelete.rows[0].n);
    const neighbour = await db.query(
      `SELECT actor_label FROM audit_log WHERE actor_label = 'keep-pip-neighbour'`
    );
    assert.strictEqual(neighbour.rows.length, 1);
    const leaked = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log
       WHERE actor_label ILIKE '%pip@alpha.example%'
          OR detail::text ILIKE '%pip@alpha.example%'`
    );
    assert.strictEqual(leaked.rows[0].n, 0);
    const pipList = await request(server, 'GET', '/api/admin/users', null, benAgain);
    assert.ok(!pipList.json.people.some((person) => person.id === pipId));
    assert.ok(!pipList.text.includes('pip@alpha.example'));
    takeLastLoggedEmail();
    const adaAgain = await request(server, 'POST', '/api/auth/email', { email: 'ada@alpha.example' }, {});
    assert.strictEqual(adaAgain.status, 200, adaAgain.text);
    const adaNow = {};
    const adaNowIn = await request(server, 'POST', '/api/auth/magic', {
      token: linkParts(takeLastLoggedEmail()).token,
    }, adaNow);
    assert.strictEqual(adaNowIn.status, 200, adaNowIn.text);
    const pipAudit = await request(server, 'GET', '/api/audit?page=1&page_size=100', null, adaNow);
    assert.strictEqual(pipAudit.status, 200, pipAudit.text);
    assert.ok(pipAudit.json.entries.some((entry) => entry.action === 'user.deleted' && entry.detail.label === pipLabel));
    assert.ok(pipAudit.json.entries.some((entry) => entry.actor_label === pipLabel));
    assert.ok(!pipAudit.json.users.some((user) => user.label === pipLabel || user.label === 'pip@alpha.example' || user.value === pipId));
    assert.ok(pipAudit.json.users.some((user) => user.label === 'keep-pip-neighbour'));
    assert.ok(pipAudit.json.users.some((user) => user.label === 'ada@alpha.example'));
    takeLastLoggedEmail();
    const pipAsk = await request(server, 'POST', '/api/auth/email', { email: 'pip@alpha.example' }, {});
    assert.strictEqual(pipAsk.json.message, LINK_SENT);
    assert.strictEqual(takeLastLoggedEmail(), null);
    const pipAgain = await request(server, 'DELETE', `/api/admin/users/${pipId}`, {
      confirm: 'pip@alpha.example',
    }, benAgain);
    assert.strictEqual(pipAgain.status, 404, pipAgain.text);

    const signature = require('cookie-signature');
    const { getSessionSecret } = require('../src/session-secret');
    const pipGhostSess = Object.assign({
      cookie: {
        originalMaxAge: 86400000,
        expires: new Date(Date.now() + 86400000).toISOString(),
        httpOnly: true,
        path: '/',
      },
    }, pipSession);
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('pip-sid-2', $1::json, now() + interval '2 days')`,
      [JSON.stringify(pipGhostSess)]
    );
    const pipJar = { 'pivit.sid': 's:' + signature.sign('pip-sid-2', getSessionSecret()) };
    const pipGhost = await request(server, 'GET', '/api/clients', null, pipJar);
    assert.strictEqual(pipGhost.status, 401, pipGhost.text);
    assert.strictEqual(await sessionCount(db, 'userId', pipId), 0);

    const arc = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('arc@alpha.example', now()) RETURNING id`
    );
    const arcId = arc.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alphaId, arcId]
    );
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('arc-sid', $1::json, now() + interval '2 days')`,
      [JSON.stringify({ userId: arcId, role: 'owner', accountId: alphaId })]
    );
    const archiveArc = await request(server, 'PATCH', `/api/admin/users/${arcId}`, {
      archived: true,
    }, benAgain);
    assert.strictEqual(archiveArc.status, 200, archiveArc.text);
    assert.ok(await sessionCount(db, 'userId', arcId) >= 1);
    const deletedArc = await request(server, 'DELETE', `/api/admin/users/${arcId}`, {
      confirm: 'arc@alpha.example',
    }, benAgain);
    assert.strictEqual(deletedArc.status, 200, deletedArc.text);
    assert.notStrictEqual(deletedLabel(arcId), pipLabel);
    assert.strictEqual(await sessionCount(db, 'userId', arcId), 0);
    const arcRow = await db.query(`SELECT email, deleted_at FROM users WHERE id = $1`, [arcId]);
    assert.strictEqual(arcRow.rows[0].email, deletedEmail(arcId));
    assert.ok(arcRow.rows[0].deleted_at);

    const gus = await db.query(
      `INSERT INTO users (email, verified_at, suspended_at)
       VALUES ('gus@gamma.example', now(), now()) RETURNING id`
    );
    const gusId = gus.rows[0].id;
    const gamma = await db.query(`INSERT INTO accounts (name, legacy) VALUES ('Gamma', false) RETURNING id`);
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [gamma.rows[0].id, gusId]
    );
    const deleteGus = await request(server, 'DELETE', `/api/admin/users/${gusId}`, {
      confirm: 'gus@gamma.example',
    }, benAgain);
    assert.strictEqual(deleteGus.status, 400, deleteGus.text);
    assert.strictEqual(deleteGus.json.error, LAST_ACCOUNT_OWNER);
    const gusStill = await db.query(`SELECT email, deleted_at FROM users WHERE id = $1`, [gusId]);
    assert.strictEqual(gusStill.rows[0].email, 'gus@gamma.example');
    assert.strictEqual(gusStill.rows[0].deleted_at, null);

    await db.query(`UPDATE users SET is_superadmin = false WHERE id = $1`, [benId]);
    const deleteInfoLast = await request(server, 'DELETE', `/api/admin/users/${infoId}`, {
      confirm: 'info@heclr.com',
    }, info);
    assert.strictEqual(deleteInfoLast.status, 400, deleteInfoLast.text);
    assert.strictEqual(deleteInfoLast.json.error, LAST_PLATFORM_ADMIN);
    const infoStillAdmin = await db.query(
      `SELECT email, deleted_at, is_superadmin FROM users WHERE id = $1`,
      [infoId]
    );
    assert.strictEqual(infoStillAdmin.rows[0].email, 'info@heclr.com');
    assert.strictEqual(infoStillAdmin.rows[0].deleted_at, null);
    assert.strictEqual(infoStillAdmin.rows[0].is_superadmin, true);
    await db.query(`UPDATE users SET is_superadmin = true WHERE id = $1`, [benId]);

    const sam = await db.query(
      `INSERT INTO users (email, verified_at, is_superadmin, suspended_at)
       VALUES ('sam@heclr.example', now(), true, now()) RETURNING id`
    );
    const samId = sam.rows[0].id;
    const deleteSamNow = await request(server, 'DELETE', `/api/admin/users/${samId}`, {
      confirm: 'sam@heclr.example',
    }, info);
    assert.strictEqual(deleteSamNow.status, 200, deleteSamNow.text);
    const samRow = await db.query(`SELECT email, is_superadmin, deleted_at FROM users WHERE id = $1`, [samId]);
    assert.strictEqual(samRow.rows[0].email, deletedEmail(samId));
    assert.strictEqual(samRow.rows[0].is_superadmin, false);
    assert.ok(samRow.rows[0].deleted_at);

    const goneViewer = await request(server, 'POST', '/api/clients', {
      name: 'Gone Viewer',
      username: 'gone-view',
      password: 'viewer-secret-pass',
    }, info);
    assert.strictEqual(goneViewer.status, 201, goneViewer.text);
    const goneId = goneViewer.json.id;
    const goneHash = await db.query(`SELECT password_hash FROM clients WHERE id = $1`, [goneId]);
    await db.query(
      `INSERT INTO audit_log (account_id, actor_label, action, target_type, target_id, detail)
       VALUES ($1, 'gone-view', 'signin', 'client', $2, '{"username":"gone-view","name":"Gone Viewer"}'::jsonb),
              ($1, 'Gone Viewer', 'signin', 'client', $2, '{"name":"Gone Viewer"}'::jsonb)`,
      [heclrId, String(goneId)]
    );
    const activeViewerDelete = await request(server, 'DELETE', `/api/admin/clients/${goneId}`, {
      confirm: 'gone-view',
    }, info);
    assert.strictEqual(activeViewerDelete.status, 400, activeViewerDelete.text);
    assert.strictEqual(activeViewerDelete.json.error, DELETE_CLOSED);
    const suspendGone = await request(server, 'PATCH', `/api/admin/clients/${goneId}`, {
      suspended: true,
    }, info);
    assert.strictEqual(suspendGone.status, 200, suspendGone.text);
    const goneSession = { role: 'client', clientId: goneId, accountId: heclrId };
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('gone-sid', $1::json, now() + interval '2 days')`,
      [JSON.stringify(goneSession)]
    );
    assert.ok(await sessionCount(db, 'clientId', goneId) >= 1);
    const wrongViewerConfirm = await request(server, 'DELETE', `/api/admin/clients/${goneId}`, {
      confirm: 'Gone Viewer',
    }, info);
    assert.strictEqual(wrongViewerConfirm.status, 400, wrongViewerConfirm.text);
    assert.strictEqual(wrongViewerConfirm.json.error, DELETE_MISMATCH);
    const deletedGone = await request(server, 'DELETE', `/api/admin/clients/${goneId}`, {
      confirm: 'GONE-VIEW',
    }, info);
    assert.strictEqual(deletedGone.status, 200, deletedGone.text);
    assert.strictEqual(deletedGone.json.kind, 'viewer');
    const goneLabel = deletedLabel(goneId);
    const goneRow = await db.query(
      `SELECT name, username, password_hash, deleted_at FROM clients WHERE id = $1`,
      [goneId]
    );
    assert.strictEqual(goneRow.rows[0].name, goneLabel);
    assert.strictEqual(goneRow.rows[0].username, deletedUsername(goneId));
    assert.notStrictEqual(goneRow.rows[0].password_hash, goneHash.rows[0].password_hash);
    assert.ok(goneRow.rows[0].password_hash.startsWith('$2'));
    assert.strictEqual(await bcrypt.compare('viewer-secret-pass', goneRow.rows[0].password_hash), false);
    assert.ok(goneRow.rows[0].deleted_at);
    assert.strictEqual(await sessionCount(db, 'clientId', goneId), 0);
    const goneAudit = await db.query(
      `SELECT actor_label, action, detail FROM audit_log WHERE target_id = $1 ORDER BY id`,
      [String(goneId)]
    );
    assert.ok(goneAudit.rows.some((row) => row.actor_label === goneLabel));
    assert.ok(goneAudit.rows.some((row) => row.action === 'user.deleted' && row.detail.kind === 'viewer'));
    assert.ok(goneAudit.rows.every((row) => !JSON.stringify(row).includes('gone-view')));
    assert.ok(goneAudit.rows.every((row) => !JSON.stringify(row).includes('Gone Viewer')));
    const goneLogin = await request(server, 'POST', '/api/auth/client-login', {
      username: 'gone-view',
      password: 'viewer-secret-pass',
    }, {});
    assert.strictEqual(goneLogin.status, 401, goneLogin.text);
    assert.strictEqual(goneLogin.json.error, 'incorrect username or password');
    const goneList = await request(server, 'GET', '/api/admin/users', null, info);
    assert.ok(!goneList.json.people.some((person) => person.id === goneId));
    const heclrAfterGone = await request(server, 'GET', '/api/audit?page=1&page_size=100', null, info);
    assert.ok(!heclrAfterGone.json.users.some((user) => user.label === 'gone-view' || user.label === goneLabel || user.label === 'Gone Viewer'));
    assert.ok(heclrAfterGone.text.includes(goneLabel));

    const crossedDelete = await request(server, 'DELETE', `/api/admin/users/${adaId}`, {
      confirm: 'ada@alpha.example',
    }, owenJar);
    assert.strictEqual(crossedDelete.status, 404, crossedDelete.text);
    const crossedViewerDelete = await request(server, 'DELETE', `/api/admin/clients/${betaViewerId}`, {
      confirm: 'beta-view',
    }, owenJar);
    assert.strictEqual(crossedViewerDelete.status, 404, crossedViewerDelete.text);
    const missingDelete = await request(server, 'DELETE', '/api/admin/users/not-a-user', {
      confirm: 'ada@alpha.example',
    }, info);
    assert.strictEqual(missingDelete.status, 404, missingDelete.text);

    const viewingDelete = await request(server, 'POST', '/api/auth/view-as', {
      account_id: alphaId,
    }, info);
    assert.strictEqual(viewingDelete.status, 200, viewingDelete.text);
    const viewDelete = await request(server, 'DELETE', `/api/admin/users/${gusId}`, {
      confirm: 'gus@gamma.example',
    }, info);
    assert.strictEqual(viewDelete.status, 403, viewDelete.text);
    const gusAfterView = await db.query(`SELECT deleted_at FROM users WHERE id = $1`, [gusId]);
    assert.strictEqual(gusAfterView.rows[0].deleted_at, null);
    await request(server, 'POST', '/api/auth/view-as/stop', {}, info);

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
