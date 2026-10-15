// Page URL matching. Contains stays the historical substring. A site root
// or homepage defaults to exact, which ignores a query string, a hash and a
// trailing slash. Existing stored tests are not rewritten: schema.sql only
// adds the column with default contains.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const urlMatch = require('../public/url-match');
const snippet = require('../snippet/ab.js');

const home = 'https://cantsaythat.co.uk/';
const shop = 'https://cantsaythat.co.uk/shop';
const about = 'https://cantsaythat.co.uk/about';
const checkout = 'https://cantsaythat.co.uk/checkout';
const homeQuery = 'https://cantsaythat.co.uk/?utm=winter#sale';
const homeBare = 'https://cantsaythat.co.uk';
const homeSlash = 'https://CANTsaythat.co.uk/';

assert.strictEqual(urlMatch.isSiteRoot(home), true);
assert.strictEqual(urlMatch.isSiteRoot(homeBare), true);
assert.strictEqual(urlMatch.isSiteRoot('https://cantsaythat.co.uk/?ref=1'), true);
assert.strictEqual(urlMatch.isSiteRoot('https://cantsaythat.co.uk/#sale'), true);
assert.strictEqual(urlMatch.isSiteRoot('/'), true);
assert.strictEqual(urlMatch.isSiteRoot('https://cantsaythat.co.uk/index.html'), true);
assert.strictEqual(urlMatch.isSiteRoot(shop), false);
assert.strictEqual(urlMatch.isSiteRoot('/about'), false);
assert.strictEqual(urlMatch.isSiteRoot(''), false);

assert.strictEqual(urlMatch.defaultPageMatch(home), 'exact');
assert.strictEqual(urlMatch.defaultPageMatch('https://cantsaythat.co.uk'), 'exact');
assert.strictEqual(urlMatch.defaultPageMatch('/'), 'exact');
assert.strictEqual(urlMatch.defaultPageMatch('/about'), 'contains');
assert.strictEqual(urlMatch.defaultPageMatch(shop), 'contains');

assert.strictEqual(urlMatch.matchPageUrl(home, shop, 'exact'), false);
assert.strictEqual(urlMatch.matchPageUrl(home, about, 'exact'), false);
assert.strictEqual(urlMatch.matchPageUrl(home, checkout, 'exact'), false);
assert.strictEqual(urlMatch.matchPageUrl(home, home, 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl(home, homeBare, 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl(home, homeQuery, 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl(home, homeSlash, 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl(home, 'https://www.cantsaythat.co.uk/', 'exact'), false);
assert.strictEqual(urlMatch.matchPageUrl('/checkout', 'https://cantsaythat.co.uk/checkout?plan=1#pay', 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl('/checkout/', checkout, 'exact'), true);
assert.strictEqual(urlMatch.matchPageUrl('/checkout', 'https://cantsaythat.co.uk/checkout/extra', 'exact'), false);
assert.strictEqual(urlMatch.matchPageUrl('/about', 'https://cantsaythat.co.uk/about-us', 'exact'), false);

// Contains is unchanged for a path that is not the whole site.
assert.strictEqual(urlMatch.matchPageUrl('/about', 'https://cantsaythat.co.uk/about-us', 'contains'), true);
// Starts-with on a homepage is still every page. The hint says so.
assert.strictEqual(urlMatch.matchPageUrl(home, shop, 'starts_with'), true);
assert.strictEqual(urlMatch.matchPageUrl(home, shop, 'contains'), true);

assert.strictEqual(urlMatch.resolvePageMatch(home).type, 'exact');
assert.strictEqual(urlMatch.resolvePageMatch('/pricing').type, 'contains');
assert.strictEqual(urlMatch.resolvePageMatch(home, 'contains').type, 'contains');
assert.strictEqual(urlMatch.resolvePageMatch(home, 'exact').type, 'exact');
assert.strictEqual(urlMatch.resolvePageMatch(home, '').type, 'exact');
assert.strictEqual(urlMatch.resolvePageMatch('/pricing', 'nope').ok, false);
assert.strictEqual(urlMatch.resolvePageMatch('(a+)+', 'regex').ok, false);

const homeHint = urlMatch.pageMatchHint('exact', home);
assert.ok(homeHint.includes('homepage'));
assert.ok(homeHint.includes('query string'));
const containsHint = urlMatch.pageMatchHint('contains', home);
assert.ok(containsHint.includes('/shop'));
assert.ok(containsHint.includes('/checkout'));
assert.ok(containsHint.includes('Exact'));
assert.strictEqual(urlMatch.pageMatchLabel('starts_with'), 'Starts with');

assert.strictEqual(snippet.shouldCountUrlGoal('exp-1', null), true);
assert.strictEqual(snippet.shouldCountUrlGoal('exp-1', {}), true);
assert.strictEqual(snippet.shouldCountUrlGoal('exp-1', { 'exp-1': 1 }), false);
assert.strictEqual(snippet.shouldCountUrlGoal('exp-2', { 'exp-1': 1 }), true);
const enrolled = new Set(['exp-1']);
assert.strictEqual(snippet.shouldCountUrlGoal('exp-1', enrolled), false);
assert.strictEqual(snippet.shouldCountUrlGoal('exp-2', enrolled), true);
assert.strictEqual(snippet.shouldCountUrlGoal('', { 'exp-1': 1 }), false);

// A correctly matched path still uses the same goal matcher as before.
assert.strictEqual(
  snippet.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout', 'exact'),
  urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout', 'exact')
);

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
assert.ok(schema.includes("url_match_type TEXT NOT NULL DEFAULT 'contains'"));
assert.ok(!/UPDATE\s+experiments[\s\S]{0,500}url_match_type\s*=\s*'exact'/i.test(schema));

// Preview checks the page against the same matcher targeting uses.
const previewExample = "This page doesn't match the test's URL rule (contains '/pricing'), so visitors here won't see the test.";
assert.strictEqual(urlMatch.previewUrlWarning('/pricing', 'https://example.com/about', 'contains'), previewExample);
assert.strictEqual(urlMatch.previewUrlWarning('/pricing', 'https://example.com/pricing', 'contains'), '');
assert.strictEqual(urlMatch.previewUrlWarning('/pricing', 'https://example.com/pricing/extra', 'contains'), '');

function assertPreviewCheck(type, pattern, page, shouldMatch) {
  const matched = urlMatch.matchPageUrl(pattern, page, type);
  const message = urlMatch.previewUrlWarning(pattern, page, type);
  assert.strictEqual(matched, shouldMatch, `${type} ${pattern} ${page}`);
  if (shouldMatch) {
    assert.strictEqual(message, '');
    return;
  }
  assert.ok(message.includes("doesn't match the test's URL rule"));
  assert.ok(message.includes(`'${pattern}'`));
  assert.ok(message.endsWith("so visitors here won't see the test."));
}

assertPreviewCheck('contains', '/pricing', 'https://shop.example/pricing', true);
assertPreviewCheck('contains', '/pricing', 'https://shop.example/about', false);
assertPreviewCheck('exact', 'https://shop.example/pricing', 'https://shop.example/pricing?utm=1', true);
assertPreviewCheck('exact', 'https://shop.example/pricing', 'https://shop.example/pricing/extra', false);
assertPreviewCheck('exact', '/pricing', 'https://shop.example/pricing', true);
assertPreviewCheck('exact', '/pricing', 'https://shop.example/about', false);
assertPreviewCheck('starts_with', '/pricing', 'https://shop.example/pricing/pro', true);
assertPreviewCheck('starts_with', '/pricing', 'https://shop.example/about', false);
assertPreviewCheck('starts_with', 'https://shop.example/pricing', 'https://shop.example/pricing/pro', true);
assertPreviewCheck('starts_with', 'https://shop.example/pricing', 'https://shop.example/blog', false);
assertPreviewCheck('regex', '/pri[c]ing', 'https://shop.example/pricing', true);
assertPreviewCheck('regex', '/pri[c]ing', 'https://shop.example/about', false);
assert.strictEqual(urlMatch.previewUrlWarning('/pricing', '', 'contains'), '');
assert.strictEqual(urlMatch.previewUrlWarning('', 'https://shop.example/pricing', 'contains'), '');

const shopHost = { allowedHosts: ['shop.example'] };
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: 'https://shop.example/pricing',
  matchType: 'exact',
  ...shopHost,
}), 'https://shop.example/pricing');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: '/pricing',
  matchType: 'exact',
  ...shopHost,
}), '/pricing');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: '/pricing',
  matchType: 'starts_with',
  origin: 'https://shop.example',
}), 'https://shop.example/pricing');
assert.strictEqual(urlMatch.matchPageUrl('/pricing', 'https://shop.example/pricing', 'starts_with'), true);
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: '/pricing',
  matchType: 'contains',
  ...shopHost,
}), 'https://shop.example/pricing');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: 'pricing',
  matchType: 'contains',
  ...shopHost,
}), 'https://shop.example/pricing');
// Origin plus the pattern does not match a starts-with rule of "pricing",
// so the preview falls back to the site homepage.
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: 'pricing',
  matchType: 'starts_with',
  ...shopHost,
}), 'https://shop.example/');
assert.strictEqual(urlMatch.matchPageUrl('pricing', 'https://shop.example/pricing', 'starts_with'), false);
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: 'https://other.test/pricing',
  matchType: 'contains',
  ...shopHost,
}), 'https://shop.example/');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: '/pri[c]ing',
  matchType: 'regex',
  ...shopHost,
}), 'https://shop.example/');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: 'https://shop.example/pricing',
  matchType: 'contains',
}), 'https://shop.example/pricing');
assert.strictEqual(urlMatch.defaultPreviewPage({
  pattern: '/pricing',
  matchType: 'contains',
}), '');
assert.ok(urlMatch.matchPageUrl(
  '/pricing',
  urlMatch.defaultPreviewPage({ pattern: '/pricing', matchType: 'contains', ...shopHost }),
  'contains'
));

const matcherSource = fs.readFileSync(path.join(__dirname, '../public/url-match.js'), 'utf8');
const warningSource = matcherSource.slice(
  matcherSource.indexOf('function previewUrlWarning'),
  matcherSource.indexOf('function normaliseOrigin')
);
const defaultSource = matcherSource.slice(
  matcherSource.indexOf('function defaultPreviewPage'),
  matcherSource.indexOf('function testUrlGoal')
);
assert.ok(warningSource.includes('matchPageUrl('));
assert.ok(defaultSource.includes('matchPageUrl('));
assert.strictEqual(matcherSource.split('function matchPageUrl').length, 2);

const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(admin.includes('id="wizard-match"'));
assert.ok(admin.includes('id="settings-match"'));
assert.ok(admin.includes('id="wizard-match-hint"'));
assert.ok(admin.includes('id="manage-url-warning"'));
assert.ok(admin.includes('id="detail-url-warning"'));
assert.ok(admin.includes('id="wizard-url-warning"'));
assert.ok(admin.includes('Use a matching page'));
assert.ok(admin.includes('previewUrlWarning'));
assert.ok(admin.includes('defaultPreviewPage'));
assert.ok(admin.includes('PivitUrl.matchPageUrl'));
assert.ok(admin.includes('class="preview-url-warning"'));
assert.ok(admin.includes('Test traffic results'));
assert.ok(admin.includes('Export test traffic CSV'));

const client = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(!client.includes('Test traffic results'));
assert.ok(!client.includes('test_only'));

console.log('page-match tests passed');
