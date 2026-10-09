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

const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(admin.includes('id="wizard-match"'));
assert.ok(admin.includes('id="settings-match"'));
assert.ok(admin.includes('id="wizard-match-hint"'));
assert.ok(admin.includes('Test traffic results'));
assert.ok(admin.includes('Export test traffic CSV'));

const client = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(!client.includes('Test traffic results'));
assert.ok(!client.includes('test_only'));

console.log('page-match tests passed');
