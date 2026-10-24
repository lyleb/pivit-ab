// A checkout that rewrites the address with replaceState or pushState must
// keep ab_edit and token, or the editor closes and a reload starts at the basket.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

const variantId = '11111111-1111-4111-8111-111111111111';
const token = 'edit.token.value';
const origin = 'https://site3-checkout.netlify.app';

assert.strictEqual(
  runtime.urlWithEditParams('/play', `${origin}/play?ab_edit=${variantId}&token=${token}&utm=1`, variantId, token),
  `/play?ab_edit=${variantId}&token=${token}`
);
assert.strictEqual(
  runtime.urlWithEditParams('/play?utm=1', `${origin}/play?ab_edit=${variantId}&token=${token}`, variantId, token),
  `/play?utm=1&ab_edit=${variantId}&token=${token}`
);

const hashed = runtime.urlWithEditParams(
  '/play?mode=hash#step-payment',
  `${origin}/play?ab_edit=${variantId}&token=${token}`,
  variantId,
  token
);
const hashedUrl = new URL(hashed, origin);
assert.strictEqual(hashedUrl.searchParams.get('mode'), 'hash');
assert.strictEqual(hashedUrl.searchParams.get('ab_edit'), variantId);
assert.strictEqual(hashedUrl.searchParams.get('token'), token);
assert.strictEqual(hashedUrl.hash, '#step-payment');
assert.strictEqual(hashedUrl.searchParams.getAll('ab_edit').length, 1);

assert.strictEqual(
  runtime.urlWithEditParams('https://example.com/other', `${origin}/play?ab_edit=${variantId}&token=${token}`, variantId, token),
  'https://example.com/other'
);
assert.strictEqual(runtime.urlWithEditParams(null, `${origin}/play`, variantId, token), null);

function checkoutWindow(start) {
  let href = start;
  const history = {
    pushState(state, title, url) {
      if (arguments.length < 3 || url == null) return;
      href = new URL(url, href).href;
    },
    replaceState(state, title, url) {
      if (arguments.length < 3 || url == null) return;
      href = new URL(url, href).href;
    },
  };
  return {
    history,
    location: {
      get href() { return href; },
      get origin() { return new URL(href).origin; },
    },
    href() { return href; },
  };
}

const win = checkoutWindow(`${origin}/play?ab_edit=${variantId}&token=${token}`);
assert.strictEqual(runtime.bindEditHistory(win, variantId, token), true);
assert.strictEqual(runtime.bindEditHistory(win, variantId, token), true);

// The Fernhill checkout drops the query string as soon as it starts, when
// the address is still /play and the search is non-empty.
win.history.replaceState({ step: 'step-basket' }, '', '/play');
let kept = new URL(win.href());
assert.strictEqual(kept.pathname, '/play');
assert.strictEqual(kept.searchParams.get('ab_edit'), variantId);
assert.strictEqual(kept.searchParams.get('token'), token);

// Hash mode pushes the step into the hash and would otherwise drop the editor.
win.history.pushState({ step: 'step-details' }, '', '/play?mode=hash#step-details');
win.history.pushState({ step: 'step-payment' }, '', '/play?mode=hash#step-payment');
kept = new URL(win.href());
assert.strictEqual(kept.searchParams.get('mode'), 'hash');
assert.strictEqual(kept.searchParams.get('ab_edit'), variantId);
assert.strictEqual(kept.searchParams.get('token'), token);
assert.strictEqual(kept.hash, '#step-payment');
assert.strictEqual(kept.searchParams.getAll('token').length, 1);

const before = win.href();
win.history.replaceState({ step: 'step-payment' }, '');
assert.strictEqual(win.href(), before);

win.history.pushState({}, '', 'https://example.com/away');
assert.strictEqual(new URL(win.href()).origin, 'https://example.com');
assert.strictEqual(new URL(win.href()).searchParams.get('token'), null);

const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const initAt = snippet.indexOf('async function init()');
const awaitAt = snippet.indexOf('await fetch(', initAt);
const initHead = snippet.slice(initAt, awaitAt);
assert.ok(initHead.includes('bindEditHistory(window, mode.variantId, mode.token)'));
assert.ok(snippet.includes("editorScript.setAttribute('data-token', mode.token)"));

const helpPage = fs.readFileSync(path.join(__dirname, '../public/help.html'), 'utf8');
const helpDoc = fs.readFileSync(path.join(__dirname, '../docs/help.md'), 'utf8');
for (const text of [helpPage, helpDoc]) {
  assert.ok(text.includes('Editing on a single-page app'));
  assert.ok(text.includes('Apply without reloading'));
  assert.ok(text.includes('Click Continue twice'));
  assert.ok(text.includes('Browse'));
  assert.ok(text.includes('Select'));
  assert.ok(!text.includes('Pivitlab'));
  assert.ok(!/\bbehavior\b/i.test(text));
}

console.log('edit-history.test.js ok');
