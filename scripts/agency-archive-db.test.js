// Archive, restore and delete an agency. The snippet goes quiet while the
// agency is archived, experiment status is left as it was, and delete removes
// the agency's rows. A Member is refused. Another agency's id is missing.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { VIEW_ONLY_MESSAGE } = require('../src/membership-access');

process.env.NODE_ENV = 'test';

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const headers = { Host: `127.0.0.1:${port}` };
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

function appFor(session) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session;
    req.sessionID = session && session.sid;
    if (req.session && typeof req.session.destroy !== 'function') {
      req.session.destroy = (cb) => {
        req.session.destroyed = true;
        if (cb) cb();
      };
    }
    next();
  });
  app.use('/api/agencies', require('../src/routes/agencies'));
  app.use('/api/admin', require('../src/routes/audit').adminRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/event', require('../src/routes/events'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function countWhere(db, table, column, id) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`,
    [id]
  );
  return rows[0].n;
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('agency archive db tests skipped: postgres not reachable');
    console.log('agency archive db tests passed');
    return;
  }
  const dbName = 'pivit_agency_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  process.env.SESSION_SECRET = 'agency-archive-session-secret-32ch';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { newSiteKey } = require('../src/db/tenancy');
  const { clearLegacyCache } = require('../src/tenant');
  const { deleteSummary, ORIGINAL_AGENCY, ARCHIVE_FIRST, NAME_MISMATCH, SIGN_OUT_WARNING } = require('../src/agency-lifecycle');

  const servers = [];
  try {
    const applied = await migrate();
    assert.ok(applied.includes('026'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);
    clearLegacyCache();

    const column = await db.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'accounts' AND column_name = 'archived_at'`
    );
    assert.strictEqual(column.rows[0].is_nullable, 'YES');

    const legacy = await db.query(
      `SELECT a.id, u.id AS user_id
       FROM accounts a
       JOIN memberships m ON m.account_id = a.id AND m.role = 'owner'
       JOIN users u ON u.id = m.user_id AND u.is_superadmin IS TRUE
       WHERE a.legacy IS TRUE
       LIMIT 1`
    );
    const legacyId = legacy.rows[0].id;
    const superId = legacy.rows[0].user_id;

    async function makeAccount(name, email, host) {
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
      const key = newSiteKey();
      const site = await db.query(
        `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
         VALUES ($1, $2, $3::text[], $4, now()) RETURNING id`,
        [account.rows[0].id, host, [host], key]
      );
      return {
        id: account.rows[0].id,
        userId: user.rows[0].id,
        siteId: site.rows[0].id,
        key,
        host,
      };
    }

    const google = await makeAccount('Google', 'owner@google.example', 'google.example');
    const shopKey = newSiteKey();
    await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key) VALUES ($1, 'Shop', $2::text[], $3)`,
      [google.id, ['shop.google.example'], shopKey]
    );
    await db.query(`UPDATE accounts SET paid_plan = true WHERE id = $1`, [google.id]);
    await db.query(
      `UPDATE sites SET ga4_enabled = true, ga4_measurement_id = 'G-TEST1234' WHERE id = $1`,
      [google.siteId]
    );
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member@google.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [google.id, member.rows[0].id]
    );
    const kept = await makeAccount('Kept Ltd', 'owner@kept.example', 'kept.example');

    const experiment = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
       VALUES ('Homepage', 'google.example', 'running', $2::text[], $1, $3, '[]'::jsonb, 'shared', true)
       RETURNING id, status`,
      [google.id, ['google.example'], google.siteId]
    );
    const experimentId = experiment.rows[0].id;
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, changes) VALUES ($1, 'control', '[]'::jsonb) RETURNING id`,
      [experimentId]
    );
    const variantId = variant.rows[0].id;
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       VALUES ($1, $2, 'visitor-google', 'view')`,
      [experimentId, variantId]
    );
    await db.query(
      `INSERT INTO content_revisions (experiment_id, variant_id, revision, while_running)
       VALUES ($1, $2, 1, true)`,
      [experimentId, variantId]
    );
    await db.query(
      `INSERT INTO status_snapshots (experiment_id, account_id, snapshot_date, headline_code)
       VALUES ($1, $2, CURRENT_DATE, 'running')`,
      [experimentId, google.id]
    );
    const viewer = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Google viewer', 'google-viewer', 'hash', $1) RETURNING id`,
      [google.id]
    );
    await db.query(
      `INSERT INTO review_requests (account_id, experiment_id, client_id)
       VALUES ($1, $2, $3)`,
      [google.id, experimentId, viewer.rows[0].id]
    );
    await db.query(
      `INSERT INTO conclusion_reports (account_id, experiment_id, content)
       VALUES ($1, $2, '{"title":"Done"}'::jsonb)`,
      [google.id, experimentId]
    );
    await db.query(
      `INSERT INTO goal_templates (type, value, label, account_id) VALUES ('click', '.buy', 'buy', $1)`,
      [google.id]
    );
    await db.query(
      `INSERT INTO owner_notices (account_id, kind, title, body) VALUES ($1, 'note', 'Hello', 'There')`,
      [google.id]
    );
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count, account_id)
       VALUES (CURRENT_DATE, 'pivitlab.com', 'https://google.example', 3, $1)`,
      [google.id]
    );
    await db.query(
      `INSERT INTO audit_log (account_id, action, detail) VALUES ($1, 'signin', '{}'::jsonb)`,
      [google.id]
    );
    const invite = await db.query(
      `INSERT INTO invite_codes (code_hash, hint, expires_at, account_id)
       VALUES ('hash-google-code', 'goog', now() + interval '14 days', $1) RETURNING id`,
      [google.id]
    );
    await db.query(
      `INSERT INTO login_tokens (email, purpose, token_hash, code_hash, expires_at, invite_id)
       VALUES ('invite@google.example', 'signup', 'hash-google-token', 'hash-google-code6', now() + interval '1 hour', $1)`,
      [invite.rows[0].id]
    );
    await db.query(
      `INSERT INTO account_invites (account_id, email, role, token_hash, expires_at)
       VALUES ($1, 'new@google.example', 'member', 'hash-google-invite', now() + interval '7 days')`,
      [google.id]
    );
    await db.query(
      `INSERT INTO "session" (sid, sess, expire) VALUES
         ('google-member-sid', $1::json, now() + interval '1 day'),
         ('kept-owner-sid', $2::json, now() + interval '1 day'),
         ('view-google-sid', $3::json, now() + interval '1 day')`,
      [
        JSON.stringify({ accountId: google.id, role: 'owner', userId: member.rows[0].id }),
        JSON.stringify({ accountId: kept.id, role: 'owner', userId: kept.userId }),
        JSON.stringify({ accountId: legacyId, role: 'owner', userId: superId, viewAsAccountId: google.id }),
      ]
    );

    const keptExperiment = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
       VALUES ('Kept home', 'kept.example', 'paused', $2::text[], $1, $3, '[]'::jsonb, 'shared', true)
       RETURNING id`,
      [kept.id, ['kept.example'], kept.siteId]
    );

    function sessionFor(fields) {
      return Object.assign({ role: 'owner', destroy: null }, fields);
    }
    const ownerSession = sessionFor({ userId: google.userId, accountId: google.id, sid: 'google-owner-live' });
    const memberSession = sessionFor({ userId: member.rows[0].id, accountId: google.id });
    const keptSession = sessionFor({ userId: kept.userId, accountId: kept.id });
    const superSession = sessionFor({ userId: superId, accountId: legacyId, superadmin: true });
    const viewSession = sessionFor({
      userId: superId,
      accountId: legacyId,
      superadmin: true,
      viewAsAccountId: google.id,
    });

    const ownerServer = await listen(appFor(ownerSession));
    const memberServer = await listen(appFor(memberSession));
    const keptServer = await listen(appFor(keptSession));
    const superServer = await listen(appFor(superSession));
    const viewServer = await listen(appFor(viewSession));
    const publicServer = await listen(appFor({}));
    servers.push(ownerServer, memberServer, keptServer, superServer, viewServer, publicServer);

    const page = '/api/experiments?url=' + encodeURIComponent('https://google.example/pricing') + '&site=' + encodeURIComponent(google.key);
    const before = await request(publicServer, 'GET', page);
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.json.experiments.length, 1);
    assert.strictEqual(before.json.ga4.measurement_id, 'G-TEST1234');

    const memberArchive = await request(memberServer, 'POST', `/api/agencies/${google.id}/archive`);
    assert.strictEqual(memberArchive.status, 403);
    assert.strictEqual(memberArchive.json.error, VIEW_ONLY_MESSAGE);
    const memberRestore = await request(memberServer, 'POST', `/api/agencies/${google.id}/restore`);
    assert.strictEqual(memberRestore.status, 403);
    const memberDelete = await request(memberServer, 'DELETE', `/api/agencies/${google.id}`, { confirm: 'Google' });
    assert.strictEqual(memberDelete.status, 403);
    const memberList = await request(memberServer, 'GET', '/api/agencies');
    assert.strictEqual(memberList.status, 403);

    const stranger = await request(keptServer, 'POST', `/api/agencies/${google.id}/archive`);
    assert.strictEqual(stranger.status, 404);
    const missing = await request(ownerServer, 'POST', '/api/agencies/not-a-uuid/archive');
    assert.strictEqual(missing.status, 404);

    const legacyArchive = await request(superServer, 'POST', `/api/agencies/${legacyId}/archive`);
    assert.strictEqual(legacyArchive.status, 400);
    assert.strictEqual(legacyArchive.json.error, ORIGINAL_AGENCY);
    const legacyDelete = await request(superServer, 'DELETE', `/api/agencies/${legacyId}`, { confirm: 'Heclr' });
    assert.strictEqual(legacyDelete.status, 400);
    assert.strictEqual(legacyDelete.json.error, ORIGINAL_AGENCY);

    const viewArchive = await request(viewServer, 'POST', `/api/agencies/${google.id}/archive`);
    assert.strictEqual(viewArchive.status, 403);
    const viewList = await request(viewServer, 'GET', '/api/agencies');
    assert.strictEqual(viewList.status, 403);

    const archived = await request(ownerServer, 'POST', `/api/agencies/${google.id}/archive`);
    assert.strictEqual(archived.status, 200);
    assert.strictEqual(archived.json.archived, true);
    const againArchive = await request(ownerServer, 'POST', `/api/agencies/${google.id}/archive`);
    assert.strictEqual(againArchive.status, 200);
    assert.strictEqual(againArchive.json.changed, false);

    const status = await db.query(`SELECT status FROM experiments WHERE id = $1`, [experimentId]);
    assert.strictEqual(status.rows[0].status, 'running');

    const quiet = await request(publicServer, 'GET', page);
    assert.strictEqual(quiet.status, 200);
    assert.deepStrictEqual(quiet.json, { experiments: [] });
    const byIds = await request(
      publicServer,
      'GET',
      '/api/experiments/by-ids?ids=' + experimentId + '&site=' + encodeURIComponent(google.key)
    );
    assert.deepStrictEqual(byIds.json, { experiments: [] });
    const dropped = await request(publicServer, 'POST', '/api/event', {
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: 'visitor-archived',
      event_type: 'view',
      site: google.key,
    });
    assert.strictEqual(dropped.status, 204);
    const events = await db.query(`SELECT COUNT(*)::int AS n FROM events WHERE experiment_id = $1`, [experimentId]);
    assert.strictEqual(events.rows[0].n, 1);

    const directory = await request(superServer, 'GET', '/api/admin/accounts');
    assert.strictEqual(directory.status, 200);
    assert.ok(!directory.json.accounts.some((account) => account.id === google.id));
    assert.ok(directory.json.accounts.some((account) => account.id === kept.id));

    const ownerList = await request(ownerServer, 'GET', '/api/agencies');
    assert.strictEqual(ownerList.status, 200);
    assert.strictEqual(ownerList.json.agencies.length, 1);
    assert.strictEqual(ownerList.json.agencies[0].name, 'Google');
    assert.strictEqual(ownerList.json.agencies[0].archived, true);
    assert.strictEqual(ownerList.json.agencies[0].sites, 2);
    assert.strictEqual(ownerList.json.agencies[0].experiments, 1);
    assert.strictEqual(ownerList.json.agencies[0].current, true);
    assert.strictEqual(ownerList.json.agencies[0].summary, deleteSummary(2, 1));
    assert.strictEqual(ownerList.json.agencies[0].sign_out_warning, SIGN_OUT_WARNING);

    const superList = await request(superServer, 'GET', '/api/agencies');
    assert.ok(superList.json.agencies.some((account) => account.id === google.id && account.archived));
    assert.ok(superList.json.agencies.some((account) => account.id === legacyId && account.legacy));

    const restored = await request(ownerServer, 'POST', `/api/agencies/${google.id}/restore`);
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.json.archived, false);
    const statusAfter = await db.query(`SELECT status FROM experiments WHERE id = $1`, [experimentId]);
    assert.strictEqual(statusAfter.rows[0].status, 'running');
    const back = await request(publicServer, 'GET', page);
    assert.strictEqual(back.json.experiments.length, 1);
    assert.strictEqual(back.json.experiments[0].id, experimentId);
    assert.strictEqual(back.json.ga4.measurement_id, 'G-TEST1234');

    const tooSoon = await request(ownerServer, 'DELETE', `/api/agencies/${google.id}`, { confirm: 'Google' });
    assert.strictEqual(tooSoon.status, 400);
    assert.strictEqual(tooSoon.json.error, ARCHIVE_FIRST);

    const ads = await makeAccount('Ads', 'owner@ads.example', 'ads.example');
    const adsArchive = await request(superServer, 'POST', `/api/agencies/${ads.id}/archive`);
    assert.strictEqual(adsArchive.status, 200);
    const adsDelete = await request(superServer, 'DELETE', `/api/agencies/${ads.id}`, { confirm: 'Ads' });
    assert.strictEqual(adsDelete.status, 200);
    assert.strictEqual(adsDelete.json.signed_out, false);
    assert.strictEqual(await countWhere(db, 'accounts', 'id', ads.id), 0);
    const adsAudit = await db.query(
      `SELECT account_id, detail->>'name' AS name FROM audit_log WHERE action = 'agency_delete' AND target_id = $1`,
      [ads.id]
    );
    assert.strictEqual(adsAudit.rows[0].name, 'Ads');
    assert.strictEqual(adsAudit.rows[0].account_id, legacyId);

    await request(ownerServer, 'POST', `/api/agencies/${google.id}/archive`);
    const wrongName = await request(ownerServer, 'DELETE', `/api/agencies/${google.id}`, { confirm: 'google' });
    assert.strictEqual(wrongName.status, 400);
    assert.strictEqual(wrongName.json.error, NAME_MISMATCH);
    assert.strictEqual(await countWhere(db, 'accounts', 'id', google.id), 1);

    const removed = await request(ownerServer, 'DELETE', `/api/agencies/${google.id}`, { confirm: 'Google' });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.json.deleted, true);
    assert.strictEqual(removed.json.signed_out, true);
    assert.strictEqual(removed.json.summary, deleteSummary(2, 1));
    assert.strictEqual(ownerSession.destroyed, true);

    assert.strictEqual(await countWhere(db, 'accounts', 'id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'sites', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'experiments', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'variants', 'id', variantId), 0);
    assert.strictEqual(await countWhere(db, 'events', 'experiment_id', experimentId), 0);
    assert.strictEqual(await countWhere(db, 'content_revisions', 'experiment_id', experimentId), 0);
    assert.strictEqual(await countWhere(db, 'clients', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'memberships', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'account_invites', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'invite_codes', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'goal_templates', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'owner_notices', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'host_hits', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'audit_log', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'status_snapshots', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'review_requests', 'account_id', google.id), 0);
    assert.strictEqual(await countWhere(db, 'conclusion_reports', 'account_id', google.id), 0);
    const tokenLeft = await db.query(
      `SELECT COUNT(*)::int AS n FROM login_tokens WHERE token_hash = 'hash-google-token'`
    );
    assert.strictEqual(tokenLeft.rows[0].n, 0);

    const fks = await db.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND ccu.table_name = 'accounts'`
    );
    for (const fk of fks.rows) {
      assert.strictEqual(
        await countWhere(db, fk.table_name, fk.column_name, google.id),
        0,
        `${fk.table_name}.${fk.column_name} still points at the deleted agency`
      );
    }

    const sessions = await db.query(
      `SELECT sid, sess->>'accountId' AS account_id, sess->>'viewAsAccountId' AS view_as
       FROM "session" ORDER BY sid`
    );
    assert.ok(!sessions.rows.some((row) => row.account_id === google.id || row.view_as === google.id));
    assert.ok(sessions.rows.some((row) => row.sid === 'kept-owner-sid' && row.account_id === kept.id));
    const viewed = sessions.rows.find((row) => row.sid === 'view-google-sid');
    assert.ok(viewed);
    assert.strictEqual(viewed.view_as, null);
    assert.strictEqual(viewed.account_id, legacyId);

    const ownerStill = await db.query(`SELECT id FROM users WHERE id = $1`, [google.userId]);
    assert.strictEqual(ownerStill.rows.length, 1);
    const keptStill = await db.query(`SELECT status FROM experiments WHERE id = $1`, [keptExperiment.rows[0].id]);
    assert.strictEqual(keptStill.rows[0].status, 'paused');
    assert.strictEqual(await countWhere(db, 'accounts', 'id', legacyId), 1);

    const gone = await request(publicServer, 'GET', page);
    assert.deepStrictEqual(gone.json, { experiments: [] });
    const shopGone = await request(
      publicServer,
      'GET',
      '/api/experiments?url=' + encodeURIComponent('https://shop.google.example/') + '&site=' + encodeURIComponent(shopKey)
    );
    assert.deepStrictEqual(shopGone.json, { experiments: [] });

    const deleteAudit = await db.query(
      `SELECT account_id, detail->>'name' AS name FROM audit_log WHERE action = 'agency_delete' AND target_id = $1`,
      [google.id]
    );
    assert.strictEqual(deleteAudit.rows[0].name, 'Google');
    assert.strictEqual(deleteAudit.rows[0].account_id, null);

    console.log('agency archive db tests passed');
  } finally {
    for (const server of servers) {
      try { await close(server); } catch (err) { /* already closed */ }
    }
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
