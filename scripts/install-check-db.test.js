// PIV-024. A site key serves only that site, then the host check. A tag with
// no key serves only Heclr (account #1). A missing, invalid or foreign key on
// an unverified site is explained on the setup screen and does not change the
// public snippet response. The verified cantsaythat tag keeps working.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const pg = require('./test-postgres');

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
    next();
  });
  app.use('/api/setup', require('../src/routes/setup').setupRouter);
  app.use('/api/experiments', require('../src/routes/experiments'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function idsOf(res) {
  return (res.json.experiments || []).map((exp) => exp.id);
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.ok(!schema.includes('install_note'), 'install_note must not be added in schema.sql');
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(migrateSrc.includes("{ version: '006', name: 'install-check', run: applyInstallCheck }"));

  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('install check db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_install_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { applyInstallCheck } = require('../src/db/install-check');
  const { newSiteKey } = require('../src/db/tenancy');
  const { clearLegacyCache } = require('../src/tenant');
  const ui = require('../public/admin-ui.js');
  const { installCheckPayload } = require('../src/site-verify');
  const nasty = installCheckPayload('missing', 'example.co.uk<script>');
  assert.ok(!nasty.message.includes('<'));
  assert.ok(nasty.message.includes('no site key'));
  assert.strictEqual(installCheckPayload('nope', 'example.co.uk'), null);

  const servers = [];
  try {
    await migrate();
    clearLegacyCache();

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await applyInstallCheck(client);
      await applyInstallCheck(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const legacy = await db.query(
      `SELECT a.id, a.name, s.id AS site_id, s.public_key, s.domains, s.verified_at
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE`
    );
    assert.strictEqual(legacy.rows.length, 1);
    assert.strictEqual(legacy.rows[0].name, 'Heclr');
    assert.ok(legacy.rows[0].verified_at);
    const heclrId = legacy.rows[0].id;
    const liveSiteId = legacy.rows[0].site_id;
    const liveKey = legacy.rows[0].public_key;

    async function makeExperiment(accountId, siteId, name, host) {
      const exp = await db.query(
        `INSERT INTO experiments
           (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
         VALUES ($1, '/pricing', 'running', $2::text[], $3, $4, '[]'::jsonb, 'shared', true)
         RETURNING id`,
        [name, [host], accountId, siteId]
      );
      const variant = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 100) RETURNING id`,
        [exp.rows[0].id]
      );
      return { id: exp.rows[0].id, variantId: variant.rows[0].id };
    }

    const live = await makeExperiment(heclrId, liveSiteId, 'Live tag', 'cantsaythat.co.uk');

    const heclrExampleKey = newSiteKey();
    const heclrExample = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
       VALUES ($1, 'example.co.uk', $2::text[], $3, now()) RETURNING id`,
      [heclrId, ['example.co.uk'], heclrExampleKey]
    );
    const onCustomerHost = await makeExperiment(
      heclrId,
      heclrExample.rows[0].id,
      'Heclr on customer host',
      'example.co.uk'
    );

    const other = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Acme Ltd', false) RETURNING id`
    );
    const acmeId = other.rows[0].id;
    const acmeKey = newSiteKey();
    const acmeSite = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key)
       VALUES ($1, 'example.co.uk', $2::text[], $3) RETURNING id`,
      [acmeId, ['example.co.uk'], acmeKey]
    );
    const acmeSiteId = acmeSite.rows[0].id;
    const acme = await makeExperiment(acmeId, acmeSiteId, 'Acme pricing', 'example.co.uk');
    const acmeDraft = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, goals, goals_scope, goals_migrated)
       VALUES ('Acme draft', '/pricing', 'draft', $1::text[], $2, $3, '[]'::jsonb, 'shared', true)
       RETURNING id`,
      [['example.co.uk'], acmeId, acmeSiteId]
    );

    const publicServer = await listen(appFor({}));
    const acmeServer = await listen(appFor({ role: 'owner', accountId: acmeId }));
    servers.push(publicServer, acmeServer);

    const livePage = '/api/experiments?url=' + encodeURIComponent('https://cantsaythat.co.uk/pricing');
    const acmePage = '/api/experiments?url=' + encodeURIComponent('https://example.co.uk/pricing');
    const liveOrigin = { origin: 'https://cantsaythat.co.uk' };
    const acmeOrigin = { origin: 'https://www.example.co.uk' };

    const legacyLive = await request(publicServer, 'GET', livePage, null, liveOrigin);
    assert.strictEqual(legacyLive.status, 200);
    assert.ok(idsOf(legacyLive).includes(live.id));
    assert.ok(!idsOf(legacyLive).includes(acme.id));
    assert.ok(!legacyLive.text.includes('install_check'));
    const liveNote = await db.query(
      `SELECT install_note FROM sites WHERE id = $1`,
      [liveSiteId]
    );
    assert.strictEqual(liveNote.rows[0].install_note, null);

    const legacyCustomerHost = await request(publicServer, 'GET', acmePage, null, acmeOrigin);
    assert.deepStrictEqual(idsOf(legacyCustomerHost), [onCustomerHost.id]);
    assert.ok(!legacyCustomerHost.text.includes('site key'));
    const setupMissing = await request(acmeServer, 'GET', '/api/setup');
    assert.strictEqual(setupMissing.json.site.public_key, acmeKey);
    assert.strictEqual(setupMissing.json.site.verified, false);
    assert.strictEqual(setupMissing.json.site.install_check.reason, 'missing');
    assert.ok(setupMissing.json.site.install_check.message.includes('example.co.uk'));
    assert.ok(setupMissing.json.site.install_check.message.includes('no site key'));
    assert.ok(setupMissing.json.site.install_check.message.includes('pivitlab'));
    assert.ok(!setupMissing.json.site.install_check.message.includes('Pivit'));
    const tag = ui.snippetTag('https://pivitlab.com', setupMissing.json.site.public_key);
    assert.ok(tag.includes(`data-site="${acmeKey}"`));
    const line = ui.installCheckLine(setupMissing.json.site, 'example.co.uk');
    assert.strictEqual(line.problem, true);
    assert.strictEqual(line.text, setupMissing.json.site.install_check.message);

    const blockedStart = await request(
      acmeServer,
      'PATCH',
      `/api/experiments/${acmeDraft.rows[0].id}/status`,
      { status: 'running' }
    );
    assert.strictEqual(blockedStart.status, 400);
    assert.ok(blockedStart.json.error.includes('no site key'));

    const invalid = await request(
      publicServer,
      'GET',
      acmePage + '&site=site_' + 'g'.repeat(20),
      null,
      acmeOrigin
    );
    assert.strictEqual(invalid.status, 200);
    assert.deepStrictEqual(idsOf(invalid), []);
    const setupInvalid = await request(acmeServer, 'GET', '/api/setup');
    assert.strictEqual(setupInvalid.json.site.install_check.reason, 'invalid');
    assert.ok(setupInvalid.json.site.install_check.message.includes('not valid'));

    const unknown = await request(
      publicServer,
      'GET',
      acmePage + '&site=' + encodeURIComponent(newSiteKey()),
      null,
      acmeOrigin
    );
    assert.deepStrictEqual(idsOf(unknown), []);
    const setupUnknown = await request(acmeServer, 'GET', '/api/setup');
    assert.strictEqual(setupUnknown.json.site.install_check.reason, 'wrong');
    assert.ok(setupUnknown.json.site.install_check.message.includes('did not match this agency'));

    const foreignKey = await request(
      publicServer,
      'GET',
      acmePage + '&site=' + encodeURIComponent(heclrExampleKey),
      null,
      acmeOrigin
    );
    assert.deepStrictEqual(idsOf(foreignKey), [onCustomerHost.id]);
    const setupForeign = await request(acmeServer, 'GET', '/api/setup');
    assert.strictEqual(setupForeign.json.site.install_check.reason, 'wrong');
    assert.strictEqual(setupForeign.json.site.verified, false);

    const keyed = await request(
      publicServer,
      'GET',
      acmePage + '&site=' + encodeURIComponent(acmeKey),
      null,
      acmeOrigin
    );
    assert.deepStrictEqual(idsOf(keyed), [acme.id]);
    const setupSeen = await request(acmeServer, 'GET', '/api/setup');
    assert.strictEqual(setupSeen.json.site.verified, true);
    assert.strictEqual(setupSeen.json.site.install_check, null);
    const cleared = ui.installCheckLine(setupSeen.json.site, 'example.co.uk');
    assert.strictEqual(cleared.text, 'We can see pivitlab on example.co.uk.');

    const started = await request(
      acmeServer,
      'PATCH',
      `/api/experiments/${acmeDraft.rows[0].id}/status`,
      { status: 'running' }
    );
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.json.status, 'running');

    const stillLive = await request(publicServer, 'GET', livePage, null, liveOrigin);
    assert.ok(idsOf(stillLive).includes(live.id));
    assert.ok(!idsOf(stillLive).includes(acme.id));
    const liveNoteAfter = await db.query(
      `SELECT install_note, verified_at IS NOT NULL AS verified FROM sites WHERE id = $1`,
      [liveSiteId]
    );
    assert.strictEqual(liveNoteAfter.rows[0].install_note, null);
    assert.strictEqual(liveNoteAfter.rows[0].verified, true);

    const keyedLive = await request(
      publicServer,
      'GET',
      livePage + '&site=' + encodeURIComponent(liveKey),
      null,
      liveOrigin
    );
    assert.ok(idsOf(keyedLive).includes(live.id));
    assert.ok(!idsOf(keyedLive).includes(acme.id));

    const secondLegacy = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Second legacy', true)`
    ).then(() => null, (err) => err);
    assert.ok(secondLegacy, 'a second legacy account must be rejected');

    console.log('install check db tests passed');
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
