// Site key formatting. No database. Old snippet tags stay unchanged, and old
// edit and preview tokens still verify.
const assert = require('assert');
const snippet = require('../snippet/ab.js');
const ui = require('../public/admin-ui.js');
const { createEditToken, inspectEditToken, verifyEditToken } = require('../src/edit-token');
const { createPreviewToken, inspectPreviewToken, verifyPreviewToken } = require('../src/preview-access');

const origin = 'https://pivitlab.com';
const key = 'site_' + 'ab'.repeat(16);

assert.strictEqual(
  ui.snippetTag(origin),
  '<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com"></script>'
);
assert.strictEqual(
  ui.snippetTag(origin, key),
  `<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com" data-site="${key}"></script>`
);
assert.strictEqual(
  ui.snippetTag(origin, 'not-a-key'),
  '<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com"></script>'
);
assert.strictEqual(
  ui.snippetTag('https://pivit.click', ''),
  '<script src="https://pivit.click/snippet/ab.js" data-api="https://pivit.click"></script>'
);

assert.strictEqual(
  snippet.withSite('https://pivitlab.com/api/experiments?url=1', key),
  `https://pivitlab.com/api/experiments?url=1&site=${key}`
);
assert.strictEqual(snippet.withSite('https://pivitlab.com/api/experiments', ''), 'https://pivitlab.com/api/experiments');
assert.strictEqual(snippet.withSite('https://pivitlab.com/api/experiments', 'site_short'), 'https://pivitlab.com/api/experiments');
assert.strictEqual(
  snippet.withQaQuery(snippet.withSite('https://pivitlab.com/api/experiments?url=1', key), true),
  `https://pivitlab.com/api/experiments?url=1&site=${key}&pivit_qa=1`
);

const plain = snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_shopper', event_type: 'view', goal_id: null,
}, false);
assert.strictEqual(plain.site, undefined);
assert.strictEqual(plain.is_test, undefined);
const keyed = snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_shopper', event_type: 'view', goal_id: null, site: key,
}, false);
assert.strictEqual(keyed.site, key);
assert.strictEqual(snippet.eventBody({
  experiment_id: 'e', variant_id: 'v', visitor_id: 'v_shopper', event_type: 'view', site: 'nope',
}, false).site, undefined);

const variantId = '11111111-1111-1111-1111-111111111111';
const accountId = '22222222-2222-2222-2222-222222222222';
const siteId = '33333333-3333-3333-3333-333333333333';
const now = Date.now();

const oldEdit = createEditToken(variantId);
const oldEditClaims = inspectEditToken(oldEdit, variantId, now);
assert.strictEqual(verifyEditToken(oldEdit, variantId, now), true);
assert.strictEqual(oldEditClaims.accountId, null);
assert.strictEqual(oldEditClaims.siteId, null);

const newEdit = createEditToken(variantId, 60 * 60 * 1000, { accountId, siteId });
const newEditClaims = inspectEditToken(newEdit, variantId, now);
assert.strictEqual(newEditClaims.accountId, accountId);
assert.strictEqual(newEditClaims.siteId, siteId);
assert.strictEqual(inspectEditToken(newEdit, variantId, now).variantId, variantId);

const oldPreview = createPreviewToken(variantId, 60 * 60 * 1000, now);
const oldPreviewClaims = inspectPreviewToken(oldPreview, variantId, now);
assert.strictEqual(verifyPreviewToken(oldPreview, variantId, now), true);
assert.strictEqual(oldPreviewClaims.accountId, null);
assert.strictEqual(oldPreviewClaims.siteId, null);

const newPreview = createPreviewToken(variantId, 60 * 60 * 1000, now, { accountId, siteId });
const newPreviewClaims = inspectPreviewToken(newPreview, variantId, now);
assert.strictEqual(newPreviewClaims.accountId, accountId);
assert.strictEqual(newPreviewClaims.siteId, siteId);
assert.strictEqual(inspectPreviewToken(
  createPreviewToken(variantId, 60 * 60 * 1000, now, { accountId }),
  variantId,
  now
).siteId, null);

console.log('site-key tests passed');
