// A click-goal selector is checked against the preview page's HTML.
// 0 is a warning, many is a note, and neither result blocks saving.
const assert = require('assert');
const {
  isPrivateAddress,
  countSelectorMatches,
  describeSelectorCount,
  checkClickSelector,
  NEEDS_PAGE,
  NOT_LOADED,
} = require('../src/selector-check');

const html = `<!DOCTYPE html>
<html><head><title>Fernhill</title>
<script>var fake = '<h1 id="not-real">no</h1>';</script>
</head><body>
<section class="hero"><h1>Goods from the hill, made to be used.</h1></section>
<a class="button" href="/shop/">Browse the shop</a>
<button id="pay-now">Pay now</button>
<button class="quiet">Later</button>
<p>One</p><p>Two</p>
</body></html>`;

assert.strictEqual(countSelectorMatches(html, 'h1').count, 1);
assert.strictEqual(countSelectorMatches(html, 'section.hero h1').count, 1);
assert.strictEqual(countSelectorMatches(html, 'a.button').count, 1);
assert.strictEqual(countSelectorMatches(html, '#pay-now').count, 1);
assert.strictEqual(countSelectorMatches(html, 'button').count, 2);
assert.strictEqual(countSelectorMatches(html, '.missing').count, 0);
assert.strictEqual(countSelectorMatches(html, '#not-real').count, 0);
assert.strictEqual(countSelectorMatches(html, 'section.hero > h1').count, 1);
assert.strictEqual(countSelectorMatches(html, 'h1:nth-of-type(1)').count, 1);
assert.strictEqual(countSelectorMatches(html, 'a[href="/shop/"]').count, 1);
assert.strictEqual(countSelectorMatches(html, '[').valid, false);
assert.strictEqual(countSelectorMatches(html, 'h1:hover').supported, false);
assert.strictEqual(countSelectorMatches(html, '').valid, false);

const none = describeSelectorCount(countSelectorMatches(html, '.missing'));
assert.strictEqual(none.tone, 'warn');
assert.strictEqual(none.count, 0);
assert.ok(none.message.includes('0 elements'));
assert.ok(none.message.includes('later'));
const one = describeSelectorCount(countSelectorMatches(html, 'h1'));
assert.strictEqual(one.tone, 'ok');
assert.strictEqual(one.count, 1);
const many = describeSelectorCount(countSelectorMatches(html, 'button'));
assert.strictEqual(many.tone, 'note');
assert.strictEqual(many.count, 2);
assert.ok(many.message.includes('any of them'));
const bad = describeSelectorCount(countSelectorMatches(html, '['));
assert.strictEqual(bad.tone, 'warn');
assert.ok(bad.message.includes("isn't a valid CSS selector"));

assert.strictEqual(isPrivateAddress('127.0.0.1'), true);
assert.strictEqual(isPrivateAddress('10.0.0.4'), true);
assert.strictEqual(isPrivateAddress('169.254.169.254'), true);
assert.strictEqual(isPrivateAddress('192.168.0.1'), true);
assert.strictEqual(isPrivateAddress('localhost'), true);
assert.strictEqual(isPrivateAddress('demo.pivitlab.com'), false);

function response(status, body, headers) {
  return {
    status,
    headers: { get(name) { return (headers && headers[name.toLowerCase()]) || ''; } },
    async text() { return body || ''; },
  };
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

(async () => {
  const shop = await checkClickSelector({
    pageUrl: 'https://demo.pivitlab.com/',
    selector: 'section.hero h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: publicLookup,
    fetchImpl: async (url) => {
      assert.strictEqual(url, 'https://demo.pivitlab.com/');
      return response(200, html, { 'content-type': 'text/html; charset=utf-8' });
    },
  });
  assert.strictEqual(shop.count, 1);
  assert.strictEqual(shop.tone, 'ok');

  const late = await checkClickSelector({
    pageUrl: 'https://site3-checkout.netlify.app/play',
    selector: '#missing-late',
    allowedHosts: ['site3-checkout.netlify.app'],
    lookupImpl: publicLookup,
    fetchImpl: async () => response(200, '<html><body><div id="play"></div></body></html>', { 'content-type': 'text/html' }),
  });
  assert.strictEqual(late.count, 0);
  assert.strictEqual(late.tone, 'warn');

  const wrong = await checkClickSelector({
    pageUrl: 'https://evil.example/secret',
    selector: 'h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.strictEqual(wrong.loaded, false);
  assert.ok(wrong.message.includes('not on a domain'));

  const local = await checkClickSelector({
    pageUrl: 'http://127.0.0.1/admin',
    selector: 'h1',
    allowedHosts: ['127.0.0.1'],
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.strictEqual(local.loaded, false);

  const rebound = await checkClickSelector({
    pageUrl: 'https://demo.pivitlab.com/',
    selector: 'h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: async () => [{ address: '169.254.169.254' }],
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.strictEqual(rebound.loaded, false);

  const redirected = await checkClickSelector({
    pageUrl: 'https://demo.pivitlab.com/go',
    selector: 'h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: publicLookup,
    fetchImpl: async (url) => {
      if (url.endsWith('/go')) return response(302, '', { location: 'http://169.254.169.254/latest' });
      throw new Error('should not follow a private redirect');
    },
  });
  assert.strictEqual(redirected.loaded, false);

  const missingPage = await checkClickSelector({
    pageUrl: '',
    selector: 'h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.strictEqual(missingPage.message, NEEDS_PAGE);

  const down = await checkClickSelector({
    pageUrl: 'https://demo.pivitlab.com/',
    selector: 'h1',
    allowedHosts: ['demo.pivitlab.com'],
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error('network'); },
  });
  assert.strictEqual(down.message, NOT_LOADED);

  console.log('selector-check tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
