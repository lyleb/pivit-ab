// Audit log back-fill, role changes, filters, pagination and account isolation.
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
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
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
    req.ip = '203.0.113.8';
    next();
  });
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/account/members', require('../src/routes/members'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('audit log db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_audit_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyAuditBackfill } = require('../src/db/audit-backfill');
  const traffic = require('../src/test-traffic');

  const servers = [];
  try {
    const applied = await migrate();
    assert.ok(applied.includes('014'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);

    async function makeAccount(name, email) {
      const account = await db.query(
        `INSERT INTO accounts (name, legacy) VALUES ($1, false) RETURNING id`,
        [name]
      );
      const user = await db.query(
        `INSERT INTO users (email, verified_at) VALUES ($1, now()) RETURNING id`,
        [email]
      );
      await db.query(
        `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [account.rows[0].id, user.rows[0].id]
      );
      return { id: account.rows[0].id, userId: user.rows[0].id, email };
    }

    const alpha = await makeAccount('Alpha Ltd', 'owner-a@alpha.example');
    const beta = await makeAccount('Beta Ltd', 'owner-b@beta.example');
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member-a@alpha.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alpha.id, member.rows[0].id]
    );
    const betaMember = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member-b@beta.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [beta.id, betaMember.rows[0].id]
    );

    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, status, account_id)
       VALUES ('Alpha pricing', 'https://alpha.example/pricing', 'running', $1)
       RETURNING id`,
      [alpha.id]
    );
    const experimentId = exp.rows[0].id;
    const otherExp = await db.query(
      `INSERT INTO experiments (name, url_match, status, account_id)
       VALUES ('Beta pricing', 'https://beta.example/pricing', 'running', $1)
       RETURNING id`,
      [beta.id]
    );
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
      [experimentId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, is_test)
       VALUES ($1, $2, 'v_audit_prefix_1', 'view', true)`,
      [experimentId, variant.rows[0].id]
    );

    const oldTable = await db.query(
      `INSERT INTO test_traffic_audit (experiment_id, action, actor, criteria, visitor_count, event_count)
       VALUES ($1, 'remove', 'owner', '{"mode":"test"}'::jsonb, 2, 4)
       RETURNING id`,
      [experimentId]
    );
    const sourceId = String(oldTable.rows[0].id);
    const before = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE detail->>'source_audit_id' = $1`,
      [sourceId]
    );
    assert.strictEqual(before.rows[0].n, 0);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyAuditBackfill(client);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
      throw err;
    } finally {
      client.release();
    }

    const copied = await db.query(
      `SELECT account_id, action, actor_label, target_type, target_id, detail
       FROM audit_log WHERE detail->>'source_audit_id' = $1`,
      [sourceId]
    );
    assert.strictEqual(copied.rows.length, 1);
    assert.strictEqual(copied.rows[0].account_id, alpha.id);
    assert.strictEqual(copied.rows[0].action, 'test_traffic_remove');
    assert.strictEqual(copied.rows[0].actor_label, 'owner');
    assert.strictEqual(copied.rows[0].target_type, 'experiment');
    assert.strictEqual(copied.rows[0].target_id, experimentId);
    assert.strictEqual(copied.rows[0].detail.visitor_count, 2);
    assert.strictEqual(copied.rows[0].detail.event_count, 4);

    const clientAgain = await db.pool.connect();
    try {
      await clientAgain.query('BEGIN');
      await applyAuditBackfill(clientAgain);
      await clientAgain.query('COMMIT');
    } finally {
      clientAgain.release();
    }
    const stillOnce = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE detail->>'source_audit_id' = $1`,
      [sourceId]
    );
    assert.strictEqual(stillOnce.rows[0].n, 1);
    const kept = await db.query(`SELECT COUNT(*)::int AS n FROM test_traffic_audit WHERE id = $1`, [oldTable.rows[0].id]);
    assert.strictEqual(kept.rows[0].n, 1);

    const removed = await traffic.applyTestTraffic({
      experimentId,
      criteria: { mode: 'prefix', prefix: 'v_audit_prefix_' },
      direction: 'remove',
      actor: 'owner-a@alpha.example',
      actorIp: '203.0.113.9',
      accountId: alpha.id,
    });
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.changed, true);
    const fresh = await db.query(
      `SELECT action, account_id, detail FROM audit_log WHERE detail->>'source_audit_id' = $1`,
      [String(removed.audit_id)]
    );
    assert.strictEqual(fresh.rows.length, 1);
    assert.strictEqual(fresh.rows[0].action, 'test_traffic_remove');
    assert.strictEqual(fresh.rows[0].account_id, alpha.id);
    const oldStill = await db.query(
      `SELECT action FROM test_traffic_audit WHERE id = $1`,
      [removed.audit_id]
    );
    assert.strictEqual(oldStill.rows[0].action, 'remove');

    await db.query(
      `INSERT INTO audit_log (account_id, actor_user_id, actor_label, action, target_type, target_id, detail, created_at)
       VALUES
         ($1, $2, 'owner-a@alpha.example', 'signin', 'user', $4, '{}'::jsonb, now() - interval '3 hours'),
         ($1, $2, 'owner-a@alpha.example', 'site_added', 'site', $5, '{"host":"alpha.example"}'::jsonb, now() - interval '2 hours'),
         ($1, $3, 'member-a@alpha.example', 'signin', 'user', $6, '{}'::jsonb, now() - interval '1 hour')`,
      [alpha.id, alpha.userId, member.rows[0].id, alpha.userId, alpha.id, member.rows[0].id]
    );
    await db.query(
      `INSERT INTO audit_log (account_id, actor_label, action, detail)
       VALUES ($1, 'owner-b@beta.example', 'signup', '{"note":"beta-only-audit"}'::jsonb)`,
      [beta.id]
    );

    const ownerServer = await listen(appFor({
      role: 'owner',
      userId: alpha.userId,
      accountId: alpha.id,
      customer: true,
    }));
    servers.push(ownerServer);
    const betaServer = await listen(appFor({
      role: 'owner',
      userId: beta.userId,
      accountId: beta.id,
      customer: true,
    }));
    servers.push(betaServer);
    const memberServer = await listen(appFor({
      role: 'owner',
      userId: betaMember.rows[0].id,
      accountId: beta.id,
      customer: true,
    }));
    servers.push(memberServer);

    const clientRow = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Alpha Client', 'alpha-client', 'x', $1) RETURNING id`,
      [alpha.id]
    );
    const clientServer = await listen(appFor({
      role: 'client',
      clientId: clientRow.rows[0].id,
      accountId: alpha.id,
    }));
    servers.push(clientServer);

    const listed = await request(ownerServer, 'GET', '/api/audit?page=1&page_size=2');
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.json.page, 1);
    assert.strictEqual(listed.json.page_size, 2);
    assert.ok(listed.json.total >= 3);
    assert.strictEqual(listed.json.entries.length, 2);
    assert.ok(listed.json.entries.every((entry) => entry.account_id === alpha.id));
    const firstAt = new Date(listed.json.entries[0].created_at).getTime();
    const secondAt = new Date(listed.json.entries[1].created_at).getTime();
    assert.ok(firstAt >= secondAt);
    assert.ok(listed.json.entries[0].id > listed.json.entries[1].id || firstAt > secondAt);
    const page2 = await request(ownerServer, 'GET', '/api/audit?page=2&page_size=2');
    assert.strictEqual(page2.status, 200);
    assert.ok(page2.json.entries.length >= 1);
    assert.ok(!page2.json.entries.some((entry) => entry.id === listed.json.entries[0].id));

    const byTest = await request(ownerServer, 'GET', `/api/audit?test=${experimentId}&page=1&page_size=25`);
    assert.strictEqual(byTest.status, 200);
    assert.ok(byTest.json.entries.length >= 1);
    assert.ok(byTest.json.entries.every((entry) => entry.target_id === experimentId));
    assert.ok(byTest.json.entries.some((entry) => entry.experiment_name === 'Alpha pricing'));
    assert.ok(!byTest.text.includes('Beta pricing'));
    assert.ok(!byTest.text.includes('beta-only-audit'));

    const foreignTest = await request(ownerServer, 'GET', `/api/audit?test=${otherExp.rows[0].id}&page=1`);
    assert.strictEqual(foreignTest.status, 200);
    assert.strictEqual(foreignTest.json.total, 0);
    assert.ok(!foreignTest.text.includes('beta-only-audit'));
    assert.ok(!foreignTest.text.includes('owner-b@beta.example'));

    const byUser = await request(ownerServer, 'GET', `/api/audit?user=${member.rows[0].id}&page=1`);
    assert.strictEqual(byUser.status, 200);
    assert.ok(byUser.json.entries.length >= 1);
    assert.ok(byUser.json.entries.every((entry) => entry.actor_user_id === member.rows[0].id));

    const byAction = await request(ownerServer, 'GET', '/api/audit?action=site_added&page=1');
    assert.strictEqual(byAction.status, 200);
    assert.ok(byAction.json.entries.every((entry) => entry.action === 'site_added'));
    assert.ok(byAction.json.entries.some((entry) => entry.detail.host === 'alpha.example'));

    const bad = await request(ownerServer, 'GET', '/api/audit?action=drop%20table');
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.json.error.includes('recognised'));

    assert.ok(listed.json.tests.some((test) => test.id === experimentId && test.name === 'Alpha pricing'));
    assert.ok(!listed.json.tests.some((test) => test.id === otherExp.rows[0].id));
    assert.ok(listed.json.users.some((user) => user.label === 'member-a@alpha.example'));
    assert.ok(!listed.json.users.some((user) => user.label === 'owner-b@beta.example'));

    const betaList = await request(betaServer, 'GET', '/api/audit?page=1&page_size=50');
    assert.strictEqual(betaList.status, 200);
    assert.ok(betaList.text.includes('beta-only-audit'));
    assert.ok(!betaList.text.includes('alpha.example'));
    assert.ok(betaList.json.entries.every((entry) => entry.account_id === beta.id));

    const clientAudit = await request(clientServer, 'GET', '/api/audit');
    assert.strictEqual(clientAudit.status, 401);
    const clientRole = await request(clientServer, 'PATCH', `/api/account/members/${member.rows[0].id}`, { role: 'owner' });
    assert.strictEqual(clientRole.status, 401);

    const promoted = await request(ownerServer, 'PATCH', `/api/account/members/${member.rows[0].id}`, {
      role: 'owner',
      account_id: beta.id,
    });
    assert.strictEqual(promoted.status, 200);
    assert.strictEqual(promoted.json.changed, true);
    assert.strictEqual(promoted.json.role, 'owner');
    const roleRow = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, member.rows[0].id]
    );
    assert.strictEqual(roleRow.rows[0].role, 'owner');
    const betaRole = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [beta.id, member.rows[0].id]
    );
    assert.strictEqual(betaRole.rows.length, 0);
    const roleAudit = await db.query(
      `SELECT account_id, actor_user_id, actor_label, action, target_id, detail
       FROM audit_log WHERE action = 'role_change' AND target_id = $1`,
      [member.rows[0].id]
    );
    assert.strictEqual(roleAudit.rows.length, 1);
    assert.strictEqual(roleAudit.rows[0].account_id, alpha.id);
    assert.strictEqual(roleAudit.rows[0].actor_user_id, alpha.userId);
    assert.strictEqual(roleAudit.rows[0].actor_label, 'owner-a@alpha.example');
    assert.strictEqual(roleAudit.rows[0].detail.from_role, 'member');
    assert.strictEqual(roleAudit.rows[0].detail.to_role, 'owner');
    assert.strictEqual(roleAudit.rows[0].detail.email, 'member-a@alpha.example');

    const repeat = await request(ownerServer, 'PATCH', `/api/account/members/${member.rows[0].id}`, { role: 'owner' });
    assert.strictEqual(repeat.status, 200);
    assert.strictEqual(repeat.json.changed, false);
    const stillOne = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'role_change' AND target_id = $1`,
      [member.rows[0].id]
    );
    assert.strictEqual(stillOne.rows[0].n, 1);

    const demoted = await request(ownerServer, 'PATCH', `/api/account/members/${member.rows[0].id}`, { role: 'member' });
    assert.strictEqual(demoted.status, 200);
    assert.strictEqual(demoted.json.changed, true);
    const blocked = await request(ownerServer, 'PATCH', `/api/account/members/${alpha.userId}`, { role: 'member' });
    assert.strictEqual(blocked.status, 400);
    assert.ok(blocked.json.error.includes('at least one owner'));
    const alphaStill = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, alpha.userId]
    );
    assert.strictEqual(alphaStill.rows[0].role, 'owner');
    const memberAgain = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, member.rows[0].id]
    );
    assert.strictEqual(memberAgain.rows[0].role, 'member');

    const crossed = await request(betaServer, 'PATCH', `/api/account/members/${member.rows[0].id}`, { role: 'member' });
    assert.strictEqual(crossed.status, 404);
    assert.ok(!crossed.text.includes('member-a@alpha.example'));
    const unchanged = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, member.rows[0].id]
    );
    assert.strictEqual(unchanged.rows[0].role, 'member');

    const memberChange = await request(memberServer, 'PATCH', `/api/account/members/${beta.userId}`, { role: 'member' });
    assert.strictEqual(memberChange.status, 404);
    const betaOwner = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [beta.id, beta.userId]
    );
    assert.strictEqual(betaOwner.rows[0].role, 'owner');

    const onScreen = await request(ownerServer, 'GET', '/api/audit?action=role_change&page=1');
    assert.strictEqual(onScreen.status, 200);
    assert.ok(onScreen.json.entries.some((entry) => entry.detail.email === 'member-a@alpha.example'));
    const hidden = await request(betaServer, 'GET', '/api/audit?action=role_change&page=1');
    assert.strictEqual(hidden.json.total, 0);
    assert.ok(!hidden.text.includes('member-a@alpha.example'));

    const superUser = await db.query(`SELECT id FROM users WHERE is_superadmin IS TRUE LIMIT 1`);
    const legacy = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE LIMIT 1`);
    const superServer = await listen(appFor({
      role: 'owner',
      userId: superUser.rows[0].id,
      accountId: legacy.rows[0].id,
      superadmin: true,
    }));
    servers.push(superServer);
    const whole = await request(superServer, 'GET', '/api/audit?page=1&page_size=50');
    assert.strictEqual(whole.status, 200);
    assert.ok(whole.json.entries.every((entry) => entry.account_id === legacy.rows[0].id));
    assert.ok(!whole.text.includes('beta-only-audit'));
    assert.ok(!whole.text.includes('member-a@alpha.example'));

    console.log('audit log db tests passed');
  } finally {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
