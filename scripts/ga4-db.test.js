// Paid plan is a per-agency flag. Send to GA4 is per site. The public
// snippet only receives a measurement ID when both are on.
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
    req.session = Object.assign({}, session);
    req.ip = '127.0.0.1';
    next();
  });
  app.use('/api/sites', require('../src/routes/setup').sitesRouter);
  app.use('/api/admin', require('../src/routes/ga4-admin'));
  app.use('/api/experiments', require('../src/routes/experiments'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function column(db, table, name) {
  return db.query(
    `SELECT column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name]
  ).then((result) => result.rows[0] || null);
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('ga4 db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_ga4_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'enforce';
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const servers = [];
  try {
    const applied = await migrate();
    assert.ok(applied.includes('018'));
    const again = await migrate();
    assert.deepStrictEqual(again, []);

    const paid = await column(db, 'accounts', 'paid_plan');
    assert.strictEqual(paid.is_nullable, 'NO');
    assert.ok(String(paid.column_default).includes('false'));
    const enabled = await column(db, 'sites', 'ga4_enabled');
    assert.strictEqual(enabled.is_nullable, 'NO');
    assert.ok(String(enabled.column_default).includes('false'));
    const measurement = await column(db, 'sites', 'ga4_measurement_id');
    assert.strictEqual(measurement.is_nullable, 'YES');
    assert.strictEqual(measurement.column_default, null);

    const north = await db.query(`INSERT INTO accounts (name) VALUES ('North Ltd') RETURNING id`);
    const south = await db.query(`INSERT INTO accounts (name) VALUES ('South Ltd') RETURNING id`);
    const northId = north.rows[0].id;
    const southId = south.rows[0].id;
    const owner = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@north.example', now()) RETURNING id`
    );
    const adminUser = await db.query(
      `INSERT INTO users (email, verified_at, is_superadmin) VALUES ('admin@pivitlab.test', now(), true) RETURNING id`
    );
    const stranger = await db.query(
      `INSERT INTO users (email, verified_at) VALUES ('owner@south.example', now()) RETURNING id`
    );
    const ownerId = owner.rows[0].id;
    const adminId = adminUser.rows[0].id;
    const strangerId = stranger.rows[0].id;
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [northId, ownerId, southId, strangerId]
    );

    const ownerServer = await listen(appFor({ role: 'owner', accountId: northId, userId: ownerId }));
    const adminServer = await listen(appFor({ role: 'owner', accountId: northId, userId: adminId }));
    const southServer = await listen(appFor({ role: 'owner', accountId: southId, userId: strangerId }));
    const viewServer = await listen(appFor({
      role: 'owner',
      accountId: northId,
      userId: adminId,
      viewAsAccountId: northId,
    }));
    const publicServer = await listen(appFor({}));
    servers.push(ownerServer, adminServer, southServer, viewServer, publicServer);

    const hidden = await request(ownerServer, 'GET', '/api/admin/ga4');
    assert.strictEqual(hidden.status, 404);
    const badFlag = await request(adminServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: 'yes' });
    assert.strictEqual(badFlag.status, 400);
    const missingAccount = await request(adminServer, 'PATCH', '/api/admin/accounts/not-a-uuid/paid-plan', { paid_plan: true });
    assert.strictEqual(missingAccount.status, 404);
    const viewToggle = await request(viewServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: true });
    assert.strictEqual(viewToggle.status, 403);

    const added = await request(ownerServer, 'POST', '/api/sites', { website: 'shop.example' });
    assert.strictEqual(added.status, 201, added.text);
    assert.strictEqual(added.json.site.ga4_enabled, false);
    assert.strictEqual(added.json.site.ga4_available, false);
    assert.strictEqual(added.json.site.ga4_measurement_id, '');
    const siteId = added.json.site.id;
    const siteKey = added.json.site.public_key;

    const placeholderFile = await request(ownerServer, 'GET', `/api/sites/${siteId}/ga4/container.json`);
    assert.strictEqual(placeholderFile.status, 200, placeholderFile.text);
    assert.ok(String(placeholderFile.headers['content-disposition']).includes('pivitlab-ga4.json'));
    assert.strictEqual(placeholderFile.json.exportFormatVersion, 2);
    assert.ok(placeholderFile.json.containerVersion.variable.some((item) => item.name === 'pivitlab - GA4 measurement ID'));
    assert.ok(!placeholderFile.text.includes('G-TEST1234'));
    const strangerFile = await request(southServer, 'GET', `/api/sites/${siteId}/ga4/container.json`);
    assert.strictEqual(strangerFile.status, 404);
    const signedOutFile = await request(publicServer, 'GET', `/api/sites/${siteId}/ga4/container.json`);
    assert.strictEqual(signedOutFile.status, 401);

    const tooSoon = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, {
      measurement_id: 'g-test1234',
      enabled: true,
    });
    assert.strictEqual(tooSoon.status, 403, tooSoon.text);
    const invalid = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, {
      measurement_id: 'UA-123456-1',
      enabled: false,
    });
    assert.strictEqual(invalid.status, 400, invalid.text);
    const stored = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, {
      measurement_id: ' g-test1234 ',
      enabled: false,
    });
    assert.strictEqual(stored.status, 200, stored.text);
    assert.strictEqual(stored.json.site.ga4_measurement_id, 'G-TEST1234');
    assert.strictEqual(stored.json.site.ga4_enabled, false);
    const savedFile = await request(ownerServer, 'GET', `/api/sites/${siteId}/ga4/container.json`);
    assert.strictEqual(savedFile.status, 200, savedFile.text);
    const savedTag = savedFile.json.containerVersion.tag[0];
    const savedId = savedTag.parameter.find((item) => item.key === 'measurementIdOverride');
    assert.strictEqual(savedId.value, 'G-TEST1234');
    assert.ok(!savedFile.json.containerVersion.variable.some((item) => item.type === 'c'));
    const viewFile = await request(viewServer, 'GET', `/api/sites/${siteId}/ga4/container.json`);
    assert.strictEqual(viewFile.status, 200, viewFile.text);

    const otherSite = await request(southServer, 'PATCH', `/api/sites/${siteId}/ga4`, {
      measurement_id: 'G-OTHER123',
      enabled: false,
    });
    assert.strictEqual(otherSite.status, 404);

    const uptakeBefore = await request(adminServer, 'GET', '/api/admin/ga4');
    assert.strictEqual(uptakeBefore.status, 200, uptakeBefore.text);
    assert.strictEqual(uptakeBefore.json.sites_on, 0);
    const northRow = uptakeBefore.json.agencies.find((row) => row.id === northId);
    assert.strictEqual(northRow.paid_plan, false);
    assert.strictEqual(northRow.sites_on, 0);

    const paidOn = await request(adminServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: true });
    assert.strictEqual(paidOn.status, 200, paidOn.text);
    assert.strictEqual(paidOn.json.paid_plan, true);
    assert.strictEqual(paidOn.json.sites_on, 0);

    const viewSave = await request(viewServer, 'PATCH', `/api/sites/${siteId}/ga4`, { enabled: true });
    assert.strictEqual(viewSave.status, 403);

    const enabledOn = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, { enabled: true });
    assert.strictEqual(enabledOn.status, 200, enabledOn.text);
    assert.strictEqual(enabledOn.json.site.ga4_enabled, true);
    assert.strictEqual(enabledOn.json.site.ga4_available, true);
    assert.strictEqual(enabledOn.json.site.ga4_measurement_id, 'G-TEST1234');

    await db.query(
      `INSERT INTO experiments (name, url_match, status, allowed_hosts, account_id, site_id)
       VALUES ('Home hero', 'https://shop.example/', 'running', $1::text[], $2, $3)`,
      [['shop.example'], northId, siteId]
    );
    const exp = await db.query(`SELECT id FROM experiments WHERE site_id = $1`, [siteId]);
    await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50)`,
      [exp.rows[0].id]
    );

    const page = '/api/experiments?url=' + encodeURIComponent('https://shop.example/pricing') + '&site=' + encodeURIComponent(siteKey);
    const live = await request(publicServer, 'GET', page);
    assert.strictEqual(live.status, 200, live.text);
    assert.ok(live.json.experiments.some((row) => row.id === exp.rows[0].id));
    assert.deepStrictEqual(live.json.ga4, { measurement_id: 'G-TEST1234' });

    const paidOff = await request(adminServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: false });
    assert.strictEqual(paidOff.status, 200, paidOff.text);
    const silent = await request(publicServer, 'GET', page);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(silent.json, 'ga4'), false);
    const stillOn = await request(adminServer, 'GET', '/api/admin/ga4');
    assert.strictEqual(stillOn.json.sites_on, 1);
    const northOff = stillOn.json.agencies.find((row) => row.id === northId);
    assert.strictEqual(northOff.paid_plan, false);
    assert.strictEqual(northOff.sites_on, 1);

    await request(adminServer, 'PATCH', `/api/admin/accounts/${northId}/paid-plan`, { paid_plan: true });
    const second = await request(ownerServer, 'POST', '/api/sites', { website: 'blog.shop.example' });
    assert.strictEqual(second.status, 201, second.text);
    assert.strictEqual(second.json.site.ga4_available, true);
    const secondOn = await request(ownerServer, 'PATCH', `/api/sites/${second.json.site.id}/ga4`, {
      measurement_id: 'G-BLOG1234',
      enabled: true,
    });
    assert.strictEqual(secondOn.status, 200, secondOn.text);
    const counted = await request(adminServer, 'GET', '/api/admin/ga4');
    assert.strictEqual(counted.json.sites_on, 2);

    const southKey = (await request(southServer, 'POST', '/api/sites', { website: 'south.example' })).json.site.public_key;
    const southPage = '/api/experiments?url=' + encodeURIComponent('https://south.example/') + '&site=' + encodeURIComponent(southKey);
    const southList = await request(publicServer, 'GET', southPage);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(southList.json, 'ga4'), false);
    assert.ok(!southList.text.includes('G-TEST1234'));

    const switchedOff = await request(ownerServer, 'PATCH', `/api/sites/${siteId}/ga4`, { enabled: false });
    assert.strictEqual(switchedOff.status, 200, switchedOff.text);
    assert.strictEqual(switchedOff.json.site.ga4_enabled, false);
    assert.strictEqual(switchedOff.json.site.ga4_measurement_id, 'G-TEST1234');
    const afterOff = await request(publicServer, 'GET', page);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(afterOff.json, 'ga4'), false);

    const audits = await db.query(
      `SELECT action, detail FROM audit_log
       WHERE action IN ('ga4_settings', 'paid_plan')
       ORDER BY created_at`
    );
    assert.ok(audits.rows.some((row) => row.action === 'ga4_settings' && row.detail.enabled === true));
    assert.ok(audits.rows.some((row) => row.action === 'paid_plan' && row.detail.paid_plan === true));
    assert.ok(audits.rows.some((row) => row.action === 'paid_plan' && row.detail.paid_plan === false));

    console.log('ga4 db tests passed');
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
