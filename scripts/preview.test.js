const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { clearSessionSecretCache } = require('../src/session-secret');

process.env.SESSION_SECRET = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim().length >= 32
  ? process.env.SESSION_SECRET
  : 'test-session-secret-at-least-32-chars';
clearSessionSecretCache();

const preview = require('../src/preview-access');
const { createEditToken } = require('../src/edit-token');

const variantId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const now = 1_700_000_000_000;

const token = preview.createPreviewToken(variantId, 60 * 60 * 1000, now);
assert.strictEqual(preview.verifyPreviewToken(token, variantId, now + 1000), true);
assert.strictEqual(preview.verifyPreviewToken(token, otherId, now + 1000), false);
assert.strictEqual(preview.verifyPreviewToken(token, variantId, now + 60 * 60 * 1000 + 1), false);
assert.strictEqual(preview.verifyPreviewToken('not-a-token', variantId, now), false);
assert.strictEqual(preview.verifyPreviewToken(createEditToken(variantId), variantId, now), false);

assert.deepStrictEqual(preview.authorisePreview({ preview: '1' }), { ok: false });
assert.deepStrictEqual(preview.authorisePreview({ preview: '1', previewVariant: variantId }), { ok: false });
assert.deepStrictEqual(
  preview.authorisePreview({ preview: '1', previewVariant: variantId, previewToken: 'nope', now }),
  { ok: false }
);
assert.deepStrictEqual(
  preview.authorisePreview({ preview: '1', previewVariant: variantId, previewToken: token, now: now + 500 }),
  { ok: true, variantId }
);
assert.deepStrictEqual(
  preview.authorisePreview({ preview: '0', previewVariant: variantId, previewToken: token, now }),
  { ok: false }
);

const baseVariant = {
  experiment_id: 'exp-running',
  name: 'Control',
  traffic_split: 50,
  changes: [],
  goals: [],
  enabled: true,
};

const runningOnly = preview.buildPublicExperimentList({
  running: [{ id: 'exp-running', name: 'Live', url_match: '/pricing', allowed_hosts: ['secret.example'], status: 'running' }],
  variants: [
    { ...baseVariant, id: 'on' },
    { ...baseVariant, id: 'off', enabled: false },
  ],
  previewExperiment: null,
  previewVariantId: null,
});
assert.strictEqual(runningOnly.preview, null);
assert.strictEqual(runningOnly.experiments.length, 1);
assert.deepStrictEqual(runningOnly.experiments[0].variants.map((v) => v.id), ['on']);
assert.strictEqual(runningOnly.experiments[0].allowed_hosts, undefined);
assert.strictEqual(runningOnly.experiments[0].variants[0].enabled, undefined);

const draft = preview.buildPublicExperimentList({
  running: [],
  variants: [
    { ...baseVariant, id: variantId, experiment_id: 'exp-draft', enabled: false, changes: [{ type: 'text', value: 'Hello' }] },
    { ...baseVariant, id: otherId, experiment_id: 'exp-draft' },
  ],
  previewExperiment: { id: 'exp-draft', name: 'Draft', url_match: '/pricing', status: 'draft', allowed_hosts: ['client.example'] },
  previewVariantId: variantId,
});
assert.deepStrictEqual(draft.preview, { variant_id: variantId, experiment_id: 'exp-draft' });
assert.strictEqual(draft.experiments.length, 1);
assert.strictEqual(draft.experiments[0].id, 'exp-draft');
assert.deepStrictEqual(draft.experiments[0].variants.map((v) => v.id), [variantId]);
assert.strictEqual(draft.experiments[0].allowed_hosts, undefined);
assert.deepStrictEqual(draft.experiments[0].variants[0].changes, [{ type: 'text', value: 'Hello' }]);

// Host scope already dropped the draft: the caller passes null, so it is not served.
const denied = preview.buildPublicExperimentList({
  running: [{ id: 'exp-running', name: 'Live', url_match: '/pricing', status: 'running' }],
  variants: [{ ...baseVariant, id: 'on' }],
  previewExperiment: null,
  previewVariantId: variantId,
});
assert.strictEqual(denied.preview, null);
assert.deepStrictEqual(denied.experiments.map((exp) => exp.id), ['exp-running']);

const url = preview.previewUrl('https://client.example/pricing?x=1', variantId, token);
assert.ok(url.startsWith('https://client.example/pricing?x=1&'));
assert.ok(url.includes(`ab_preview=${variantId}`));
assert.ok(url.includes('ab_preview_token='));

const polluted = preview.previewUrl(
  `https://cantsaythat.co.uk/pricing?ab_preview=${otherId}&ab_preview_token=old-token&utm=1#cta`,
  variantId,
  token
);
const pollutedUrl = new URL(polluted);
assert.strictEqual(pollutedUrl.searchParams.getAll('ab_preview').length, 1);
assert.strictEqual(pollutedUrl.searchParams.get('ab_preview'), variantId);
assert.strictEqual(pollutedUrl.searchParams.get('ab_preview_token'), token);
assert.strictEqual(pollutedUrl.searchParams.get('utm'), '1');
assert.strictEqual(pollutedUrl.hash, '#cta');

const edited = preview.editUrl(
  `https://cantsaythat.co.uk/pricing?ab_edit=${otherId}&token=old-edit&ab_preview=${otherId}&ab_preview_token=old-token`,
  variantId,
  token
);
const editedUrl = new URL(edited);
assert.strictEqual(editedUrl.searchParams.getAll('ab_edit').length, 1);
assert.strictEqual(editedUrl.searchParams.get('ab_edit'), variantId);
assert.strictEqual(editedUrl.searchParams.get('token'), token);
assert.strictEqual(editedUrl.searchParams.get('ab_preview'), null);
assert.strictEqual(editedUrl.searchParams.get('ab_preview_token'), null);

const siteToken = preview.previewUrl('https://cantsaythat.co.uk/pricing?token=site-token', variantId, token);
assert.strictEqual(new URL(siteToken).searchParams.get('token'), 'site-token');

assert.strictEqual(preview.cacheControlForExperimentsQuery({ url: 'https://cantsaythat.co.uk' }), null);
assert.strictEqual(preview.cacheControlForExperimentsQuery({ preview: '1', preview_variant: variantId }), 'no-store');

const experimentsSrc = fs.readFileSync(path.join(__dirname, '../src/routes/experiments.js'), 'utf8');
assert.ok(experimentsSrc.includes("AND status = 'running'"));
assert.ok(!experimentsSrc.includes('statusClause'));
assert.ok(experimentsSrc.includes('authorisePreview'));
assert.ok(experimentsSrc.includes('applyHostScope(previewRows, req)'));
assert.ok(experimentsSrc.includes('checkHost') || experimentsSrc.includes('applyHostScope'));
assert.ok(experimentsSrc.includes('cacheControlForExperimentsQuery(req.query)'));
assert.ok(experimentsSrc.includes('editUrl(page_url'));

const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
assert.ok(snippet.includes('ab_preview_token'));
assert.ok(snippet.includes('data.preview'));
assert.ok(!snippet.includes("previewVariantId ? '&preview=1'"));
const init = snippet.slice(snippet.indexOf('async function init'));
const previewBranch = init.indexOf('data.preview && data.preview.variant_id');
const visitorLine = init.indexOf('const visitorId = getVisitorId()');
const sendLine = init.indexOf('sendEvent(');
assert.ok(previewBranch !== -1 && previewBranch < visitorLine);
assert.ok(visitorLine !== -1 && visitorLine < sendLine);

console.log('preview tests passed');
