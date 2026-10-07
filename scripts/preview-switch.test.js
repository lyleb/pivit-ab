// Switching from experiment A to experiment B, both with a variant named B,
// on the same host. A leftover edit/preview query, a stale editor buffer, or
// another experiment in the preview payload must not win.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const expA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const expB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const varA = '11111111-1111-4111-8111-111111111111';
const varB = '22222222-2222-4222-8222-222222222222';
const tokenA = 'token-for-a';
const tokenB = 'token-for-b';

const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const editorRouteSrc = fs.readFileSync(path.join(__dirname, '../src/routes/editor.js'), 'utf8');

assert.ok(serverSrc.includes("app.use('/snippet/editor.js'"));
assert.ok(serverSrc.includes("res.set('Cache-Control', 'no-store')"));
assert.ok(!serverSrc.includes("app.use('/snippet', (req, res, next)"));
assert.ok(editorRouteSrc.includes("res.set('Cache-Control', 'no-store')"));
assert.ok(snippetSrc.includes('editor.js?v='));
assert.ok(snippetSrc.includes("cache: 'no-store'"));
assert.ok(editorSrc.includes('pivit_editor_changes_${experimentId}_${VARIANT_ID}'));

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] || null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function harness({ href, storage, currentScript }) {
  const writes = [];
  let text = 'Original';
  const h1 = {
    nodeType: 1,
    style: {},
    isConnected: true,
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    matches() { return false; },
    querySelectorAll() { return []; },
    remove() {},
    cloneNode() { return {}; },
    insertAdjacentHTML() {},
    insertAdjacentElement() {},
  };
  Object.defineProperty(h1, 'textContent', {
    get() { return text; },
    set(value) { text = value; writes.push(value); },
  });

  const ids = {};
  const head = { children: [], appendChild(child) { this.children.push(child); child.parentElement = this; return child; } };
  const body = { children: [], appendChild(child) { this.children.push(child); child.parentElement = this; return child; } };

  function makeEl(tag) {
    const attrs = {};
    const node = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      style: {},
      children: [],
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      parentElement: null,
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      setAttribute(key, value) { attrs[key] = String(value); },
      getAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null; },
      removeAttribute(key) { delete attrs[key]; },
      addEventListener() {},
      remove() {
        const list = this.parentElement && this.parentElement.children;
        if (!list) return;
        const index = list.indexOf(this);
        if (index >= 0) list.splice(index, 1);
        this.parentElement = null;
      },
      contains() { return false; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      cloneNode() { return makeEl(tag); },
      insertAdjacentHTML() {},
      insertAdjacentElement() {},
    };
    let id = '';
    Object.defineProperty(node, 'id', {
      configurable: true,
      get() { return id; },
      set(value) { id = value || ''; if (id) ids[id] = node; },
    });
    return node;
  }

  const url = new URL(href);
  const store = storage || memoryStorage();
  const localSets = [];
  const beacons = [];
  const fetches = [];
  let payload = { experiments: [] };

  const document = {
    readyState: 'complete',
    cookie: '',
    currentScript: currentScript || {
      src: 'https://pivit.example/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivit.example' : null; },
    },
    documentElement: { classList: { add() {}, remove() {} } },
    head,
    body,
    addEventListener() {},
    createElement: makeEl,
    getElementById(id) { return ids[id] || null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === 'script[data-pivit-editor]') {
        return head.children.filter((node) => node.getAttribute && node.getAttribute('data-pivit-editor'));
      }
      if (selector === 'h1') return [h1];
      return [];
    },
  };

  const sandbox = {
    document,
    window: { location: { href, search: url.search }, pivitConsent: undefined },
    sessionStorage: store,
    localStorage: {
      getItem(key) { return key === `_ab_assign_${expA}` ? varA : null; },
      setItem(key) { localSets.push(key); },
      length: 1,
      key() { return `_ab_assign_${expA}`; },
    },
    navigator: { sendBeacon(target) { beacons.push(target); return true; } },
    fetch: async (target, opts) => {
      fetches.push({ url: String(target), opts: opts || {} });
      return { ok: true, json: async () => payload };
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.window.document = document;

  return {
    sandbox,
    writes,
    h1,
    head,
    beacons,
    fetches,
    localSets,
    store,
    setPayload(next) { payload = next; },
  };
}

function bothExperiments() {
  return {
    experiments: [
      {
        id: expA,
        name: 'First test',
        variants: [{ id: varA, name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }] }],
      },
      {
        id: expB,
        name: 'Second test',
        variants: [{ id: varB, name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment B' }] }],
      },
    ],
    preview: { variant_id: varB, experiment_id: expB },
  };
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runSnippet(env) {
  vm.runInNewContext(snippetSrc, env.sandbox, { filename: 'ab.js' });
  await flush();
}

async function runEditor(env) {
  vm.runInNewContext(editorSrc, env.sandbox, { filename: 'editor.js' });
  await flush();
}

(async () => {
  // Leftover ab_edit from experiment A, then a preview link for experiment B.
  // Preview must load B, and must not apply A's same-named variant or log an event.
  const previewHref = `https://cantsaythat.co.uk/pricing?ab_edit=${varA}&token=${tokenA}&ab_preview=${varB}&ab_preview_token=${tokenB}`;
  const previewEnv = harness({ href: previewHref });
  previewEnv.setPayload(bothExperiments());
  await runSnippet(previewEnv);
  assert.deepStrictEqual(previewEnv.writes, ['From experiment B']);
  assert.strictEqual(previewEnv.beacons.length, 0);
  assert.strictEqual(previewEnv.localSets.length, 0);
  assert.strictEqual(previewEnv.head.children.length, 0);
  assert.strictEqual(previewEnv.fetches.length, 1);
  assert.ok(previewEnv.fetches[0].url.includes(`preview_variant=${encodeURIComponent(varB)}`));
  assert.ok(previewEnv.fetches[0].url.includes(`preview_token=${encodeURIComponent(tokenB)}`));
  assert.ok(!previewEnv.fetches[0].url.includes(`preview_variant=${encodeURIComponent(varA)}`));
  assert.strictEqual(previewEnv.fetches[0].opts.cache, 'no-store');

  // A preview token the server rejected must not fall through onto experiment A.
  const rejectedHref = `https://cantsaythat.co.uk/pricing?ab_preview=${varB}&ab_preview_token=${tokenB}`;
  const rejectedEnv = harness({ href: rejectedHref });
  rejectedEnv.setPayload({
    experiments: [{
      id: expA,
      name: 'First test',
      variants: [{ id: varA, name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }], traffic_split: 100 }],
    }],
  });
  await runSnippet(rejectedEnv);
  assert.deepStrictEqual(rejectedEnv.writes, []);
  assert.strictEqual(rejectedEnv.h1.textContent, 'Original');
  assert.strictEqual(rejectedEnv.beacons.length, 0);
  assert.strictEqual(rejectedEnv.localSets.length, 0);

  // A newer edit link wins over an older preview, and the injected editor is B's.
  const editHref = `https://cantsaythat.co.uk/pricing?ab_preview=${varA}&ab_preview_token=${tokenA}&ab_edit=${varB}&token=${tokenB}`;
  const stale = harness({ href: editHref }).sandbox.document.createElement('script');
  stale.setAttribute('data-pivit-editor', '1');
  stale.setAttribute('data-variant-id', varA);
  const editEnv = harness({ href: editHref });
  editEnv.head.appendChild(stale);
  await runSnippet(editEnv);
  assert.strictEqual(editEnv.fetches.length, 0);
  assert.strictEqual(editEnv.head.children.length, 1);
  const injected = editEnv.head.children[0];
  assert.strictEqual(injected.getAttribute('data-variant-id'), varB);
  assert.ok(injected.src.includes('/snippet/editor.js?v='));
  assert.strictEqual(injected.getAttribute('data-pivit-editor'), '1');

  // The editor's script tag still says variant A, and sessionStorage holds A's
  // changes (including a buffer stored under B's key for the wrong experiment).
  // The page URL's last ab_edit is B, so the toolbar must show B.
  const editorHref = `https://cantsaythat.co.uk/pricing?ab_edit=${varA}&token=${tokenA}&ab_edit=${varB}&token=${tokenB}`;
  const editorStorage = memoryStorage({
    [`pivit_editor_changes_${varA}`]: JSON.stringify({
      changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }],
      goals: [],
    }),
    [`pivit_editor_changes_${expB}_${varB}`]: JSON.stringify({
      experimentId: expA,
      variantId: varB,
      changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }],
      goals: [],
    }),
  });
  const staleScript = {
    src: 'https://pivit.example/snippet/editor.js',
    getAttribute(name) {
      if (name === 'data-api') return 'https://pivit.example';
      if (name === 'data-variant-id') return varA;
      return null;
    },
  };
  const editorEnv = harness({ href: editorHref, storage: editorStorage, currentScript: staleScript });
  editorEnv.fetch = null;
  editorEnv.sandbox.fetch = async (target, opts) => {
    editorEnv.fetches.push({ url: String(target), opts: opts || {} });
    const requested = String(target).includes(varB) ? varB : varA;
    const body = requested === varB
      ? { id: varB, experiment_id: expB, experiment_name: 'Second test', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment B' }], goals: [] }
      : { id: varA, experiment_id: expA, experiment_name: 'First test', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }], goals: [] };
    return {
      ok: true,
      json: async () => body,
      catch() { return {}; },
    };
  };
  // fetch().json().catch is not how the editor catches errors — res.json().catch.
  editorEnv.sandbox.fetch = async (target, opts) => {
    editorEnv.fetches.push({ url: String(target), opts: opts || {} });
    const requested = String(target).includes(varB) ? varB : varA;
    const body = requested === varB
      ? { id: varB, experiment_id: expB, experiment_name: 'Second test', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment B' }], goals: [] }
      : { id: varA, experiment_id: expA, experiment_name: 'First test', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'From experiment A' }], goals: [] };
    return {
      ok: true,
      json() { return Promise.resolve(body); },
    };
  };
  await runEditor(editorEnv);
  assert.ok(editorEnv.fetches.length >= 1, 'editor did not fetch a variant');
  assert.ok(editorEnv.fetches[0].url.includes(`/variants/${varB}`), editorEnv.fetches[0].url);
  assert.ok(!editorEnv.fetches[0].url.includes(`/variants/${varA}`));
  assert.ok(editorEnv.fetches[0].url.includes(`token=${encodeURIComponent(tokenB)}`));
  assert.strictEqual(editorEnv.fetches[0].opts.cache, 'no-store');
  assert.deepStrictEqual(editorEnv.writes, ['From experiment B']);
  assert.strictEqual(editorEnv.store.getItem(`pivit_editor_changes_${varA}`), null);
  assert.strictEqual(editorEnv.store.getItem(`pivit_editor_changes_${expB}_${varB}`), null);

  console.log('preview switch tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
