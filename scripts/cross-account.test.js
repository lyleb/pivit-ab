// Two customer accounts, each with its own user, site key, experiments,
// variants, events and client login. Account B must not list, read, edit,
// start, pause, archive, export, preview, or see results or portal data for
// account A. scripts/isolation-db.test.js already covers the legacy account
// (no site key) against one other customer, including the emergency password
// login. This file does not repeat those cases.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');

const ALPHA_PAGE = 'https://alpha.example/pricing';
const ALPHA_DRAFT_PAGE = 'https://alpha.example/draft-page';
const BETA_PAGE = 'https://beta.example/pricing';
const MISSING_ID = '00000000-0000-4000-8000-000000000099';

function request(server, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'user-agent': 'Mozilla/5.0 (compatible; pivitlab-check)' },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        headers || {}
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
        resolve({ status: res.statusCode, text, json, headers: res.headers });
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
    next();
  });
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/invites', require('../src/routes/invites'));
  app.use('/api/access-requests', require('../src/routes/access-requests'));
  app.use('/api/access-requests', require('../src/routes/access-requests').adminRouter);
  app.use('/api/audit', require('../src/routes/audit'));
  app.use('/api/account/members', require('../src/routes/members'));
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/admin', require('../src/routes/audit').adminRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/event', require('../src/routes/events'));
  app.use('/api/results', require('../src/routes/results'));
  app.use('/api/goals', require('../src/routes/goals').router);
  app.use('/api/clients', require('../src/routes/clients'));
  app.use('/api/client', require('../src/routes/client'));
  app.use('/api/review-requests', require('../src/routes/review-requests'));
  app.use('/api/editor', require('../src/routes/editor'));
  app.use('/api/host-hits', require('../src/routes/host-hits'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippetPath(page, site) {
  let path = '/api/experiments?url=' + encodeURIComponent(page);
  if (site) path += '&site=' + encodeURIComponent(site);
  return path;
}

function byIdsPath(ids, page, site) {
  let path = `/api/experiments/by-ids?ids=${ids.join(',')}&url=${encodeURIComponent(page)}`;
  if (site) path += '&site=' + encodeURIComponent(site);
  return path;
}

function originFor(page) {
  return { origin: new URL(page).origin };
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('cross-account tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_xacc_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  process.env.SESSION_SECRET = 'cross-account-session-secret-32chars';
  delete process.env.PIVIT_TENANCY_FAULT;
  delete process.env.ADMIN_API_KEY;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { newSiteKey } = require('../src/db/tenancy');
  const { createEditToken } = require('../src/edit-token');
  const { createPreviewToken } = require('../src/preview-access');
  const { clearLegacyCache } = require('../src/tenant');
  const { clearSessionSecretCache } = require('../src/session-secret');
  clearSessionSecretCache();

  const servers = [];
  try {
    await migrate();
    clearLegacyCache();

    async function makeAccount(name, email, host, role) {
      const account = await db.query(
        `INSERT INTO accounts (name, legacy) VALUES ($1, false) RETURNING id`,
        [name]
      );
      const user = await db.query(
        `INSERT INTO users (email, verified_at) VALUES ($1, now()) RETURNING id`,
        [email]
      );
      await db.query(
        `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, $3)`,
        [account.rows[0].id, user.rows[0].id, role]
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

    const alpha = await makeAccount('Alpha Ltd', 'owner-a@alpha.example', 'alpha.example', 'owner');
    const beta = await makeAccount('Beta Ltd', 'owner-b@beta.example', 'beta.example', 'owner');
    const member = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('member-b@beta.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [beta.id, member.rows[0].id]
    );

    async function makeExperiment(account, name, status, urlMatch, changes, hypothesis) {
      const exp = await db.query(
        `INSERT INTO experiments
           (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated, hypothesis)
         VALUES ($1, $2, $3, $4::text[], $5, $6, '[]'::jsonb, 'shared', true, $7)
         RETURNING id`,
        [name, urlMatch, status, [account.host], account.id, account.siteId, hypothesis || null]
      );
      const variant = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split, changes)
         VALUES ($1, 'Control', 100, $2::jsonb) RETURNING id`,
        [exp.rows[0].id, JSON.stringify(changes || [])]
      );
      return { id: exp.rows[0].id, variantId: variant.rows[0].id };
    }

    const aRunning = await makeExperiment(
      alpha,
      'Alpha pricing test',
      'running',
      '/pricing',
      [{ type: 'text', selector: 'h1', value: 'alpha-secret-headline' }],
      'alpha-secret-hypothesis'
    );
    const aSpare = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes)
       VALUES ($1, 'Spare', 0, '[]'::jsonb) RETURNING id`,
      [aRunning.id]
    );
    const aDraft = await makeExperiment(
      alpha,
      'Alpha draft test',
      'draft',
      '/draft-page',
      [{ type: 'text', selector: 'h1', value: 'alpha-secret-draft' }]
    );
    const aArchived = await makeExperiment(alpha, 'Alpha archived test', 'archived', '/old', []);
    const bRunning = await makeExperiment(beta, 'Beta pricing test', 'running', '/pricing', []);

    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       VALUES ($1, $2, 'alpha-secret-visitor', 'view')`,
      [aRunning.id, aRunning.variantId]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type)
       VALUES ($1, $2, 'beta-visitor', 'view')`,
      [bRunning.id, bRunning.variantId]
    );

    const aClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Alpha Client', 'alpha-client', 'hash-alpha', $1) RETURNING id`,
      [alpha.id]
    );
    const bClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Beta Client', 'beta-client', 'hash-beta', $1) RETURNING id`,
      [beta.id]
    );
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [aClient.rows[0].id, aRunning.id]);
    await db.query(`UPDATE experiments SET client_id = $1 WHERE id = $2`, [bClient.rows[0].id, bRunning.id]);

    await db.query(
      `INSERT INTO goal_templates (account_id, type, value, label)
       VALUES ($1, 'click', '.alpha-only', 'alpha-only-goal')`,
      [alpha.id]
    );
    await db.query(
      `INSERT INTO goal_templates (account_id, type, value, label)
       VALUES ($1, 'click', '.beta-only', 'beta-only-goal')`,
      [beta.id]
    );
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count, account_id)
       VALUES (CURRENT_DATE, 'pivitlab.com', 'https://alpha.example', 12, $1)`,
      [alpha.id]
    );
    await db.query(
      `INSERT INTO host_hits (day, host, referrer_origin, hit_count, account_id)
       VALUES (CURRENT_DATE, 'pivitlab.com', 'https://beta.example', 7, $1)`,
      [beta.id]
    );
    await db.query(
      `INSERT INTO audit_log (account_id, action, actor_label, detail)
       VALUES ($1, 'signup', 'owner-a@alpha.example', '{"note":"alpha-secret-audit"}'::jsonb)`,
      [alpha.id]
    );
    await db.query(
      `INSERT INTO audit_log (account_id, action, actor_label, detail)
       VALUES ($1, 'signup', 'owner-b@beta.example', '{"note":"beta-secret-audit"}'::jsonb)`,
      [beta.id]
    );
    await db.query(
      `INSERT INTO status_snapshots
         (experiment_id, account_id, snapshot_date, headline_code, futility_band, detail)
       VALUES ($1, $2, CURRENT_DATE, 'keep_running', 'none', $3::jsonb)`,
      [aRunning.id, alpha.id, JSON.stringify({ private: { owner_note: 'alpha-secret-owner-note' } })]
    );
    const aReview = await db.query(
      `INSERT INTO review_requests (account_id, experiment_id, client_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [alpha.id, aRunning.id, aClient.rows[0].id]
    );

    const secrets = [
      'alpha-secret-visitor',
      'alpha-secret-headline',
      'alpha-secret-draft',
      'alpha-secret-owner-note',
      'alpha-secret-audit',
      'alpha-secret-hypothesis',
      'alpha-only-goal',
      'Alpha pricing test',
      'Alpha draft test',
      'Alpha archived test',
      'Alpha Client',
      'alpha-client',
      'owner-a@alpha.example',
      alpha.key,
    ];

    function assertClean(res, label) {
      const disposition = (res.headers && res.headers['content-disposition']) || '';
      const haystack = res.text + '\n' + disposition;
      for (const secret of secrets) {
        assert.ok(!haystack.includes(secret), `${label} included ${secret} (${res.status})`);
      }
    }

    async function expectHidden(server, method, urlPath, body, label) {
      const res = await request(server, method, urlPath, body);
      assert.strictEqual(res.status, 404, `${label} -> ${res.status} ${res.text.slice(0, 400)}`);
      assert.ok(!/forbidden/i.test(res.text), `${label} used 403, which confirms the id exists`);
      assertClean(res, label);
      return res;
    }

    function ownerSession(userId, accountId) {
      return { role: 'owner', userId, accountId, customer: true, superadmin: false };
    }

    const serverA = await listen(appFor(ownerSession(alpha.userId, alpha.id)));
    const serverB = await listen(appFor(ownerSession(beta.userId, beta.id)));
    const serverMember = await listen(appFor(ownerSession(member.rows[0].id, beta.id)));
    const serverClientB = await listen(appFor({
      role: 'client',
      clientId: bClient.rows[0].id,
      clientName: 'Beta Client',
      accountId: beta.id,
      customer: true,
    }));
    const serverMixed = await listen(appFor({
      role: 'client',
      clientId: aClient.rows[0].id,
      clientName: 'Alpha Client',
      accountId: beta.id,
      customer: true,
    }));
    const publicSession = {};
    const publicServer = await listen(appFor(publicSession));
    servers.push(serverA, serverB, serverMember, serverClientB, serverMixed, publicServer);

    const own = await request(serverA, 'GET', `/api/experiments/${aRunning.id}`);
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.json.name, 'Alpha pricing test');
    assert.ok(own.text.includes('alpha-secret-headline'));
    const ownList = await request(serverB, 'GET', '/api/experiments/all');
    assert.strictEqual(ownList.status, 200);
    assert.ok(ownList.json.experiments.some((exp) => exp.id === bRunning.id));
    assert.ok(!ownList.json.experiments.some((exp) => exp.id === aRunning.id));

    const page = ALPHA_PAGE;
    const matched = await request(publicServer, 'GET', snippetPath(page, alpha.key), null, originFor(page));
    assert.ok(matched.json.experiments.some((exp) => exp.id === aRunning.id));
    assert.ok(!matched.json.experiments.some((exp) => exp.id === bRunning.id));
    assert.ok(matched.text.includes('alpha-secret-headline'));

    const betaMatched = await request(publicServer, 'GET', snippetPath(BETA_PAGE, beta.key), null, originFor(BETA_PAGE));
    assert.deepStrictEqual(betaMatched.json.experiments.map((exp) => exp.id), [bRunning.id]);
    assertClean(betaMatched, 'snippet for Beta');

    async function denyOwner(server, who) {
      const foreign = [
        ['GET', `/api/experiments/${aRunning.id}`],
        ['GET', `/api/experiments/${aRunning.id}/health`],
        ['GET', `/api/experiments/${aRunning.id}/snapshot-note`],
        ['GET', `/api/experiments/${aDraft.id}`],
        ['GET', `/api/experiments/${aArchived.id}`],
        ['GET', `/api/results/${aRunning.id}`],
        ['GET', `/api/results/${aRunning.id}/timeseries`],
        ['GET', `/api/results/${aRunning.id}/recent`],
        ['GET', `/api/results/${aRunning.id}/export`],
        ['GET', `/api/results/${aRunning.id}/bayesian`],
        ['GET', `/api/results/${aRunning.id}/srm`],
        ['GET', `/api/results/${aRunning.id}/verdict`],
        ['GET', `/api/results/${aRunning.id}/test-traffic`],
        ['POST', `/api/experiments/${aRunning.id}/test-traffic/preview`, { mode: 'test', direction: 'remove' }],
        ['POST', `/api/experiments/${aRunning.id}/test-traffic/remove`, { mode: 'test', direction: 'remove', confirm: true }],
        ['POST', `/api/experiments/${aRunning.id}/test-traffic/restore`, { mode: 'test', direction: 'restore', confirm: true }],
        ['GET', `/api/experiments/${aRunning.id}/test-traffic/audit`],
        ['GET', `/api/experiments/${aRunning.id}/plan`],
        ['POST', `/api/experiments/${aRunning.id}/plan/preview`, {}],
        ['PUT', `/api/experiments/${aRunning.id}/plan`, {}],
        ['POST', `/api/experiments/${aRunning.id}/reveal`, { confirm: true }],
        ['POST', `/api/experiments/${aRunning.id}/variants/${aRunning.variantId}/edit-link`, { page_url: ALPHA_PAGE }],
        ['POST', `/api/experiments/${aRunning.id}/variants/${aRunning.variantId}/preview-link`, { page_url: ALPHA_PAGE }],
        ['PATCH', `/api/experiments/${aRunning.id}/hosts`, { allowed_hosts: ['evil.example'] }],
        ['PATCH', `/api/experiments/${aRunning.id}/url-match`, { url_match_type: 'exact' }],
        ['PATCH', `/api/experiments/${aRunning.id}/client`, { client_id: bClient.rows[0].id }],
        ['PATCH', `/api/experiments/${aRunning.id}/status`, { status: 'paused' }],
        ['PATCH', `/api/experiments/${aRunning.id}/status`, { status: 'archived', archive: true }],
        ['PATCH', `/api/experiments/${aDraft.id}/status`, { status: 'running' }],
        ['DELETE', `/api/experiments/${aArchived.id}`],
        ['POST', `/api/experiments/${aRunning.id}/variants`, { name: 'Sneaky variant', traffic_split: 10 }],
        ['PATCH', `/api/experiments/${aRunning.id}/variants/${aSpare.rows[0].id}`, { name: 'Hacked', traffic_split: 1, changes: [] }],
        ['PATCH', `/api/experiments/${aRunning.id}/variants/${aSpare.rows[0].id}/enabled`, { enabled: false }],
        ['DELETE', `/api/experiments/${aRunning.id}/variants/${aSpare.rows[0].id}`],
        ['PUT', `/api/experiments/${aRunning.id}/goals`, { goals: [{ type: 'click', selector: '.nope', name: 'Nope' }] }],
        ['PATCH', `/api/clients/${aClient.rows[0].id}`, { name: 'Hacked' }],
        ['DELETE', `/api/clients/${aClient.rows[0].id}`],
        ['POST', `/api/review-requests/${aReview.rows[0].id}/decide`, {}],
        ['PATCH', `/api/account/members/${alpha.userId}`, { role: 'member', account_id: beta.id }],
      ];
      for (const [method, urlPath, body] of foreign) {
        await expectHidden(server, method, urlPath, body, `${who} ${method} ${urlPath}`);
      }

      const missing = await request(server, 'GET', `/api/experiments/${MISSING_ID}`);
      const present = await request(server, 'GET', `/api/experiments/${aRunning.id}`);
      assert.strictEqual(present.status, missing.status);
      assert.strictEqual(present.text, missing.text);

      const listed = await request(server, 'GET', '/api/experiments/all');
      assert.strictEqual(listed.status, 200);
      assert.ok(listed.json.experiments.every((exp) => exp.account_id === beta.id));
      assertClean(listed, `${who} experiment list`);

      const report = await request(server, 'GET', '/api/experiments/host-report');
      assert.strictEqual(report.status, 200);
      assert.ok(!report.json.experiments[aRunning.id]);
      assert.ok(!report.json.experiments[aDraft.id]);
      assertClean(report, `${who} host report`);

      const clients = await request(server, 'GET', '/api/clients');
      assert.strictEqual(clients.status, 200);
      assert.ok(clients.json.clients.some((client) => client.id === bClient.rows[0].id));
      assert.ok(!clients.json.clients.some((client) => client.id === aClient.rows[0].id));
      assertClean(clients, `${who} client list`);

      const goals = await request(server, 'GET', '/api/goals/popular');
      assert.strictEqual(goals.status, 200);
      assert.ok(!goals.json.goals.some((goal) => goal.label === 'alpha-only-goal'));
      if (!goals.json.site_choice_required) {
        assert.ok(goals.json.goals.some((goal) => goal.label === 'beta-only-goal'));
      }
      assertClean(goals, `${who} goals`);

      const hits = await request(server, 'GET', '/api/host-hits');
      assert.strictEqual(hits.status, 200);
      assert.ok(hits.json.rows.some((row) => row.referrer_origin === 'https://beta.example'));
      assert.ok(!hits.json.rows.some((row) => row.referrer_origin === 'https://alpha.example'));
      assertClean(hits, `${who} host hits`);

      const reviews = await request(server, 'GET', '/api/review-requests');
      assert.strictEqual(reviews.status, 200);
      assert.deepStrictEqual(reviews.json.requests, []);
      assertClean(reviews, `${who} reviews`);

      const audit = await request(server, 'GET', '/api/audit');
      assert.strictEqual(audit.status, 200);
      assert.ok(!audit.json.entries.some((entry) => entry.account_id === alpha.id));
      assertClean(audit, `${who} audit`);

      const setup = await request(server, 'GET', '/api/setup');
      assert.strictEqual(setup.status, 200, setup.text);
      if (who === 'owner B') {
        assert.strictEqual(setup.json.site.public_key, beta.key);
      } else {
        // Owner B has already added a second site, so the choice is unset.
        assert.strictEqual(setup.json.site, null);
        assert.strictEqual(setup.json.site_choice_required, true);
        assert.ok(setup.json.sites.some((site) => site.public_key === beta.key));
        assert.ok(!setup.json.sites.some((site) => site.public_key === alpha.key));
      }
      assertClean(setup, `${who} setup`);

      const me = await request(server, 'GET', '/api/auth/me');
      assert.strictEqual(me.json.account.id, beta.id);
      assert.strictEqual(me.json.snippet_site_key, who === 'owner B' ? beta.key : null);
      assert.strictEqual(me.json.view_as, null);
      assertClean(me, `${who} session`);

      const invites = await request(server, 'GET', '/api/invites');
      assert.strictEqual(invites.status, 404);
      assertClean(invites, `${who} invites`);
      const accounts = await request(server, 'GET', '/api/admin/accounts');
      assert.strictEqual(accounts.status, 404);
      assertClean(accounts, `${who} account list`);
      const access = await request(server, 'GET', '/api/access-requests');
      assert.strictEqual(access.status, 404);
      assertClean(access, `${who} access requests`);

      const portal = await request(server, 'GET', '/api/client/experiments');
      assert.strictEqual(portal.status, 401);
      assertClean(portal, `${who} portal`);

      const created = await request(server, 'POST', '/api/experiments', {
        name: 'should-not-create',
        url_match: '/pricing',
        client_id: aClient.rows[0].id,
        allowed_hosts: ['alpha.example'],
      });
      assert.strictEqual(created.status, 404);
      assertClean(created, `${who} create with Alpha's client`);

      const siteAdd = await request(server, 'POST', '/api/sites', { website: 'alpha.example' });
      if (who === 'owner B') {
        assert.strictEqual(siteAdd.status, 201, siteAdd.text);
        assert.strictEqual(
          siteAdd.json.domain_warning,
          'This domain is already in use. A test runs only where this site\'s snippet is installed.'
        );
        assert.ok(!siteAdd.text.includes(alpha.id));
        assert.ok(!siteAdd.text.includes('Alpha Ltd'));
        assert.ok(!siteAdd.text.includes(alpha.key));
      } else {
        assert.notStrictEqual(siteAdd.status, 201);
      }
      assertClean(siteAdd, `${who} add site`);

      const view = await request(server, 'POST', '/api/auth/view-as', { account_id: alpha.id });
      assert.strictEqual(view.status, 404);
      assertClean(view, `${who} view as`);
    }

    await denyOwner(serverB, 'owner B');
    await denyOwner(serverMember, 'member B');
    const alphaRole = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, alpha.userId]
    );
    assert.strictEqual(alphaRole.rows[0].role, 'owner');

    const clientPaths = [
      ['GET', `/api/client/experiments/${aRunning.id}`],
      ['GET', `/api/client/experiments/${aDraft.id}`],
      ['POST', `/api/client/experiments/${aRunning.id}/review-request`, {}],
      ['GET', `/api/client/results/${aRunning.id}`],
      ['GET', `/api/client/results/${aRunning.id}/timeseries`],
      ['GET', `/api/client/results/${aRunning.id}/bayesian`],
    ];
    const clientList = await request(serverClientB, 'GET', '/api/client/experiments');
    assert.strictEqual(clientList.status, 200);
    assert.ok(clientList.json.experiments.some((exp) => exp.id === bRunning.id));
    assert.ok(!clientList.json.experiments.some((exp) => exp.id === aRunning.id));
    assertClean(clientList, 'client B list');
    for (const [method, urlPath, body] of clientPaths) {
      await expectHidden(serverClientB, method, urlPath, body, `client B ${method} ${urlPath}`);
    }
    const clientMissing = await request(serverClientB, 'GET', `/api/client/experiments/${MISSING_ID}`);
    const clientPresent = await request(serverClientB, 'GET', `/api/client/experiments/${aRunning.id}`);
    assert.strictEqual(clientPresent.status, clientMissing.status);
    assert.strictEqual(clientPresent.text, clientMissing.text);

    const clientExport = await request(serverClientB, 'GET', `/api/results/${aRunning.id}/export`);
    assert.strictEqual(clientExport.status, 401);
    assertClean(clientExport, 'client B owner export');
    const clientMe = await request(serverClientB, 'GET', '/api/auth/me');
    assert.strictEqual(clientMe.json.role, 'client');
    assert.strictEqual(clientMe.json.client.id, bClient.rows[0].id);
    assertClean(clientMe, 'client B session');
    const clientView = await request(serverClientB, 'POST', '/api/auth/view-as', { account_id: alpha.id });
    assert.strictEqual(clientView.status, 404);
    assertClean(clientView, 'client B view as');
    const clientAudit = await request(serverClientB, 'GET', '/api/audit');
    assert.strictEqual(clientAudit.status, 401);
    assertClean(clientAudit, 'client B audit');
    const clientRole = await request(serverClientB, 'PATCH', `/api/account/members/${alpha.userId}`, { role: 'member' });
    assert.strictEqual(clientRole.status, 401);
    assertClean(clientRole, 'client B role change');

    const mixed = await request(serverMixed, 'GET', '/api/client/experiments');
    assert.strictEqual(mixed.status, 401);
    assertClean(mixed, 'Alpha client id on Beta account');
    const mixedDetail = await request(serverMixed, 'GET', `/api/client/experiments/${aRunning.id}`);
    assert.strictEqual(mixedDetail.status, 401);
    assertClean(mixedDetail, 'mixed session detail');

    const signedOut = [
      ['GET', `/api/experiments/${aRunning.id}`],
      ['GET', '/api/experiments/all'],
      ['GET', `/api/results/${aRunning.id}`],
      ['GET', `/api/results/${aRunning.id}/export`],
      ['GET', '/api/clients'],
      ['GET', '/api/client/experiments'],
      ['GET', `/api/client/experiments/${aRunning.id}`],
      ['GET', '/api/audit'],
      ['GET', '/api/host-hits'],
      ['GET', '/api/review-requests'],
      ['GET', '/api/setup'],
      ['GET', '/api/goals/popular'],
    ];
    for (const [method, urlPath] of signedOut) {
      const res = await request(publicServer, method, urlPath);
      assert.strictEqual(res.status, 401, `signed out ${method} ${urlPath} -> ${res.status} ${res.text.slice(0, 200)}`);
      assertClean(res, `signed out ${urlPath}`);
    }
    // Superadmin routes answer 404 when there is no superadmin session, the
    // same reply as a missing record, so the path does not advertise itself.
    for (const urlPath of ['/api/admin/accounts', '/api/invites', '/api/access-requests']) {
      const res = await request(publicServer, 'GET', urlPath);
      assert.strictEqual(res.status, 404, `signed out GET ${urlPath} -> ${res.status} ${res.text.slice(0, 200)}`);
      assertClean(res, `signed out ${urlPath}`);
    }

    async function listedIds(pageUrl, site) {
      const res = await request(publicServer, 'GET', snippetPath(pageUrl, site), null, originFor(pageUrl));
      assert.strictEqual(res.status, 200, res.text.slice(0, 200));
      return { ids: (res.json.experiments || []).map((exp) => exp.id), res };
    }

    const crossKey = await listedIds(ALPHA_PAGE, beta.key);
    assert.deepStrictEqual(crossKey.ids, []);
    assertClean(crossKey.res, 'Beta key on Alpha host');
    const crossHost = await listedIds(BETA_PAGE, alpha.key);
    assert.deepStrictEqual(crossHost.ids, []);
    assertClean(crossHost.res, 'Alpha key on Beta host');
    const noKey = await listedIds(ALPHA_PAGE, null);
    assert.deepStrictEqual(noKey.ids, []);
    assertClean(noKey.res, 'no site key');
    const unknownKey = await listedIds(ALPHA_PAGE, newSiteKey());
    assert.deepStrictEqual(unknownKey.ids, []);
    assertClean(unknownKey.res, 'unknown site key');
    const badKey = await listedIds(ALPHA_PAGE, 'site_' + 'g'.repeat(20));
    assert.deepStrictEqual(badKey.ids, []);
    assertClean(badKey.res, 'invalid site key');

    async function listedByIds(pageUrl, site) {
      const res = await request(
        publicServer,
        'GET',
        byIdsPath([aRunning.id, aDraft.id, bRunning.id], pageUrl, site),
        null,
        originFor(pageUrl)
      );
      assert.strictEqual(res.status, 200);
      return { ids: (res.json.experiments || []).map((exp) => exp.id), res };
    }
    // by-ids ignores status and the page path. It still keeps the site and the host.
    const byAlpha = await listedByIds(ALPHA_PAGE, alpha.key);
    assert.deepStrictEqual(byAlpha.ids.slice().sort(), [aRunning.id, aDraft.id].sort());
    assert.ok(!byAlpha.ids.includes(bRunning.id));
    const byBeta = await listedByIds(BETA_PAGE, beta.key);
    assert.deepStrictEqual(byBeta.ids, [bRunning.id]);
    assertClean(byBeta.res, 'by-ids Beta');
    const byCross = await listedByIds(ALPHA_PAGE, beta.key);
    assert.deepStrictEqual(byCross.ids, []);
    assertClean(byCross.res, 'by-ids Beta key');
    const byNone = await listedByIds(ALPHA_PAGE, null);
    assert.deepStrictEqual(byNone.ids, []);
    assertClean(byNone.res, 'by-ids without a key');

    const draftToken = createPreviewToken(aDraft.variantId, undefined, undefined, {
      accountId: alpha.id,
      siteId: alpha.siteId,
    });
    const previewOk = await request(
      publicServer,
      'GET',
      snippetPath(ALPHA_DRAFT_PAGE, alpha.key) +
        `&preview=1&preview_variant=${aDraft.variantId}&preview_token=${encodeURIComponent(draftToken)}`,
      null,
      originFor(ALPHA_DRAFT_PAGE)
    );
    assert.ok(previewOk.json.experiments.some((exp) => exp.id === aDraft.id));
    assert.ok(previewOk.text.includes('alpha-secret-draft'));
    const previewCross = await request(
      publicServer,
      'GET',
      snippetPath(ALPHA_DRAFT_PAGE, beta.key) +
        `&preview=1&preview_variant=${aDraft.variantId}&preview_token=${encodeURIComponent(draftToken)}`,
      null,
      originFor(ALPHA_DRAFT_PAGE)
    );
    assert.ok(!(previewCross.json.experiments || []).some((exp) => exp.id === aDraft.id));
    assertClean(previewCross, 'preview token with Beta key');
    const previewHost = await request(
      publicServer,
      'GET',
      snippetPath('https://beta.example/draft-page', alpha.key) +
        `&preview=1&preview_variant=${aDraft.variantId}&preview_token=${encodeURIComponent(draftToken)}`,
      null,
      originFor(BETA_PAGE)
    );
    assert.ok(!(previewHost.json.experiments || []).some((exp) => exp.id === aDraft.id));
    assertClean(previewHost, 'preview token on Beta host');

    async function dropTotal(experimentId) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(drop_count), 0)::int AS n FROM event_drops WHERE experiment_id = $1`,
        [experimentId]
      );
      return rows[0].n;
    }
    // The counter is written after the 204, so poll until it shows up or the wait ends.
    async function waitForDrops(experimentId, expected) {
      const deadline = Date.now() + 2000;
      let n = await dropTotal(experimentId);
      while (n !== expected && Date.now() < deadline) {
        await pause(25);
        n = await dropTotal(experimentId);
      }
      return n;
    }

    const dropsBefore = await dropTotal(aRunning.id);
    async function postEvent(site, experiment, variant, visitor, origin) {
      const body = {
        experiment_id: experiment,
        variant_id: variant,
        visitor_id: visitor,
        event_type: 'view',
      };
      if (site) body.site = site;
      return request(publicServer, 'POST', '/api/event', body, { origin });
    }
    assert.strictEqual((await postEvent(beta.key, aRunning.id, aRunning.variantId, 'dropped-b-key', 'https://alpha.example')).status, 204);
    assert.strictEqual((await postEvent(null, aRunning.id, aRunning.variantId, 'dropped-no-key', 'https://alpha.example')).status, 204);
    assert.strictEqual((await postEvent(alpha.key, bRunning.id, bRunning.variantId, 'dropped-a-key-on-b', 'https://beta.example')).status, 204);
    assert.strictEqual((await postEvent(alpha.key, aRunning.id, bRunning.variantId, 'dropped-wrong-variant', 'https://alpha.example')).status, 400);
    assert.strictEqual(await waitForDrops(aRunning.id, dropsBefore + 1), dropsBefore);

    assert.strictEqual((await postEvent(alpha.key, aRunning.id, aRunning.variantId, 'stored-on-alpha', 'https://alpha.example')).status, 204);
    const sameAccountDrops = await dropTotal(aRunning.id);
    assert.strictEqual((await postEvent(alpha.key, aRunning.id, aRunning.variantId, 'dropped-wrong-host', 'https://beta.example')).status, 204);
    assert.strictEqual((await postEvent(beta.key, bRunning.id, bRunning.variantId, 'stored-on-beta', 'https://beta.example')).status, 204);
    assert.strictEqual(await waitForDrops(aRunning.id, sameAccountDrops + 1), sameAccountDrops + 1);

    const stored = await db.query(
      `SELECT visitor_id FROM events WHERE visitor_id LIKE 'stored-%' OR visitor_id LIKE 'dropped-%' ORDER BY visitor_id`
    );
    assert.deepStrictEqual(stored.rows.map((row) => row.visitor_id), ['stored-on-alpha', 'stored-on-beta']);

    const wrongToken = createEditToken(aRunning.variantId, undefined, { accountId: beta.id, siteId: beta.siteId });
    const editorGet = await request(publicServer, 'GET', `/api/editor/variants/${aRunning.variantId}?token=${encodeURIComponent(wrongToken)}`);
    assert.strictEqual(editorGet.status, 401);
    assertClean(editorGet, 'editor read with Beta account on the token');
    const editorPatch = await request(
      publicServer,
      'PATCH',
      `/api/editor/variants/${aRunning.variantId}?token=${encodeURIComponent(wrongToken)}`,
      { changes: [{ type: 'text', selector: 'h1', value: 'hacked-from-beta' }] }
    );
    assert.strictEqual(editorPatch.status, 401);
    assertClean(editorPatch, 'editor write with Beta account on the token');
    const editorPreview = await request(
      publicServer,
      'GET',
      `/api/editor/variants/${aRunning.variantId}/preview-token?token=${encodeURIComponent(wrongToken)}`
    );
    assert.strictEqual(editorPreview.status, 401);
    assertClean(editorPreview, 'editor preview token');
    const betaToken = createEditToken(bRunning.variantId, undefined, { accountId: beta.id, siteId: beta.siteId });
    const swapped = await request(
      publicServer,
      'GET',
      `/api/editor/variants/${aRunning.variantId}?token=${encodeURIComponent(betaToken)}`
    );
    assert.strictEqual(swapped.status, 401);
    assertClean(swapped, 'Beta edit token on Alpha variant');

    const superUser = await db.query(`SELECT id FROM users WHERE is_superadmin IS TRUE LIMIT 1`);
    const legacy = await db.query(`SELECT id FROM accounts WHERE legacy IS TRUE LIMIT 1`);
    const viewSession = {
      role: 'owner',
      userId: superUser.rows[0].id,
      accountId: legacy.rows[0].id,
      superadmin: true,
      save(cb) { cb(); },
    };
    const viewServer = await listen(appFor(viewSession));
    servers.push(viewServer);

    const home = await request(viewServer, 'GET', `/api/experiments/${aRunning.id}`);
    assert.strictEqual(home.status, 404);
    assertClean(home, 'superadmin without view as');
    const directory = await request(viewServer, 'GET', '/api/admin/accounts');
    assert.strictEqual(directory.status, 200);
    assert.ok(directory.json.accounts.some((account) => account.id === alpha.id));
    assert.ok(directory.json.accounts.some((account) => account.id === beta.id));

    const started = await request(viewServer, 'POST', '/api/auth/view-as', { account_id: alpha.id });
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.json.view_as.id, alpha.id);
    const seen = await request(viewServer, 'GET', `/api/experiments/${aRunning.id}`);
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.json.name, 'Alpha pricing test');
    const exported = await request(viewServer, 'GET', `/api/results/${aRunning.id}/export`);
    assert.strictEqual(exported.status, 200);
    assert.ok(exported.text.includes('alpha-secret-visitor'));
    const viewedAudit = await request(viewServer, 'GET', '/api/audit');
    assert.ok(viewedAudit.text.includes('alpha-secret-audit'));
    assert.ok(!viewedAudit.text.includes('beta-secret-audit'));

    const viewWrites = [
      ['PATCH', `/api/experiments/${aRunning.id}/status`, { status: 'paused' }],
      ['PATCH', `/api/experiments/${aRunning.id}/status`, { status: 'archived', archive: true }],
      ['PATCH', `/api/experiments/${aDraft.id}/status`, { status: 'running' }],
      ['DELETE', `/api/experiments/${aArchived.id}`],
      ['PATCH', `/api/experiments/${aRunning.id}/variants/${aSpare.rows[0].id}`, { name: 'Hacked', traffic_split: 1 }],
      ['PUT', `/api/experiments/${aRunning.id}/goals`, { goals: [{ type: 'click', selector: '.nope', name: 'Nope' }] }],
      ['DELETE', `/api/clients/${aClient.rows[0].id}`],
      ['POST', `/api/experiments/${aRunning.id}/reveal`, { confirm: true }],
      ['PUT', `/api/experiments/${aRunning.id}/plan`, {}],
      ['POST', `/api/experiments/${aRunning.id}/test-traffic/remove`, { mode: 'test', confirm: true }],
      ['POST', `/api/review-requests/${aReview.rows[0].id}/decide`, {}],
      ['POST', '/api/sites', { website: 'evil.example' }],
      ['PATCH', `/api/account/members/${alpha.userId}`, { role: 'member' }],
    ];
    for (const [method, urlPath, body] of viewWrites) {
      const res = await request(viewServer, method, urlPath, body);
      assert.strictEqual(res.status, 403, `view as ${method} ${urlPath} -> ${res.status} ${res.text.slice(0, 200)}`);
      assert.ok(/read-only/i.test(res.text));
    }
    const hiddenInvites = await request(viewServer, 'GET', '/api/invites');
    assert.strictEqual(hiddenInvites.status, 403);
    const roleAfterView = await db.query(
      `SELECT role FROM memberships WHERE account_id = $1 AND user_id = $2`,
      [alpha.id, alpha.userId]
    );
    assert.strictEqual(roleAfterView.rows[0].role, 'owner');

    const viewRow = await db.query(
      `SELECT account_id, actor_user_id, action FROM audit_log WHERE action = 'view_as' ORDER BY id DESC LIMIT 1`
    );
    assert.strictEqual(viewRow.rows[0].account_id, alpha.id);
    assert.strictEqual(viewRow.rows[0].actor_user_id, superUser.rows[0].id);

    const stopped = await request(viewServer, 'POST', '/api/auth/view-as/stop', {});
    assert.strictEqual(stopped.status, 200);
    assert.strictEqual(stopped.json.view_as, null);
    const stopRow = await db.query(
      `SELECT account_id, action FROM audit_log WHERE action = 'view_as_stop' ORDER BY id DESC LIMIT 1`
    );
    assert.strictEqual(stopRow.rows[0].account_id, alpha.id);
    const afterStop = await request(viewServer, 'GET', `/api/experiments/${aRunning.id}`);
    assert.strictEqual(afterStop.status, 404);

    const asBeta = await request(viewServer, 'POST', '/api/auth/view-as', { account_id: beta.id });
    assert.strictEqual(asBeta.status, 200);
    const betaAudit = await request(viewServer, 'GET', '/api/audit');
    assert.ok(betaAudit.text.includes('beta-secret-audit'));
    assert.ok(!betaAudit.text.includes('alpha-secret-audit'));
    const stillHidden = await request(viewServer, 'GET', `/api/experiments/${aRunning.id}`);
    assert.strictEqual(stillHidden.status, 404);
    assertClean(stillHidden, 'view as Beta reading Alpha');

    async function untouched() {
      const running = await db.query(
        `SELECT status, allowed_hosts, url_match_type, client_id, goals, peeked_at, hypothesis, plan
         FROM experiments WHERE id = $1`,
        [aRunning.id]
      );
      assert.strictEqual(running.rows[0].status, 'running');
      assert.deepStrictEqual(running.rows[0].allowed_hosts, ['alpha.example']);
      assert.strictEqual(running.rows[0].url_match_type, 'contains');
      assert.strictEqual(running.rows[0].client_id, aClient.rows[0].id);
      assert.deepStrictEqual(running.rows[0].goals, []);
      assert.strictEqual(running.rows[0].peeked_at, null);
      assert.strictEqual(running.rows[0].hypothesis, 'alpha-secret-hypothesis');
      assert.strictEqual(running.rows[0].plan, null);

      const draft = await db.query(`SELECT status FROM experiments WHERE id = $1`, [aDraft.id]);
      assert.strictEqual(draft.rows[0].status, 'draft');
      const archived = await db.query(`SELECT status FROM experiments WHERE id = $1`, [aArchived.id]);
      assert.strictEqual(archived.rows[0].status, 'archived');

      const variants = await db.query(
        `SELECT name, enabled, changes FROM variants WHERE experiment_id = $1 ORDER BY name`,
        [aRunning.id]
      );
      assert.deepStrictEqual(variants.rows.map((row) => row.name), ['Control', 'Spare']);
      assert.ok(variants.rows.every((row) => row.enabled === true));
      const control = variants.rows.find((row) => row.name === 'Control');
      assert.strictEqual(control.changes[0].value, 'alpha-secret-headline');

      const visitors = await db.query(
        `SELECT visitor_id FROM events WHERE experiment_id = $1 ORDER BY visitor_id`,
        [aRunning.id]
      );
      assert.deepStrictEqual(visitors.rows.map((row) => row.visitor_id), ['alpha-secret-visitor', 'stored-on-alpha']);

      const client = await db.query(`SELECT name, username FROM clients WHERE id = $1`, [aClient.rows[0].id]);
      assert.strictEqual(client.rows[0].name, 'Alpha Client');
      assert.strictEqual(client.rows[0].username, 'alpha-client');

      const review = await db.query(`SELECT decided_at FROM review_requests WHERE id = $1`, [aReview.rows[0].id]);
      assert.strictEqual(review.rows[0].decided_at, null);
      const reviewCount = await db.query(
        `SELECT COUNT(*)::int AS n FROM review_requests WHERE experiment_id = $1`,
        [aRunning.id]
      );
      assert.strictEqual(reviewCount.rows[0].n, 1);

      const site = await db.query(`SELECT domains, conflict FROM sites WHERE id = $1`, [alpha.siteId]);
      assert.deepStrictEqual(site.rows[0].domains, ['alpha.example']);
      assert.strictEqual(site.rows[0].conflict, true);
      const betaSites = await db.query(`SELECT COUNT(*)::int AS n FROM sites WHERE account_id = $1`, [beta.id]);
      assert.strictEqual(betaSites.rows[0].n, 2);
      const created = await db.query(`SELECT id FROM experiments WHERE name = 'should-not-create'`);
      assert.strictEqual(created.rows.length, 0);
    }
    await untouched();

    console.log('cross-account tests passed');
  } finally {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (db.pool) await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
