// Daily snapshot, client portal reads, and review requests.
// The portal routes must not write a snapshot or return direction while blind.
const assert = require('assert');
const http = require('http');
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
        { origin: `http://127.0.0.1:${port}` },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
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
  app.use('/api/client', require('../src/routes/client'));
  app.use('/api/review-requests', require('../src/routes/review-requests'));
  app.use('/api/experiments', require('../src/routes/experiments'));
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
    console.log('snapshot db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_snap_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { runDailySnapshots } = require('../src/snapshot');
  const { previousLondonDate } = require('../src/clock');
  const { takeLastLoggedEmail } = require('../src/mailer');

  const servers = [];
  const originalFetch = global.fetch;
  try {
    await migrate();
    const legacy = await db.query(
      `SELECT a.id, s.id AS site_id
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE`
    );
    const accountId = legacy.rows[0].id;
    const siteId = legacy.rows[0].site_id;
    const other = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Other Ltd', false) RETURNING id`
    );
    const otherId = other.rows[0].id;

    const client = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Can''t Say That', 'cst-portal', 'hash', $1) RETURNING id`,
      [accountId]
    );
    const clientId = client.rows[0].id;
    const otherClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Other', 'other-portal', 'hash', $1) RETURNING id`,
      [otherId]
    );

    const now = new Date('2026-10-11T07:00:00Z');
    const plan = {
      visitors_per_variant: 5000,
      estimated_days: 30,
      min_runtime_days: 14,
      variant_count: 2,
      comparisons: 1,
      alpha_per_comparison: 0.05,
      sentence: 'You will need about 5,000 visitors per variant.',
    };
    const blind = await db.query(
      `INSERT INTO experiments
         (name, url_match, url_match_type, status, allowed_hosts, goals, goals_scope, goals_migrated,
          plan, started_at, hypothesis, client_id, account_id, site_id)
       VALUES
         ('Contact form - Shorter form', 'cantsaythat.co.uk/contact', 'exact', 'running',
          $1::text[], $2::jsonb, 'shared', true, $3::jsonb, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ['cantsaythat.co.uk'],
        JSON.stringify([{ id: 'sent', name: 'form sent', primary: true, type: 'url' }]),
        JSON.stringify(plan),
        new Date('2026-07-20T06:00:00Z'),
        'A shorter form will get more people to send it.',
        clientId,
        accountId,
        siteId,
      ]
    );
    const blindId = blind.rows[0].id;
    const control = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50) RETURNING id`,
      [blindId]
    );
    const variant = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Variant A', 50) RETURNING id`,
      [blindId]
    );
    const recent = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    for (let i = 0; i < 20; i += 1) {
      await db.query(
        `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
         VALUES ($1, $2, $3, 'view', $4)`,
        [blindId, control.rows[0].id, `c-${i}`, recent]
      );
      await db.query(
        `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
         VALUES ($1, $2, $3, 'view', $4)`,
        [blindId, variant.rows[0].id, `a-${i}`, recent]
      );
    }

    const early = await runDailySnapshots(new Date('2026-10-11T04:30:00Z'));
    assert.strictEqual(early.skippedClock, true);
    assert.strictEqual(early.written, 0);

    const yesterday = previousLondonDate(now);
    await db.query(
      `INSERT INTO status_snapshots
         (experiment_id, account_id, snapshot_date, headline_code, futility_band, detail)
       VALUES ($1, $2, $3::date, 'traffic_low', 'unlikely', '{"public":{},"private":{}}'::jsonb)`,
      [blindId, accountId, yesterday]
    );

    const first = await runDailySnapshots(now, { runs: 20, innerDraws: 20 });
    assert.strictEqual(first.written, 1);
    const second = await runDailySnapshots(now, { runs: 20, innerDraws: 20 });
    assert.strictEqual(second.written, 0);
    assert.ok(second.skipped >= 1);
    const stored = await db.query(
      `SELECT COUNT(*)::int AS n FROM status_snapshots WHERE experiment_id = $1 AND snapshot_date = $2::date`,
      [blindId, '2026-10-11']
    );
    assert.strictEqual(stored.rows[0].n, 1);

    const beforeReads = await db.query(`SELECT COUNT(*)::int AS n FROM status_snapshots`);
    const server = await listen(appFor({ role: 'client', clientId }));
    servers.push(server);
    const list = await request(server, 'GET', '/api/client/experiments');
    assert.strictEqual(list.status, 200);
    const row = list.json.experiments.find((item) => item.id === blindId);
    assert.ok(row);
    assert.strictEqual(row.headline, 'Unlikely to finish in time');
    assert.strictEqual(row.mode, 'blind');
    assert.ok(!list.text.includes('p_decisive'));
    assert.ok(!list.text.includes('conversion_rate'));
    assert.ok(!list.text.includes('probability'));

    const detail = await request(server, 'GET', `/api/client/experiments/${blindId}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.json.mode, 'blind');
    assert.strictEqual(detail.json.experiment.hypothesis, 'A shorter form will get more people to send it.');
    assert.ok(detail.json.snapshot.health.some((line) => line.label === 'Goal is set' || line.ok === true));
    assert.ok(detail.json.experiment.variants.some((item) => item.preview_url && item.preview_url.includes('ab_preview=')));
    assert.strictEqual(detail.json.snapshot.progress_pct_band % 5, 0);
    const blindText = JSON.stringify(detail.json);
    assert.ok(!blindText.includes('p_decisive'));
    assert.ok(!blindText.includes('conversion_rate'));
    assert.ok(!blindText.includes('probability_best'));
    assert.ok(!blindText.includes('owner_note'));
    assert.ok(!blindText.includes('"conversions"'));

    const afterReads = await db.query(`SELECT COUNT(*)::int AS n FROM status_snapshots`);
    assert.strictEqual(afterReads.rows[0].n, beforeReads.rows[0].n);

    const owner = await listen(appFor({ role: 'owner' }));
    servers.push(owner);
    const note = await request(owner, 'GET', `/api/experiments/${blindId}/snapshot-note`);
    assert.strictEqual(note.status, 200);
    assert.ok(note.json.owner_note);
    assert.ok(!note.text.includes('p_decisive'));

    takeLastLoggedEmail();
    const asked = await request(server, 'POST', `/api/client/experiments/${blindId}/review-request`, {});
    assert.strictEqual(asked.status, 200);
    assert.strictEqual(asked.json.ok, true);
    const mailed = takeLastLoggedEmail();
    assert.ok(mailed);
    assert.ok(mailed.subject.includes('Contact form - Shorter form'));
    const again = await request(server, 'POST', `/api/client/experiments/${blindId}/review-request`, {});
    assert.strictEqual(again.status, 200);
    const openRows = await db.query(
      `SELECT COUNT(*)::int AS n FROM review_requests WHERE experiment_id = $1 AND decided_at IS NULL`,
      [blindId]
    );
    assert.strictEqual(openRows.rows[0].n, 1);
    const audit = await db.query(
      `SELECT action FROM audit_log WHERE action = 'review_request' AND target_id = $1`,
      [blindId]
    );
    assert.strictEqual(audit.rows.length, 1);

    const ownerList = await request(owner, 'GET', '/api/review-requests');
    assert.strictEqual(ownerList.status, 200);
    assert.strictEqual(ownerList.json.requests.length, 1);
    assert.strictEqual(ownerList.json.requests[0].experiment_name, 'Contact form - Shorter form');

    const otherOwner = await listen(appFor({ role: 'owner', accountId: otherId }));
    servers.push(otherOwner);
    const hidden = await request(otherOwner, 'GET', '/api/review-requests');
    assert.deepStrictEqual(hidden.json.requests, []);
    const foreignDecide = await request(otherOwner, 'POST', `/api/review-requests/${ownerList.json.requests[0].id}/decide`, {});
    assert.strictEqual(foreignDecide.status, 404);
    const otherClientServer = await listen(appFor({ role: 'client', clientId: otherClient.rows[0].id }));
    servers.push(otherClientServer);
    const foreignPortal = await request(otherClientServer, 'GET', `/api/client/experiments/${blindId}`);
    assert.strictEqual(foreignPortal.status, 404);
    const foreignAsk = await request(otherClientServer, 'POST', `/api/client/experiments/${blindId}/review-request`, {});
    assert.strictEqual(foreignAsk.status, 404);

    process.env.POSTMARK_SERVER_TOKEN = 'test-token';
    global.fetch = async () => { throw new Error('postmark down'); };
    const decided = await request(owner, 'POST', `/api/review-requests/${ownerList.json.requests[0].id}/decide`, {});
    assert.strictEqual(decided.status, 200);
    const failedMail = await request(server, 'POST', `/api/client/experiments/${blindId}/review-request`, {});
    assert.strictEqual(failedMail.status, 200);
    assert.strictEqual(failedMail.json.ok, true);
    const emailRow = await db.query(
      `SELECT email_sent, email_error FROM review_requests
       WHERE experiment_id = $1 AND decided_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [blindId]
    );
    assert.strictEqual(emailRow.rows[0].email_sent, false);
    assert.ok(emailRow.rows[0].email_error);

    const wonPlan = {
      visitors_per_variant: 30,
      estimated_days: 14,
      min_runtime_days: 7,
      variant_count: 2,
      comparisons: 1,
      alpha_per_comparison: 0.05,
    };
    const won = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated,
          plan, started_at, client_id, account_id, site_id)
       VALUES
         ('Basket - Free delivery message', '/basket', 'archived',
          $1::text[], $2::jsonb, 'shared', true, $3::jsonb, $4, $5, $6, $7)
       RETURNING id`,
      [
        ['cantsaythat.co.uk'],
        JSON.stringify([{ id: 'checkout', name: 'checkout', primary: true, type: 'url' }]),
        JSON.stringify(wonPlan),
        new Date('2026-09-20T06:00:00Z'),
        clientId,
        accountId,
        siteId,
      ]
    );
    const wonId = won.rows[0].id;
    const wonControl = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Control', 50) RETURNING id`,
      [wonId]
    );
    const wonA = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'Variant A', 50) RETURNING id`,
      [wonId]
    );
    async function seedArm(variantId, prefix, visitors, conversions) {
      for (let i = 0; i < visitors; i += 1) {
        await db.query(
          `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, created_at)
           VALUES ($1, $2, $3, 'view', $4)`,
          [wonId, variantId, `${prefix}-${i}`, recent]
        );
        if (i < conversions) {
          await db.query(
            `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id, created_at)
             VALUES ($1, $2, $3, 'convert', 'checkout', $4)`,
            [wonId, variantId, `${prefix}-${i}`, recent]
          );
        }
      }
    }
    await seedArm(wonControl.rows[0].id, 'wc', 40, 4);
    await seedArm(wonA.rows[0].id, 'wa', 40, 18);
    const concluded = await runDailySnapshots(now);
    assert.ok(concluded.written >= 1);
    const wonDetail = await request(server, 'GET', `/api/client/experiments/${wonId}`);
    assert.strictEqual(wonDetail.status, 200);
    assert.strictEqual(wonDetail.json.mode, 'concluded');
    assert.strictEqual(wonDetail.json.snapshot.concluded.label, 'Win');
    assert.ok(wonDetail.json.snapshot.concluded.range_label);
    assert.ok(wonDetail.json.snapshot.concluded.whats_next.length >= 3);
    assert.ok(wonDetail.json.snapshot.concluded.rows.some((item) => item.version === 'Variant A' && item.conversions > 0));

    console.log('snapshot db tests passed');
  } finally {
    global.fetch = originalFetch;
    delete process.env.POSTMARK_SERVER_TOKEN;
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    try { await db.pool.end(); } catch (err) { /* pool may already be closed */ }
    await pg.dropDatabase(dbName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
