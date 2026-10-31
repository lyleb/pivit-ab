// A preview whose change matches nothing keeps the page visible, then shows
// the same kind of notice as a refused preview once the watch window ends.
// An invalid or expired preview token is named on the page, not ignored.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const variantId = '856a9ccc-7630-4a45-bdd4-f1066343f62e';
const experimentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function harness(href) {
  const ids = {};
  const removed = [];
  const timers = [];
  const head = { children: [], appendChild(child) { this.children.push(child); return child; } };
  const body = { children: [], appendChild(child) { this.children.push(child); child.parentElement = this; return child; } };

  function makeEl(tag) {
    const attrs = {};
    const node = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      style: {},
      children: [],
      className: '',
      textContent: '',
      parentElement: null,
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      setAttribute(key, value) {
        attrs[key] = String(value);
        if (key === 'id') node.id = String(value);
      },
      getAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null; },
      removeAttribute(key) { delete attrs[key]; },
      addEventListener() {},
      remove() {},
      querySelectorAll() { return []; },
    };
    let id = '';
    Object.defineProperty(node, 'id', {
      configurable: true,
      get() { return id; },
      set(value) {
        id = value || '';
        if (id) ids[id] = node;
      },
    });
    return node;
  }

  const url = new URL(href);
  let payload = { experiments: [] };
  const document = {
    readyState: 'complete',
    cookie: '',
    currentScript: {
      src: 'https://pivitlab.com/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivitlab.com' : null; },
    },
    documentElement: { classList: { add() {}, remove(name) { removed.push(name); } } },
    head,
    body,
    addEventListener() {},
    createElement: makeEl,
    getElementById(id) { return ids[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const sandbox = {
    document,
    window: {
      location: { href, search: url.search },
      document,
      addEventListener() {},
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { sendBeacon() { return true; } },
    fetch: async () => ({ ok: true, json: async () => payload }),
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return timers.length;
    },
    clearTimeout(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  };
  return {
    sandbox,
    document,
    timers,
    removed,
    setPayload(next) { payload = next; },
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const href = `https://site2-spa.netlify.app/?ab_preview=${variantId}&ab_preview_token=preview-token`;
  const env = harness(href);
  env.setPayload({
    experiments: [{
      id: experimentId,
      name: 'Headline',
      variants: [{
        id: variantId,
        name: 'B',
        changes: [{
          selector: 'section.hero h1',
          type: 'text',
          value: 'Fresh flowers, delivered today',
        }],
      }],
    }],
    preview: { variant_id: variantId, experiment_id: experimentId },
  });
  vm.runInNewContext(snippetSrc, env.sandbox, { filename: 'ab.js' });
  await flush();
  assert.ok(env.removed.indexOf('ab-hide') !== -1);
  assert.strictEqual(env.document.getElementById('pivit-preview-missed'), null);
  const wait = env.timers.filter((timer) => timer.ms >= 10000 && !timer.cleared);
  assert.strictEqual(wait.length, 1);
  wait[0].fn();
  const missed = env.document.getElementById('pivit-preview-missed');
  assert.ok(missed);
  assert.strictEqual(
    missed.textContent,
    "Change not applied: the element wasn't found on this page (section.hero h1)."
  );
  assert.strictEqual(missed.getAttribute('role'), 'status');

  const refused = harness(href);
  refused.setPayload({
    experiments: [],
    preview_refused: {
      code: 'token_expired',
      reason: 'token_expired',
      message: 'This preview link has expired, so pivitlab shows the original page. Open Preview again from the test.',
    },
  });
  vm.runInNewContext(snippetSrc, refused.sandbox, { filename: 'ab.js' });
  await flush();
  const banner = refused.document.getElementById('pivit-preview-refused');
  assert.ok(banner);
  assert.ok(banner.textContent.includes('expired'));
  assert.ok(banner.textContent.includes('pivitlab'));
  assert.strictEqual(refused.document.getElementById('pivit-preview-missed'), null);

  const invalid = harness(href);
  invalid.setPayload({
    experiments: [{
      id: experimentId,
      name: 'Other live test',
      variants: [{ id: 'other', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'Should not apply' }] }],
    }],
    preview_refused: {
      code: 'token_invalid',
      reason: 'token_invalid',
      message: 'This preview link is not valid, so pivitlab shows the original page. Open Preview again from the test.',
    },
  });
  vm.runInNewContext(snippetSrc, invalid.sandbox, { filename: 'ab.js' });
  await flush();
  const invalidBanner = invalid.document.getElementById('pivit-preview-refused');
  assert.ok(invalidBanner);
  assert.ok(invalidBanner.textContent.includes('not valid'));
  assert.ok(!invalidBanner.textContent.includes('Should not apply'));

  console.log('late-apply tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
