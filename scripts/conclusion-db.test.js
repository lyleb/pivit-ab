// Conclusion draft, release, click-to-approve, and cross-account isolation.
// The PDF copies the stored snapshot. It does not count events.
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
        const text = Buffer.concat(chunks).toString('latin1');
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
    req.ip = '203.0.113.10';
    next();
  });
  app.use('/api/experiments', require('../src/routes/conclusion').ownerRouter);
  app.use('/api/notices', require('../src/routes/conclusion').noticesRouter);
  app.use('/api/client', require('../src/routes/client'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const STORED_SUMMARY = 'Green lifted purchases by about +12%.';

function concludedDetail() {
  return {
    public: {
      headline_code: 'ready',
      concluded: {
        label: 'Win',
        variant_name: 'Green',
        summary: STORED_SUMMARY,
        range_label: '+4% to +21%',
        probability_label: '91% chance Green is better than Control',
        rows: [
          { version: 'Control', visitors: 8, conversions: 1, rate: '12.5%' },
          { version: 'Green', visitors: 9, conversions: 4, rate: '44.4%' },
        ],
        goal_label: 'Purchases',
        visitors: 17,
        days: 14,
        finished_on: '2026-10-13',
        finished_label: '13 Oct',
        whats_next: [{ title: 'Roll out the winner.', body: 'Make Green permanent.' }],
      },
    },
    private: { owner_note: 'owner only' },
  };
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('conclusion db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_conclusion_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const servers = [];
  const originalFetch = global.fetch;

  try {
    await migrate();
    const legacy = await db.query(
      `SELECT a.id AS account_id, s.id AS site_id
       FROM accounts a
       JOIN sites s ON s.account_id = a.id AND s.name = 'cantsaythat.co.uk'
       WHERE a.legacy IS TRUE`
    );
    const accountId = legacy.rows[0].account_id;
    const siteId = legacy.rows[0].site_id;
    const other = await db.query(
      `INSERT INTO accounts (name, legacy) VALUES ('Other Ltd', false) RETURNING id`
    );
    const otherId = other.rows[0].id;

    const client = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('North Shop', 'north-shop', 'hash', $1) RETURNING id`,
      [accountId]
    );
    const clientId = client.rows[0].id;
    const stranger = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Other Viewer', 'other-viewer', 'hash', $1) RETURNING id`,
      [accountId]
    );
    const strangerId = stranger.rows[0].id;
    const otherClient = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id)
       VALUES ('Other Client', 'other-client', 'hash', $1) RETURNING id`,
      [otherId]
    );

    const exp = await db.query(
      `INSERT INTO experiments
         (name, url_match, url_match_type, status, allowed_hosts, account_id, site_id, client_id, hypothesis, goals)
       VALUES ('Shop tags', '/shop', 'contains', 'running', ARRAY['shop.example'], $1, $2, $3, 'Green sells more.', '[{"name":"Purchase","primary":true}]'::jsonb)
       RETURNING id`,
      [accountId, siteId, clientId]
    );
    const experimentId = exp.rows[0].id;
    await db.query(
      `INSERT INTO status_snapshots
         (experiment_id, account_id, snapshot_date, headline_code, futility_band, detail)
       VALUES ($1, $2, '2026-10-13', 'ready', 'none', $3::jsonb)`,
      [experimentId, accountId, JSON.stringify(concludedDetail())]
    );

    const owner = await listen(appFor({ role: 'owner', userId: null }));
    const otherOwner = await listen(appFor({ role: 'owner', accountId: otherId }));
    const viewer = await listen(appFor({ role: 'client', clientId }));
    const otherViewer = await listen(appFor({ role: 'client', clientId: strangerId }));
    const foreignViewer = await listen(appFor({ role: 'client', clientId: otherClient.rows[0].id, accountId: otherId }));
    servers.push(owner, otherOwner, viewer, otherViewer, foreignViewer);

    const hidden = await request(viewer, 'GET', `/api/client/experiments/${experimentId}`);
    assert.strictEqual(hidden.status, 200);
    assert.strictEqual(hidden.json.conclusion, null);
    assert.ok(!hidden.text.includes('draft'));
    const hiddenPdf = await request(viewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(hiddenPdf.status, 404);
    assert.ok(!hiddenPdf.text.includes(STORED_SUMMARY));
    const hiddenApprove = await request(viewer, 'POST', `/api/client/experiments/${experimentId}/approve`, {});
    assert.strictEqual(hiddenApprove.status, 404);

    for (const [method, urlPath] of [
      ['GET', `/api/experiments/${experimentId}/conclusion`],
      ['POST', `/api/experiments/${experimentId}/conclusion`],
      ['POST', `/api/experiments/${experimentId}/conclusion/release`],
      ['GET', `/api/experiments/${experimentId}/conclusion.pdf`],
      ['GET', `/api/experiments/${experimentId}/approval.pdf`],
    ]) {
      const blocked = await request(otherOwner, method, urlPath, method === 'GET' ? null : {});
      assert.strictEqual(blocked.status, 404, `${method} ${urlPath} -> ${blocked.status}`);
      assert.ok(!blocked.text.includes(STORED_SUMMARY));
    }
    const foreignClientPdf = await request(foreignViewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(foreignClientPdf.status, 404);

    const drafted = await request(owner, 'POST', `/api/experiments/${experimentId}/conclusion`, {});
    assert.strictEqual(drafted.status, 200);
    assert.strictEqual(drafted.json.report.status, 'draft');
    const storedRow = await db.query(
      `SELECT status, content FROM conclusion_reports WHERE experiment_id = $1 AND account_id = $2`,
      [experimentId, accountId]
    );
    assert.strictEqual(storedRow.rows[0].status, 'draft');
    assert.strictEqual(storedRow.rows[0].content.concluded.summary, STORED_SUMMARY);
    assert.strictEqual(storedRow.rows[0].content.concluded.visitors, 17);
    assert.strictEqual(storedRow.rows[0].content.concluded.rows[1].conversions, 4);

    const stillHidden = await request(viewer, 'GET', `/api/client/experiments/${experimentId}`);
    assert.strictEqual(stillHidden.json.conclusion, null);
    const draftPdfForClient = await request(viewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(draftPdfForClient.status, 404);
    assert.ok(!draftPdfForClient.text.includes(STORED_SUMMARY));

    const ownerPdf = await request(owner, 'GET', `/api/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(ownerPdf.status, 200);
    assert.ok(String(ownerPdf.headers['content-type']).includes('application/pdf'));
    assert.ok(ownerPdf.text.includes(STORED_SUMMARY));
    assert.ok(ownerPdf.text.includes('pivitlab'));
    assert.ok(!ownerPdf.text.includes('Pivit'));
    assert.ok(ownerPdf.text.includes('17'));

    const strangerPdf = await request(otherViewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(strangerPdf.status, 404);

    const released = await request(owner, 'POST', `/api/experiments/${experimentId}/conclusion/release`, {});
    assert.strictEqual(released.status, 200);
    assert.strictEqual(released.json.report.status, 'released');
    const frozenAgain = await request(owner, 'POST', `/api/experiments/${experimentId}/conclusion`, {});
    assert.strictEqual(frozenAgain.status, 409);

    const visible = await request(viewer, 'GET', `/api/client/experiments/${experimentId}`);
    assert.strictEqual(visible.json.conclusion.released, true);
    assert.strictEqual(visible.json.conclusion.approval, null);
    assert.ok(!JSON.stringify(visible.json.conclusion).includes(STORED_SUMMARY));
    const clientPdf = await request(viewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`);
    assert.strictEqual(clientPdf.status, 200);
    assert.ok(clientPdf.text.includes(STORED_SUMMARY));
    assert.ok(clientPdf.text.includes('labelled'));
    assert.strictEqual((await request(otherOwner, 'GET', `/api/experiments/${experimentId}/conclusion.pdf`)).status, 404);
    assert.strictEqual((await request(otherViewer, 'GET', `/api/client/experiments/${experimentId}/conclusion.pdf`)).status, 404);
    assert.strictEqual((await request(foreignViewer, 'POST', `/api/client/experiments/${experimentId}/approve`, {})).status, 404);
    assert.strictEqual((await request(otherViewer, 'POST', `/api/client/experiments/${experimentId}/approve`, {})).status, 404);

    const approved = await request(viewer, 'POST', `/api/client/experiments/${experimentId}/approve`, {});
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.json.approver_name, 'North Shop');
    assert.ok(approved.json.approved_label);
    const audit = await db.query(
      `SELECT account_id, action, actor_label, detail
       FROM audit_log WHERE action = 'conclusion_approved' AND target_id = $1`,
      [experimentId]
    );
    assert.strictEqual(audit.rows.length, 1);
    assert.strictEqual(audit.rows[0].account_id, accountId);
    assert.strictEqual(audit.rows[0].actor_label, 'North Shop');
    assert.strictEqual(audit.rows[0].detail.approver_name, 'North Shop');
    assert.ok(audit.rows[0].detail.approved_at);
    const notices = await request(owner, 'GET', '/api/notices');
    assert.strictEqual(notices.status, 200);
    assert.strictEqual(notices.json.notices.length, 1);
    assert.ok(notices.json.notices[0].body.includes('North Shop'));
    assert.strictEqual((await request(otherOwner, 'GET', '/api/notices')).json.notices.length, 0);
    const marked = await request(otherOwner, 'POST', `/api/notices/${notices.json.notices[0].id}/read`, {});
    assert.strictEqual(marked.status, 404);
    const approvalPdf = await request(viewer, 'GET', `/api/client/experiments/${experimentId}/approval.pdf`);
    assert.strictEqual(approvalPdf.status, 200);
    assert.ok(approvalPdf.text.includes('North Shop'));
    assert.ok(approvalPdf.text.includes('pivitlab'));
    assert.ok(approvalPdf.text.includes('Approval record'));
    assert.strictEqual((await request(otherOwner, 'GET', `/api/experiments/${experimentId}/approval.pdf`)).status, 404);
    assert.strictEqual((await request(otherViewer, 'GET', `/api/client/experiments/${experimentId}/approval.pdf`)).status, 404);
    const ownerRecord = await request(owner, 'GET', `/api/experiments/${experimentId}/approval.pdf`);
    assert.strictEqual(ownerRecord.status, 200);
    assert.ok(ownerRecord.text.includes('North Shop'));

    const again = await request(viewer, 'POST', `/api/client/experiments/${experimentId}/approve`, {});
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.already, true);
    const auditCount = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'conclusion_approved' AND target_id = $1`,
      [experimentId]
    );
    assert.strictEqual(auditCount.rows[0].n, 1);

    const read = await request(owner, 'POST', `/api/notices/${notices.json.notices[0].id}/read`, {});
    assert.strictEqual(read.status, 200);
    assert.strictEqual((await request(owner, 'GET', '/api/notices')).json.notices.length, 0);

    const mailed = await db.query(
      `INSERT INTO experiments
         (name, url_match, status, allowed_hosts, account_id, site_id, client_id, goals)
       VALUES ('Mail test', '/mail', 'running', ARRAY['shop.example'], $1, $2, $3, '[]'::jsonb)
       RETURNING id`,
      [accountId, siteId, clientId]
    );
    await db.query(
      `INSERT INTO status_snapshots
         (experiment_id, account_id, snapshot_date, headline_code, futility_band, detail)
       VALUES ($1, $2, '2026-10-13', 'ready', 'none', $3::jsonb)`,
      [mailed.rows[0].id, accountId, JSON.stringify(concludedDetail())]
    );
    assert.strictEqual((await request(owner, 'POST', `/api/experiments/${mailed.rows[0].id}/conclusion`, {})).status, 200);
    assert.strictEqual((await request(owner, 'POST', `/api/experiments/${mailed.rows[0].id}/conclusion/release`, {})).status, 200);

    let posted = null;
    process.env.POSTMARK_SERVER_TOKEN = 'test-token';
    global.fetch = async (url, options) => {
      posted = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ MessageID: 'msg-1' }) };
    };
    const emailed = await request(viewer, 'POST', `/api/client/experiments/${mailed.rows[0].id}/approve`, {});
    assert.strictEqual(emailed.status, 200);
    assert.strictEqual(posted.body.To, 'info@heclr.com');
    assert.ok(posted.body.Subject.includes('Conclusion approved'));
    assert.ok(posted.body.TextBody.includes('North Shop'));
    const afterEmail = await request(owner, 'GET', '/api/notices');
    assert.strictEqual(afterEmail.json.notices.length, 0);

    posted = null;
    global.fetch = async () => {
      throw new Error('postmark down');
    };
    await db.query(`DELETE FROM conclusion_approvals WHERE experiment_id = $1`, [mailed.rows[0].id]);
    const fellBack = await request(viewer, 'POST', `/api/client/experiments/${mailed.rows[0].id}/approve`, {});
    assert.strictEqual(fellBack.status, 200);
    const fallbackNotices = await request(owner, 'GET', '/api/notices');
    assert.strictEqual(fallbackNotices.json.notices.length, 1);
    assert.ok(fallbackNotices.json.notices[0].body.includes('North Shop'));

    console.log('conclusion db tests passed');
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
