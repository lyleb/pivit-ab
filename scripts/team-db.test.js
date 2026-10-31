// Agency Team: list, role, remove, and Viewer access. Another agency is 404.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'user-agent': 'Mozilla/5.0 (compatible; pivitlab-check)' },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text && res.headers['content-type'] && res.headers['content-type'].includes('json')) {
          json = JSON.parse(text);
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function appFor(session) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session;
    req.ip = '127.0.0.1';
    next();
  });
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/account/members', require('../src/routes/members'));
  app.use('/api/clients', require('../src/routes/clients'));
  app.use('/api/admin', require('../src/routes/people'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function sessionFor(userId, accountId) {
  return { role: 'owner', userId, accountId, customer: true, superadmin: false };
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('team db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_team_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'team-session-secret-value-32chars';
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { LAST_ACCOUNT_OWNER, NOT_YOURSELF, SIGN_IN_CLOSED } = require('../src/person-state');
  const servers = [];

  try {
    await migrate();

    async function makeAccount(name) {
      const account = await db.query(
        `INSERT INTO accounts (name, legacy) VALUES ($1, false) RETURNING id`,
        [name]
      );
      return account.rows[0].id;
    }

    async function makeUser(email, accountId, role) {
      const user = await db.query(
        `INSERT INTO users (email, verified_at) VALUES ($1, now()) RETURNING id`,
        [email]
      );
      await db.query(
        `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, $3)`,
        [accountId, user.rows[0].id, role]
      );
      return user.rows[0].id;
    }

    const alphaId = await makeAccount('Alpha Agency');
    const betaId = await makeAccount('Beta Agency');
    const ada = await makeUser('ada@alpha.example', alphaId, 'owner');
    const noah = await makeUser('noah@alpha.example', alphaId, 'member');
    const bea = await makeUser('bea@beta.example', betaId, 'owner');
    const shared = await makeUser('shared@example.co.uk', betaId, 'member');
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alphaId, shared]
    );

    const alpha = await listen(appFor(sessionFor(ada, alphaId)));
    const member = await listen(appFor(sessionFor(noah, alphaId)));
    const sharedAlpha = await listen(appFor(sessionFor(shared, alphaId)));
    const sharedBeta = await listen(appFor(sessionFor(shared, betaId)));
    const beta = await listen(appFor(sessionFor(bea, betaId)));
    servers.push(alpha, member, sharedAlpha, sharedBeta, beta);

    const listed = await request(alpha, 'GET', '/api/account/members');
    assert.strictEqual(listed.status, 200, listed.text);
    const emails = listed.json.people.filter((person) => person.kind === 'user').map((person) => person.email);
    assert.deepStrictEqual(emails.sort(), ['ada@alpha.example', 'noah@alpha.example', 'shared@example.co.uk'].sort());
    assert.strictEqual(listed.json.people.find((person) => person.email === 'shared@example.co.uk').role, 'member');
    assert.ok(!listed.text.includes('bea@beta.example'));
    assert.ok(!listed.text.includes(betaId));

    const asMember = await request(member, 'GET', '/api/account/members');
    assert.strictEqual(asMember.status, 200, asMember.text);
    assert.ok(asMember.json.people.some((person) => person.email === 'ada@alpha.example'));
    assert.ok(!asMember.text.includes('bea@beta.example'));

    const onBeta = await request(sharedBeta, 'GET', '/api/account/members');
    assert.strictEqual(onBeta.json.people.find((person) => person.email === 'shared@example.co.uk').role, 'member');
    assert.ok(onBeta.json.people.some((person) => person.email === 'bea@beta.example' && person.role === 'owner'));
    assert.ok(!onBeta.text.includes('ada@alpha.example'));
    assert.ok(!onBeta.text.includes('noah@alpha.example'));

    const betaList = await request(beta, 'GET', '/api/account/members');
    assert.ok(!betaList.text.includes('ada@alpha.example'));
    assert.ok(!betaList.text.includes(ada));
    assert.ok(!betaList.text.includes(noah));

    const created = await request(alpha, 'POST', '/api/clients', {
      name: 'Northwind',
      username: 'north',
      password: 'password1',
    });
    assert.strictEqual(created.status, 201, created.text);
    assert.ok(!created.text.includes('password1'));
    const viewerId = created.json.id;
    const createdAudit = await db.query(
      `SELECT action, detail FROM audit_log WHERE action = 'viewer.created' AND target_id = $1`,
      [String(viewerId)]
    );
    assert.strictEqual(createdAudit.rows.length, 1);
    assert.strictEqual(createdAudit.rows[0].detail.username, 'north');
    assert.ok(!JSON.stringify(createdAudit.rows[0].detail).includes('password1'));

    const memberCreate = await request(member, 'POST', '/api/clients', {
      name: 'Nope',
      username: 'nope-view',
      password: 'password1',
    });
    assert.strictEqual(memberCreate.status, 403, memberCreate.text);
    const nope = await db.query(`SELECT id FROM clients WHERE username = 'nope-view'`);
    assert.strictEqual(nope.rows.length, 0);

    const withViewer = await request(alpha, 'GET', '/api/account/members');
    assert.ok(withViewer.json.people.some((person) => person.kind === 'viewer' && person.username === 'north'));
    const betaAfterCreate = await request(beta, 'GET', '/api/account/members');
    assert.ok(!betaAfterCreate.text.includes('north'));
    assert.ok(!betaAfterCreate.text.includes(viewerId));

    const edited = await request(alpha, 'PATCH', `/api/clients/${viewerId}`, {
      name: 'Northwind Ltd',
      username: 'northwind',
    });
    assert.strictEqual(edited.status, 200, edited.text);
    assert.strictEqual(edited.json.username, 'northwind');
    const editAudit = await db.query(
      `SELECT detail FROM audit_log WHERE action = 'viewer.updated' AND target_id = $1`,
      [String(viewerId)]
    );
    assert.strictEqual(editAudit.rows[0].detail.from_username, 'north');
    assert.strictEqual(editAudit.rows[0].detail.username, 'northwind');

    const reset = await request(alpha, 'PATCH', `/api/clients/${viewerId}`, { password: 'password2' });
    assert.strictEqual(reset.status, 200, reset.text);
    assert.ok(!reset.text.includes('password2'));
    const resetAudit = await db.query(
      `SELECT detail::text AS detail FROM audit_log WHERE action = 'viewer.password_reset' AND target_id = $1`,
      [String(viewerId)]
    );
    assert.strictEqual(resetAudit.rows.length, 1);
    assert.ok(!resetAudit.rows[0].detail.includes('password2'));
    assert.ok(!resetAudit.rows[0].detail.includes('password_hash'));

    const memberEdit = await request(member, 'PATCH', `/api/clients/${viewerId}`, { name: 'Hacked' });
    assert.strictEqual(memberEdit.status, 403, memberEdit.text);
    const memberReset = await request(member, 'PATCH', `/api/clients/${viewerId}`, { password: 'password3' });
    assert.strictEqual(memberReset.status, 403, memberReset.text);

    await db.query(
      `INSERT INTO "session" (sid, sess, expire)
       VALUES ('viewer-sid', $1::json, now() + interval '1 day')`,
      [JSON.stringify({ clientId: viewerId, role: 'client', accountId: alphaId })]
    );
    const suspended = await request(alpha, 'PATCH', `/api/clients/${viewerId}/access`, { suspended: true });
    assert.strictEqual(suspended.status, 200, suspended.text);
    assert.strictEqual(suspended.json.suspended, true);
    assert.strictEqual(suspended.json.kind, 'viewer');
    const viewerRow = await db.query(`SELECT suspended_at, archived_at FROM clients WHERE id = $1`, [viewerId]);
    assert.ok(viewerRow.rows[0].suspended_at);
    const viewerSession = await db.query(`SELECT sid FROM "session" WHERE sid = 'viewer-sid'`);
    assert.strictEqual(viewerSession.rows.length, 0);
    const suspendAudit = await db.query(
      `SELECT action, detail FROM audit_log
       WHERE target_id = $1 AND action = 'user.suspended'`,
      [String(viewerId)]
    );
    assert.strictEqual(suspendAudit.rows[0].detail.kind, 'viewer');

    const login = await request(alpha, 'POST', '/api/auth/client-login', {
      username: 'northwind',
      password: 'password2',
    });
    assert.strictEqual(login.status, 401, login.text);
    assert.strictEqual(login.json.error, SIGN_IN_CLOSED);

    const unsuspended = await request(alpha, 'PATCH', `/api/clients/${viewerId}/access`, { suspended: false });
    assert.strictEqual(unsuspended.json.suspended, false);
    const archived = await request(alpha, 'PATCH', `/api/clients/${viewerId}/access`, { archived: true });
    assert.strictEqual(archived.json.archived, true);
    const clientList = await request(alpha, 'GET', '/api/clients');
    assert.ok(!clientList.json.clients.some((row) => row.id === viewerId));
    const hidden = await request(alpha, 'GET', '/api/account/members');
    assert.ok(hidden.json.people.some((person) => person.id === viewerId && person.archived === true));
    const restored = await request(alpha, 'PATCH', `/api/clients/${viewerId}/access`, { archived: false });
    assert.strictEqual(restored.json.archived, false);
    const visible = await request(alpha, 'GET', '/api/clients');
    assert.ok(visible.json.clients.some((row) => row.id === viewerId));

    const crossed = await request(beta, 'PATCH', `/api/clients/${viewerId}/access`, { suspended: true });
    assert.strictEqual(crossed.status, 404, crossed.text);
    const stillOpen = await db.query(`SELECT suspended_at FROM clients WHERE id = $1`, [viewerId]);
    assert.strictEqual(stillOpen.rows[0].suspended_at, null);
    const crossedEdit = await request(beta, 'PATCH', `/api/clients/${viewerId}`, { name: 'Hacked' });
    assert.strictEqual(crossedEdit.status, 404, crossedEdit.text);
    const crossedName = await db.query(`SELECT name FROM clients WHERE id = $1`, [viewerId]);
    assert.strictEqual(crossedName.rows[0].name, 'Northwind Ltd');

    const missing = await request(alpha, 'PATCH', '/api/clients/00000000-0000-4000-8000-000000000099/access', {
      suspended: true,
    });
    assert.strictEqual(missing.status, 404, missing.text);
    const badFlag = await request(alpha, 'PATCH', `/api/clients/${viewerId}/access`, { suspended: 'yes' });
    assert.strictEqual(badFlag.status, 400, badFlag.text);

    const memberRemoveEarly = await request(member, 'DELETE', `/api/account/members/${shared}`);
    assert.strictEqual(memberRemoveEarly.status, 403, memberRemoveEarly.text);
    const suspendUser = await request(alpha, 'PATCH', `/api/account/members/${shared}`, { suspended: true });
    assert.strictEqual(suspendUser.status, 400, suspendUser.text);
    const sharedUser = await db.query(`SELECT suspended_at FROM users WHERE id = $1`, [shared]);
    assert.strictEqual(sharedUser.rows[0].suspended_at, null);

    const promote = await request(alpha, 'PATCH', `/api/account/members/${noah}`, { role: 'owner' });
    assert.strictEqual(promote.status, 200, promote.text);
    assert.strictEqual(promote.json.role, 'owner');
    const demoteSelf = await request(alpha, 'PATCH', `/api/account/members/${ada}`, { role: 'member' });
    assert.strictEqual(demoteSelf.status, 200, demoteSelf.text);
    const lastOwner = await request(member, 'PATCH', `/api/account/members/${noah}`, { role: 'member' });
    assert.strictEqual(lastOwner.status, 400, lastOwner.text);
    assert.strictEqual(lastOwner.json.error, LAST_ACCOUNT_OWNER);
    await request(member, 'PATCH', `/api/account/members/${ada}`, { role: 'owner' });

    const removeSelf = await request(alpha, 'DELETE', `/api/account/members/${ada}`);
    assert.strictEqual(removeSelf.status, 400, removeSelf.text);
    assert.strictEqual(removeSelf.json.error, NOT_YOURSELF);
    const removeNoah = await request(alpha, 'DELETE', `/api/account/members/${noah}`);
    assert.strictEqual(removeNoah.status, 200, removeNoah.text);
    const removeLast = await request(alpha, 'DELETE', `/api/account/members/${ada}`);
    assert.strictEqual(removeLast.status, 400, removeLast.text);
    assert.strictEqual(removeLast.json.error, LAST_ACCOUNT_OWNER);
    const noahClosed = await request(member, 'GET', '/api/account/members');
    assert.strictEqual(noahClosed.status, 401, noahClosed.text);
    const adaRole = await db.query(
      `SELECT role, removed_at FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alphaId, ada]
    );
    assert.strictEqual(adaRole.rows[0].role, 'owner');
    assert.strictEqual(adaRole.rows[0].removed_at, null);

    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES
         ('shared-alpha', $1::json, now() + interval '1 day'),
         ('shared-beta', $2::json, now() + interval '1 day')`,
      [
        JSON.stringify({ userId: shared, role: 'owner', accountId: alphaId }),
        JSON.stringify({ userId: shared, role: 'owner', accountId: betaId }),
      ]
    );
    const removed = await request(alpha, 'DELETE', `/api/account/members/${shared}`);
    assert.strictEqual(removed.status, 200, removed.text);
    assert.strictEqual(removed.json.removed, true);
    const membership = await db.query(
      `SELECT removed_at IS NOT NULL AS gone FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alphaId, shared]
    );
    assert.strictEqual(membership.rows[0].gone, true);
    const userRow = await db.query(
      `SELECT email, suspended_at, archived_at, deleted_at FROM users WHERE id = $1`,
      [shared]
    );
    assert.strictEqual(userRow.rows[0].email, 'shared@example.co.uk');
    assert.strictEqual(userRow.rows[0].suspended_at, null);
    assert.strictEqual(userRow.rows[0].archived_at, null);
    assert.strictEqual(userRow.rows[0].deleted_at, null);
    const otherMembership = await db.query(
      `SELECT role, removed_at FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [betaId, shared]
    );
    assert.strictEqual(otherMembership.rows[0].role, 'member');
    assert.strictEqual(otherMembership.rows[0].removed_at, null);
    const sessions = await db.query(
      `SELECT sid FROM "session" WHERE sid IN ('shared-alpha', 'shared-beta') ORDER BY sid`
    );
    assert.deepStrictEqual(sessions.rows.map((row) => row.sid), ['shared-beta']);
    const removalAudit = await db.query(
      `SELECT action, detail, account_id FROM audit_log
       WHERE action = 'membership.removed' AND target_id = $1`,
      [String(shared)]
    );
    assert.strictEqual(removalAudit.rows.length, 1);
    assert.strictEqual(removalAudit.rows[0].account_id, alphaId);
    assert.strictEqual(removalAudit.rows[0].detail.email, 'shared@example.co.uk');
    const notSuspended = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE target_id = $1 AND action LIKE 'user.%'`,
      [String(shared)]
    );
    assert.strictEqual(notSuspended.rows[0].n, 0);

    const goneList = await request(alpha, 'GET', '/api/account/members');
    assert.ok(!goneList.json.people.some((person) => person.id === shared));
    const stillThere = await request(sharedAlpha, 'GET', '/api/account/members');
    assert.strictEqual(stillThere.status, 401, stillThere.text);
    const otherAgency = await request(sharedBeta, 'GET', '/api/clients');
    assert.strictEqual(otherAgency.status, 200, otherAgency.text);

    const crossRemove = await request(beta, 'DELETE', `/api/account/members/${ada}`);
    assert.strictEqual(crossRemove.status, 404, crossRemove.text);
    const crossRole = await request(beta, 'PATCH', `/api/account/members/${noah}`, { role: 'member' });
    assert.strictEqual(crossRole.status, 404, crossRole.text);
    const noahRow = await db.query(
      `SELECT role, removed_at FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alphaId, noah]
    );
    assert.strictEqual(noahRow.rows[0].role, 'owner');
    assert.ok(noahRow.rows[0].removed_at);

    const adminUsers = await request(alpha, 'GET', '/api/admin/users');
    assert.strictEqual(adminUsers.status, 404, adminUsers.text);
    const adminSuspend = await request(alpha, 'PATCH', `/api/admin/users/${noah}`, { suspended: true });
    assert.strictEqual(adminSuspend.status, 404, adminSuspend.text);

    const viewerServer = await listen(appFor({
      role: 'client',
      clientId: viewerId,
      accountId: alphaId,
    }));
    servers.push(viewerServer);
    const viewerList = await request(viewerServer, 'GET', '/api/account/members');
    assert.strictEqual(viewerList.status, 401, viewerList.text);

    console.log('team db tests passed');
  } finally {
    servers.forEach((server) => server.close());
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
