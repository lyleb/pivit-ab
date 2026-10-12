// Site key formatting. No database. Old snippet tags stay unchanged, and old
// edit and preview tokens still verify.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const snippetSource = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const siteCalls = snippetSource.match(/withSite\([\s\S]*?SITE_KEY\)/g) || [];
assert.ok(siteCalls.length >= 2, 'the snippet should send the site key on each experiments fetch');
assert.ok(snippetSource.includes('fields.site = SITE_KEY'), 'event beacons should send the site key');

const dashboard = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(dashboard.includes('data.snippet_site_key'));
assert.ok(dashboard.includes('site.public_key'));
assert.ok(dashboard.includes('UI.installCheckLine'));
assert.ok(dashboard.includes('UI.snippetTag'));

const waiting = ui.installCheckLine({ verified: false, install_check: null }, 'example.co.uk');
assert.strictEqual(waiting.problem, false);
assert.strictEqual(waiting.text, 'Waiting for a page on your site to load the snippet.');
assert.ok(waiting.banner.includes('snippet'));

const missingMessage = 'We saw a visit from example.co.uk, but the snippet had no site key. Copy the snippet from pivitlab and replace the tag on your site.';
const missing = ui.installCheckLine({
  verified: false,
  domains: ['example.co.uk'],
  install_check: { reason: 'missing', message: missingMessage },
}, 'example.co.uk');
assert.strictEqual(missing.problem, true);
assert.strictEqual(missing.text, missingMessage);
assert.strictEqual(missing.banner, missingMessage);
assert.ok(!missing.text.includes('Pivit'));

const wrongMessage = 'We saw a visit from example.co.uk, but the site key did not match this account. Copy the snippet from pivitlab and replace the tag on your site.';
const wrong = ui.installCheckLine({
  verified: false,
  install_check: { reason: 'wrong', message: wrongMessage },
}, 'example.co.uk');
assert.strictEqual(wrong.text, wrongMessage);

const seen = ui.installCheckLine({
  verified: true,
  install_check: { message: 'stale' },
}, 'example.co.uk');
assert.strictEqual(seen.text, 'We can see pivitlab on example.co.uk.');
assert.strictEqual(seen.problem, false);
assert.strictEqual(seen.banner, '');

console.log('site-key tests passed');
