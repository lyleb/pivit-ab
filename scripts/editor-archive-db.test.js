// Archived tests refuse editor saves, edit links and preview links. Draft,
// running and paused tests still open, and a running test warns that a save
// goes live.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pg = require('./test-postgres');
const { clearSessionSecretCache } = require('../src/session-secret');

process.env.SESSION_SECRET = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim().length >= 32
  ? process.env.SESSION_SECRET
  : 'editor-archive-test-secret-32chars';
clearSessionSecretCache();

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const { port } = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
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
    req.session = session || {};
    next();
  });
  app.use('/api/experiments', require('../src/routes/experiments'));
  app.use('/api/editor', require('../src/routes/editor'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('editor archive db tests skipped: postgres not reachable');
    return;
  }
  const dbName = 'pivit_editor_' + Date.now().toString(36);
  await pg.createDatabase(admin, dbName);
  await admin.end();

  process.env.DATABASE_URL = pg.databaseUrl(dbName);
  process.env.NODE_ENV = 'test';
  process.env.HOST_SCOPING = 'transition';
  delete process.env.APP_ORIGIN;
  delete process.env.PORT;
  delete process.env.PIVIT_TENANCY_FAULT;

  const db = require('../src/db');
  const { migrate } = require('../src/db/migrate');
  const { clearLegacyCache } = require('../src/tenant');
  const { createEditToken } = require('../src/edit-token');
  const { createPreviewToken } = require('../src/preview-access');
  const { runningEditWarning } = require('../src/editor-context');

  let server;
  try {
    await migrate();
    clearLegacyCache();
    const legacy = await db.query(
      `SELECT a.id, s.id AS site_id
       FROM accounts a
       JOIN sites s ON s.account_id = a.id
       WHERE a.legacy IS TRUE
       ORDER BY s.created_at
       LIMIT 1`
    );
    const accountId = legacy.rows[0].id;
    const siteId = legacy.rows[0].site_id;

    async function makeExperiment(name, status, marker) {
      const inserted = await db.query(
        `INSERT INTO experiments
           (name, url_match, status, allowed_hosts, goals, goals_scope, goals_migrated, account_id, site_id)
         VALUES ($1, '/checkout', $2, ARRAY['cantsaythat.co.uk'], '[]'::jsonb, 'shared', true, $3, $4)
         RETURNING id`,
        [name, status, accountId, siteId]
      );
      const variant = await db.query(
        `INSERT INTO variants (experiment_id, name, traffic_split, changes)
         VALUES ($1, 'Checkout Social proof', 100, $2::jsonb)
         RETURNING id`,
        [inserted.rows[0].id, JSON.stringify([{ type: 'text', selector: 'h1', value: marker }])]
      );
      return { id: inserted.rows[0].id, variantId: variant.rows[0].id, marker };
    }

    const archived = await makeExperiment('Checkout step', 'archived', 'ARCHIVED_SECRET');
    const running = await makeExperiment('Social Proof', 'running', 'RUNNING_SECRET');
    const paused = await makeExperiment('Paused offer', 'paused', 'PAUSED_SECRET');
    const draft = await makeExperiment('Draft headline', 'draft', 'DRAFT_SECRET');

    function editToken(variant) {
      return createEditToken(variant, undefined, { accountId, siteId });
    }
    function previewToken(variant) {
      return createPreviewToken(variant, undefined, undefined, { accountId, siteId });
    }

    server = await listen(appFor({ role: 'owner' }));

    const archivedGet = await request(server, 'GET', `/api/editor/variants/${archived.variantId}?token=${encodeURIComponent(editToken(archived.variantId))}`);
    assert.strictEqual(archivedGet.status, 409);
    assert.strictEqual(archivedGet.json.code, 'archived');
    assert.strictEqual(archivedGet.json.error, 'This edit link has expired. "Checkout step" is archived.');
    assert.strictEqual(archivedGet.json.test.name, 'Checkout step');
    assert.strictEqual(archivedGet.json.test.status_label, 'Archived');
    assert.strictEqual(archivedGet.json.variant.name, 'Checkout Social proof');
    assert.strictEqual(archivedGet.json.test.link_label, 'Open Checkout step in pivitlab');
    assert.strictEqual(
      archivedGet.json.test.url,
      `http://127.0.0.1:3000/index.html#experiment/${archived.id}`
    );
    assert.ok(!archivedGet.text.includes('ARCHIVED_SECRET'));

    const archivedPatch = await request(
      server,
      'PATCH',
      `/api/editor/variants/${archived.variantId}?token=${encodeURIComponent(editToken(archived.variantId))}`,
      { changes: [{ type: 'text', selector: 'h1', value: 'hacked-archived' }] }
    );
    assert.strictEqual(archivedPatch.status, 409);
    assert.strictEqual(archivedPatch.json.error, '"Checkout step" is archived, so this variant can\'t be edited.');
    assert.ok(archivedPatch.json.test.url.includes(`/index.html#experiment/${archived.id}`));
    const stillArchived = await db.query(`SELECT changes FROM variants WHERE id = $1`, [archived.variantId]);
    assert.strictEqual(stillArchived.rows[0].changes[0].value, 'ARCHIVED_SECRET');

    const archivedPreviewToken = await request(
      server,
      'GET',
      `/api/editor/variants/${archived.variantId}/preview-token?token=${encodeURIComponent(editToken(archived.variantId))}`
    );
    assert.strictEqual(archivedPreviewToken.status, 409);
    assert.ok(archivedPreviewToken.json.error.includes("can't be previewed"));

    const runningGet = await request(server, 'GET', `/api/editor/variants/${running.variantId}?token=${encodeURIComponent(editToken(running.variantId))}`);
    assert.strictEqual(runningGet.status, 200);
    assert.strictEqual(runningGet.json.experiment_name, 'Social Proof');
    assert.strictEqual(runningGet.json.name, 'Checkout Social proof');
    assert.strictEqual(runningGet.json.experiment_status, 'running');
    assert.strictEqual(runningGet.json.experiment_status_label, 'Running');
    assert.strictEqual(runningGet.json.edit_warning, runningEditWarning());
    assert.strictEqual(runningGet.json.changes[0].value, 'RUNNING_SECRET');

    const pausedGet = await request(server, 'GET', `/api/editor/variants/${paused.variantId}?token=${encodeURIComponent(editToken(paused.variantId))}`);
    assert.strictEqual(pausedGet.status, 200);
    assert.strictEqual(pausedGet.json.experiment_status, 'paused');
    assert.strictEqual(pausedGet.json.experiment_status_label, 'Paused');
    assert.strictEqual(pausedGet.json.edit_warning, '');

    const draftGet = await request(server, 'GET', `/api/editor/variants/${draft.variantId}?token=${encodeURIComponent(editToken(draft.variantId))}`);
    assert.strictEqual(draftGet.status, 200);
    assert.strictEqual(draftGet.json.experiment_status_label, 'Draft');
    assert.strictEqual(draftGet.json.edit_warning, '');

    const runningPatch = await request(
      server,
      'PATCH',
      `/api/editor/variants/${running.variantId}?token=${encodeURIComponent(editToken(running.variantId))}`,
      { changes: [{ type: 'text', selector: 'h1', value: 'saved-live' }] }
    );
    assert.strictEqual(runningPatch.status, 200);
    const savedLive = await db.query(`SELECT changes FROM variants WHERE id = $1`, [running.variantId]);
    assert.strictEqual(savedLive.rows[0].changes[0].value, 'saved-live');

    const page = 'https://cantsaythat.co.uk/checkout';
    const archivedLink = await request(server, 'POST', `/api/experiments/${archived.id}/variants/${archived.variantId}/edit-link`, { page_url: page });
    assert.strictEqual(archivedLink.status, 409);
    assert.strictEqual(archivedLink.json.code, 'archived');
    assert.ok(archivedLink.json.test.url.includes(`/index.html#experiment/${archived.id}`));
    assert.strictEqual(archivedLink.json.edit_url, undefined);

    const archivedPreviewLink = await request(server, 'POST', `/api/experiments/${archived.id}/variants/${archived.variantId}/preview-link`, { page_url: page });
    assert.strictEqual(archivedPreviewLink.status, 409);
    assert.ok(archivedPreviewLink.json.error.includes("can't be previewed"));
    assert.strictEqual(archivedPreviewLink.json.preview_url, undefined);

    const runningLink = await request(server, 'POST', `/api/experiments/${running.id}/variants/${running.variantId}/edit-link`, { page_url: page });
    assert.strictEqual(runningLink.status, 200);
    assert.ok(runningLink.json.edit_url.includes('ab_edit='));

    const publicPath = `/api/experiments?url=${encodeURIComponent(page)}`;
    const archivedPreview = await request(
      server,
      'GET',
      `${publicPath}&preview=1&preview_variant=${archived.variantId}&preview_token=${encodeURIComponent(previewToken(archived.variantId))}`
    );
    assert.strictEqual(archivedPreview.status, 200);
    assert.strictEqual(archivedPreview.json.preview, undefined);
    assert.strictEqual(archivedPreview.json.preview_expired.code, 'archived');
    assert.strictEqual(archivedPreview.json.preview_expired.message, 'This preview link has expired. "Checkout step" is archived.');
    assert.strictEqual(archivedPreview.json.preview_expired.test.name, 'Checkout step');
    assert.strictEqual(archivedPreview.json.preview_expired.variant.name, 'Checkout Social proof');
    assert.ok(archivedPreview.json.preview_expired.test.url.includes(`/index.html#experiment/${archived.id}`));
    assert.ok(!archivedPreview.text.includes('ARCHIVED_SECRET'));
    assert.ok(!(archivedPreview.json.experiments || []).some((exp) => exp.id === archived.id));

    const pausedPreview = await request(
      server,
      'GET',
      `${publicPath}&preview=1&preview_variant=${paused.variantId}&preview_token=${encodeURIComponent(previewToken(paused.variantId))}`
    );
    assert.strictEqual(pausedPreview.status, 200);
    assert.strictEqual(pausedPreview.json.preview_expired, undefined);
    assert.ok(pausedPreview.json.preview);
    assert.ok(pausedPreview.text.includes('PAUSED_SECRET'));

    const draftPreview = await request(
      server,
      'GET',
      `${publicPath}&preview=1&preview_variant=${draft.variantId}&preview_token=${encodeURIComponent(previewToken(draft.variantId))}`
    );
    assert.strictEqual(draftPreview.status, 200);
    assert.ok(draftPreview.text.includes('DRAFT_SECRET'));
    assert.strictEqual(draftPreview.json.preview.variant_id, draft.variantId);

    await db.query(`UPDATE experiments SET status = 'archived' WHERE id = $1`, [running.id]);
    const expiredAfterArchive = await request(
      server,
      'GET',
      `/api/editor/variants/${running.variantId}?token=${encodeURIComponent(editToken(running.variantId))}`
    );
    assert.strictEqual(expiredAfterArchive.status, 409);
    assert.ok(expiredAfterArchive.json.error.includes('Social Proof'));
    assert.ok(!expiredAfterArchive.text.includes('saved-live'));
    const unchanged = await db.query(`SELECT changes FROM variants WHERE id = $1`, [running.variantId]);
    assert.strictEqual(unchanged.rows[0].changes[0].value, 'saved-live');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    await pg.dropDatabase(dbName);
  }
  console.log('editor archive db tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
