// Adding or editing a site warns on a domain another site already uses.
// The same account is blocked. Another account is a neutral warning and the
// save still happens. Setup screens remember an explicit site instead of
// the oldest one.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const pg = require('./test-postgres');
const { DOMAIN_IN_USE_WARNING, sameAccountDomainMessage } = require('../src/site-domain');

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
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/goals', require('../src/routes/goals').router);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function hiddenFrom(text, secrets) {
  for (const secret of secrets) {
    assert.ok(secret && !text.includes(secret), `response included ${secret}`);
  }
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.ok(!schema.includes('active_site_id'));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('site-choice db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_sitechoice_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyActiveSite } = require('../src/db/active-site');
  const { newSiteKey } = require('../src/db/tenancy');
  const { snippetSiteKey } = require('../src/tenant');

  const servers = [];
  try {
    await migrate();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyActiveSite(client);
      await applyActiveSite(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const column = await db.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_name = 'accounts' AND column_name = 'active_site_id'`
    );
    assert.strictEqual(column.rows[0].is_nullable, 'YES');

    const mine = await db.query(`INSERT INTO accounts (name) VALUES ('North Ltd') RETURNING id`);
    const mineId = mine.rows[0].id;
    const other = await db.query(`INSERT INTO accounts (name) VALUES ('South Ltd') RETURNING id`);
    const otherId = other.rows[0].id;
    const otherUser = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@south.example', now()) RETURNING id`
    );
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [otherId, otherUser.rows[0].id]
    );
    const otherKey = newSiteKey();
    const otherSite = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
       VALUES ($1, 'south.example', $2::text[], $3, now()) RETURNING id`,
      [otherId, ['https://www.Shared.example/pricing/', 'south.example'], otherKey]
    );
    const otherGoal = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
       VALUES ('South only', '/pricing', 'draft', $1::text[], $2, $3, $4::jsonb, 'shared', true)
       RETURNING id`,
      [
        ['south.example'],
        otherId,
        otherSite.rows[0].id,
        JSON.stringify([{ type: 'click', selector: '.south-only', name: 'South goal' }]),
      ]
    );
    assert.ok(otherGoal.rows[0].id);

    const server = await listen(appFor({ role: 'owner', accountId: mineId, userId: null }));
    const signedOut = await listen(appFor({}));
    servers.push(server, signedOut);

    const denied = await request(signedOut, 'POST', '/api/sites', { website: 'north.example' });
    assert.strictEqual(denied.status, 401);

    const empty = await request(server, 'GET', '/api/setup');
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.json.site, null);
    assert.deepStrictEqual(empty.json.sites, []);
    assert.strictEqual(empty.json.site_choice_required, false);

    const added = await request(server, 'POST', '/api/sites', {
      website: 'https://WWW.North.example/pricing/',
    });
    assert.strictEqual(added.status, 201, added.text);
    assert.deepStrictEqual(added.json.site.domains, ['north.example']);
    assert.strictEqual(added.json.domain_warning, null);
    assert.strictEqual(added.json.site.conflict, false);
    const firstId = added.json.site.id;

    const one = await request(server, 'GET', '/api/setup');
    assert.strictEqual(one.json.site_choice_required, false);
    assert.strictEqual(one.json.site.id, firstId);
    assert.strictEqual(one.json.sites.length, 1);

    const same = await request(server, 'POST', '/api/sites', { website: 'www.north.example' });
    assert.strictEqual(same.status, 409);
    assert.strictEqual(same.json.error, sameAccountDomainMessage('north.example'));
    assert.ok(!same.text.includes(otherId));
    assert.ok(!same.text.includes('South Ltd'));
    const stillOne = await db.query(`SELECT COUNT(*)::int AS n FROM sites WHERE account_id = $1`, [mineId]);
    assert.strictEqual(stillOne.rows[0].n, 1);

    const second = await request(server, 'POST', '/api/sites', { website: 'shop.north.example' });
    assert.strictEqual(second.status, 201, second.text);
    const secondId = second.json.site.id;
    const choice = await request(server, 'GET', '/api/setup');
    assert.strictEqual(choice.json.site_choice_required, true);
    assert.strictEqual(choice.json.site, null);
    assert.strictEqual(choice.json.sites[0].id, firstId);
    assert.notStrictEqual(choice.json.sites[0].id, choice.json.site && choice.json.site.id);
    assert.strictEqual(await snippetSiteKey(mineId), null);

    const foreignPick = await request(server, 'POST', '/api/setup/site', { site_id: otherSite.rows[0].id });
    assert.strictEqual(foreignPick.status, 404);
    hiddenFrom(foreignPick.text, [otherId, 'South Ltd', 'owner@south.example', otherKey, otherSite.rows[0].id]);
    const notRemembered = await db.query(`SELECT active_site_id FROM accounts WHERE id = $1`, [mineId]);
    assert.strictEqual(notRemembered.rows[0].active_site_id, null);

    const picked = await request(server, 'POST', '/api/setup/site', { site_id: secondId });
    assert.strictEqual(picked.status, 200, picked.text);
    assert.strictEqual(picked.json.site_choice_required, false);
    assert.strictEqual(picked.json.site.id, secondId);
    assert.strictEqual(picked.json.site.public_key, second.json.site.public_key);
    assert.notStrictEqual(picked.json.site.public_key, added.json.site.public_key);
    assert.strictEqual(await snippetSiteKey(mineId), second.json.site.public_key);

    const goalsWaiting = await request(server, 'GET', '/api/goals/popular');
    assert.strictEqual(goalsWaiting.status, 200);
    assert.strictEqual(goalsWaiting.json.site_choice_required, true);
    assert.deepStrictEqual(goalsWaiting.json.goals, []);
    hiddenFrom(goalsWaiting.text, ['South goal', otherId, 'South Ltd']);

    const foreignGoals = await request(server, 'GET', '/api/goals/popular?site_id=' + otherSite.rows[0].id);
    assert.strictEqual(foreignGoals.status, 404);
    hiddenFrom(foreignGoals.text, ['South goal', 'South Ltd', otherKey, 'owner@south.example']);

    await db.query(
      `UPDATE experiments SET goals = $2::jsonb, goals_scope = 'shared'
       WHERE id = $1`,
      [otherGoal.rows[0].id, JSON.stringify([{ type: 'click', selector: '.south-only', name: 'South goal' }])]
    );
    const ownExperiment = await request(server, 'POST', '/api/experiments', {
      name: 'Shop headline',
      url_match: '/pricing',
      allowed_hosts: ['shop.north.example'],
      site_id: secondId,
    });
    assert.strictEqual(ownExperiment.status, 201, ownExperiment.text);
    assert.strictEqual(ownExperiment.json.site_id, secondId);
    await db.query(
      `UPDATE experiments SET goals = $2::jsonb WHERE id = $1`,
      [ownExperiment.json.id, JSON.stringify([{ type: 'click', selector: '.shop-buy', name: 'Shop buy' }])]
    );
    const shopGoals = await request(server, 'GET', '/api/goals/popular?site_id=' + secondId);
    assert.strictEqual(shopGoals.status, 200);
    assert.ok(shopGoals.json.goals.some((goal) => goal.label === 'Shop buy'));
    assert.ok(!shopGoals.json.goals.some((goal) => goal.label === 'South goal'));

    const matched = await request(server, 'POST', '/api/experiments', {
      name: 'Matched by domain',
      url_match: '/about',
      allowed_hosts: ['shop.north.example'],
    });
    assert.strictEqual(matched.status, 201, matched.text);
    assert.strictEqual(matched.json.site_id, secondId);
    assert.notStrictEqual(matched.json.site_id, firstId);
    const stolen = await request(server, 'POST', '/api/experiments', {
      name: 'Stolen',
      url_match: '/about',
      allowed_hosts: ['south.example'],
      site_id: otherSite.rows[0].id,
    });
    assert.strictEqual(stolen.status, 404);
    hiddenFrom(stolen.text, ['South Ltd', 'South goal', otherKey]);
    const stolenRow = await db.query(`SELECT id FROM experiments WHERE name = 'Stolen'`);
    assert.strictEqual(stolenRow.rows.length, 0);

    const clash = await request(server, 'POST', '/api/sites', { website: 'shared.example' });
    assert.strictEqual(clash.status, 201, clash.text);
    assert.strictEqual(clash.json.domain_warning, DOMAIN_IN_USE_WARNING);
    assert.strictEqual(clash.json.site.conflict, true);
    assert.deepStrictEqual(clash.json.site.domains, ['shared.example']);
    hiddenFrom(clash.text, [otherId, 'South Ltd', 'owner@south.example', otherKey, otherSite.rows[0].id, 'South goal']);
    const flagged = await db.query(`SELECT conflict FROM sites WHERE id = $1`, [otherSite.rows[0].id]);
    assert.strictEqual(flagged.rows[0].conflict, true);

    const blockedEdit = await request(server, 'PATCH', '/api/sites/' + secondId, { website: 'WWW.North.example/path' });
    assert.strictEqual(blockedEdit.status, 409);
    assert.strictEqual(blockedEdit.json.error, sameAccountDomainMessage('north.example'));
    const untouchedShop = await db.query(`SELECT domains, verified_at FROM sites WHERE id = $1`, [secondId]);
    assert.deepStrictEqual(untouchedShop.rows[0].domains, ['shop.north.example']);

    await db.query(`UPDATE sites SET verified_at = now() WHERE id = $1`, [secondId]);
    const renamed = await request(server, 'PATCH', '/api/sites/' + secondId, { website: 'fresh.north.example' });
    assert.strictEqual(renamed.status, 200, renamed.text);
    assert.strictEqual(renamed.json.domain_warning, null);
    assert.deepStrictEqual(renamed.json.site.domains, ['fresh.north.example']);
    assert.strictEqual(renamed.json.site.verified, false);
    const cleared = await db.query(`SELECT verified_at FROM sites WHERE id = $1`, [secondId]);
    assert.strictEqual(cleared.rows[0].verified_at, null);

    await db.query(`UPDATE sites SET verified_at = now(), qa_seen_at = now() WHERE id = $1`, [firstId]);
    const kept = await request(server, 'PATCH', '/api/sites/' + firstId, { website: 'north.example' });
    assert.strictEqual(kept.status, 200, kept.text);
    assert.strictEqual(kept.json.domain_warning, null);
    assert.strictEqual(kept.json.site.verified, true);
    const stillVerified = await db.query(`SELECT verified_at, qa_seen_at FROM sites WHERE id = $1`, [firstId]);
    assert.ok(stillVerified.rows[0].verified_at);
    assert.ok(stillVerified.rows[0].qa_seen_at);

    const otherServer = await listen(appFor({ role: 'owner', accountId: otherId, userId: otherUser.rows[0].id }));
    servers.push(otherServer);
    const peek = await request(otherServer, 'GET', '/api/sites');
    assert.strictEqual(peek.status, 200);
    assert.ok(peek.json.sites.every((site) => site.id !== firstId && site.id !== secondId));
    assert.ok(!peek.text.includes('north.example'));
    assert.ok(!peek.text.includes(mineId));

    console.log('site-choice db tests passed');
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
