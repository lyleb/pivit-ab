// The editor toolbar names the test, the variant and the status. An archived
// test cannot be edited: the old link shows an expired notice and does not
// load the editor or apply the variant.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  statusLabel,
  archivedEditMessage,
  expiredEditMessage,
  expiredPreviewMessage,
  archivedPreviewMessage,
  runningEditWarning,
  linkLabel,
  editorFields,
  archivedBody,
  testPageUrl,
} = require('../src/editor-context');

const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const variantId = '11111111-1111-4111-8111-111111111111';

assert.strictEqual(statusLabel('draft'), 'Draft');
assert.strictEqual(statusLabel('running'), 'Running');
assert.strictEqual(statusLabel('paused'), 'Paused');
assert.strictEqual(statusLabel('archived'), 'Archived');
assert.strictEqual(archivedEditMessage('Checkout step'), '"Checkout step" is archived, so this variant can\'t be edited.');
assert.strictEqual(expiredEditMessage('Checkout step'), 'This edit link has expired. "Checkout step" is archived.');
assert.strictEqual(expiredPreviewMessage('Checkout step'), 'This preview link has expired. "Checkout step" is archived.');
assert.strictEqual(archivedPreviewMessage('Checkout step'), '"Checkout step" is archived, so it can\'t be previewed.');
assert.strictEqual(archivedEditMessage(''), 'This test is archived, so this variant can\'t be edited.');
assert.strictEqual(runningEditWarning(), 'This test is running. Saves go live to visitors straight away.');
assert.strictEqual(linkLabel('Checkout step'), 'Open Checkout step in pivitlab');
assert.strictEqual(linkLabel(''), 'Open the test in pivitlab');
assert.strictEqual(editorFields('running').edit_warning, runningEditWarning());
assert.strictEqual(editorFields('paused').edit_warning, '');
assert.strictEqual(editorFields('draft').experiment_status_label, 'Draft');
assert.ok(!/Pivit(?!lab)/.test(runningEditWarning()));
assert.ok(runningEditWarning().includes('pivitlab') === false);

const previousOrigin = process.env.APP_ORIGIN;
delete process.env.APP_ORIGIN;
const req = { protocol: 'http', get: () => '127.0.0.1:3000' };
const body = archivedBody(req, {
  id: expId,
  name: 'Checkout step',
  variantId,
  variantName: 'Checkout Social proof',
}, expiredEditMessage('Checkout step'));
assert.strictEqual(body.code, 'archived');
assert.strictEqual(body.error, body.message);
assert.strictEqual(body.test.name, 'Checkout step');
assert.strictEqual(body.test.status, 'archived');
assert.strictEqual(body.test.status_label, 'Archived');
assert.strictEqual(body.test.url, `http://127.0.0.1:3000/index.html#experiment/${expId}`);
assert.strictEqual(body.test.link_label, 'Open Checkout step in pivitlab');
assert.strictEqual(body.variant.name, 'Checkout Social proof');
assert.strictEqual(body.changes, undefined);
assert.strictEqual(testPageUrl(req, 'not-a-uuid'), '');
process.env.APP_ORIGIN = 'https://pivitlab.com/';
assert.strictEqual(
  testPageUrl(req, expId),
  `https://pivitlab.com/index.html#experiment/${expId}`
);
if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
else process.env.APP_ORIGIN = previousOrigin;

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
assert.ok(editorSrc.includes('pivit-editor-test'));
assert.ok(editorSrc.includes('pivit-editor-variant'));
assert.ok(editorSrc.includes('pivit-editor-status'));
assert.ok(editorSrc.includes('pivit-editor-live'));
assert.ok(editorSrc.includes('edit_warning'));
assert.ok(editorSrc.includes('pivit-expired-link'));
assert.ok(snippetSrc.includes('pivit-expired-link'));
assert.ok(snippetSrc.includes("data.code === 'archived'"));
assert.ok(snippetSrc.includes('preview_expired'));
assert.ok(snippetSrc.includes("const EDITOR_VERSION = '20261016a'"));
assert.ok(editorSrc.includes("This selector isn't on the current page."));
assert.ok(editorSrc.includes('pivit-selector-warning'));
assert.ok(snippetSrc.includes('editor.js?v='));
assert.ok(!editorSrc.includes('Pivit editor'));

function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] || null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function harness({ href, currentScript, respond }) {
  const writes = [];
  let text = 'Original';
  const h1 = {
    nodeType: 1,
    tagName: 'H1',
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
  const fetches = [];
  const document = {
    readyState: 'complete',
    cookie: '',
    currentScript: currentScript || null,
    documentElement: { classList: { add() {}, remove() {} } },
    head,
    body,
    addEventListener() {},
    createElement: makeEl,
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById(id) { return ids[id] || null; },
    querySelector(selector) {
      if (selector === 'script[src*="/snippet/editor.js"]') return currentScript || null;
      return null;
    },
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
    window: { location: { href, search: url.search }, pivitConsent: true },
    sessionStorage: memoryStorage(),
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
      length: 0,
      key() { return null; },
    },
    navigator: { sendBeacon() { return true; } },
    fetch: async (target, opts) => {
      fetches.push({ url: String(target), opts: opts || {} });
      return respond(String(target), opts || {});
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.window.document = document;

  return { sandbox, writes, h1, head, body, fetches, document };
}

function jsonResponse(ok, payload, status) {
  return {
    ok,
    status: status || (ok ? 200 : 409),
    json() { return Promise.resolve(payload); },
  };
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function editorScript() {
  return {
    src: 'https://pivitlab.com/snippet/editor.js',
    getAttribute(name) {
      if (name === 'data-api') return 'https://pivitlab.com';
      if (name === 'data-variant-id') return variantId;
      return null;
    },
  };
}

function textOf(node) {
  if (!node) return '';
  let text = node.textContent || '';
  (node.children || []).forEach((child) => { text += textOf(child); });
  return text;
}

function findLink(node) {
  if (!node) return null;
  if (node.tagName === 'A') return node;
  for (const child of node.children || []) {
    const found = findLink(child);
    if (found) return found;
  }
  return null;
}

(async () => {
  const running = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: editorScript(),
    respond: () => jsonResponse(true, {
      id: variantId,
      experiment_id: expId,
      experiment_name: 'Social Proof',
      name: 'Checkout Social proof',
      experiment_status: 'running',
      experiment_status_label: 'Running',
      edit_warning: runningEditWarning(),
      changes: [{ selector: 'h1', type: 'text', value: 'Live headline' }],
      goals: [],
      goals_scope: 'shared',
    }),
  });
  vm.runInNewContext(editorSrc, running.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(running.document.getElementById('pivit-editor-test').textContent, 'Social Proof');
  assert.strictEqual(running.document.getElementById('pivit-editor-variant').textContent, 'Checkout Social proof');
  assert.strictEqual(running.document.getElementById('pivit-editor-status').textContent, 'Running');
  assert.strictEqual(running.document.getElementById('pivit-editor-live').textContent, runningEditWarning());
  assert.strictEqual(running.document.getElementById('pivit-selector-warning').textContent, '');
  assert.ok(running.document.getElementById('pivit-pick-btn'));
  assert.strictEqual(running.document.getElementById('pivit-expired-link'), null);
  assert.deepStrictEqual(running.writes, ['Live headline']);

  const draft = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: editorScript(),
    respond: () => jsonResponse(true, {
      id: variantId,
      experiment_id: expId,
      experiment_name: 'Homepage',
      name: 'Control',
      experiment_status: 'paused',
      experiment_status_label: 'Paused',
      edit_warning: '',
      changes: [],
      goals: [],
    }),
  });
  vm.runInNewContext(editorSrc, draft.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(draft.document.getElementById('pivit-editor-status').textContent, 'Paused');
  assert.strictEqual(draft.document.getElementById('pivit-editor-live'), null);
  assert.ok(draft.document.getElementById('pivit-pick-btn'));

  const archivedPayload = archivedBody(
    { protocol: 'https', get: () => 'pivitlab.com' },
    { id: expId, name: 'Checkout step', variantId, variantName: 'Checkout Social proof' },
    expiredEditMessage('Checkout step')
  );
  const archived = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: editorScript(),
    respond: () => jsonResponse(false, archivedPayload, 409),
  });
  vm.runInNewContext(editorSrc, archived.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(archived.document.getElementById('pivit-pick-btn'), null);
  assert.strictEqual(archived.document.getElementById('pivit-editor-identity'), null);
  const notice = archived.document.getElementById('pivit-expired-link');
  assert.ok(notice);
  const noticeText = textOf(notice);
  assert.ok(noticeText.includes('This edit link has expired.'));
  assert.ok(noticeText.includes('Checkout step'));
  assert.ok(noticeText.includes('Checkout Social proof'));
  assert.ok(noticeText.includes('Archived'));
  const link = findLink(notice);
  assert.ok(link);
  assert.strictEqual(link.href, `https://pivitlab.com/index.html#experiment/${expId}`);
  assert.strictEqual(link.textContent, 'Open Checkout step in pivitlab');
  assert.deepStrictEqual(archived.writes, []);
  assert.strictEqual(archived.h1.textContent, 'Original');

  const editBlocked = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: {
      src: 'https://pivitlab.com/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivitlab.com' : null; },
    },
    respond: () => jsonResponse(false, archivedPayload, 409),
  });
  vm.runInNewContext(snippetSrc, editBlocked.sandbox, { filename: 'ab.js' });
  await flush();
  assert.strictEqual(editBlocked.head.children.length, 0);
  assert.ok(editBlocked.document.getElementById('pivit-expired-link'));
  assert.strictEqual(findLink(editBlocked.document.getElementById('pivit-expired-link')).textContent, 'Open Checkout step in pivitlab');
  assert.strictEqual(editBlocked.fetches.length, 1);
  assert.ok(editBlocked.fetches[0].url.includes(`/api/editor/variants/${variantId}`));
  assert.deepStrictEqual(editBlocked.writes, []);

  const editOk = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: {
      src: 'https://pivitlab.com/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivitlab.com' : null; },
    },
    respond: () => jsonResponse(true, { id: variantId, experiment_status: 'running' }),
  });
  vm.runInNewContext(snippetSrc, editOk.sandbox, { filename: 'ab.js' });
  await flush();
  assert.strictEqual(editOk.head.children.length, 1);
  assert.strictEqual(editOk.head.children[0].getAttribute('data-variant-id'), variantId);
  assert.strictEqual(editOk.document.getElementById('pivit-expired-link'), null);

  const previewBlocked = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_preview=${variantId}&ab_preview_token=preview-token`,
    currentScript: {
      src: 'https://pivitlab.com/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivitlab.com' : null; },
    },
    respond: () => jsonResponse(true, {
      experiments: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Other',
        variants: [{ id: '22222222-2222-4222-8222-222222222222', name: 'B', changes: [{ selector: 'h1', type: 'text', value: 'Should not apply' }] }],
      }],
      preview_expired: archivedBody(
        { protocol: 'https', get: () => 'pivitlab.com' },
        { id: expId, name: 'Checkout step', variantId, variantName: 'Checkout Social proof' },
        expiredPreviewMessage('Checkout step')
      ),
    }),
  });
  vm.runInNewContext(snippetSrc, previewBlocked.sandbox, { filename: 'ab.js' });
  await flush();
  const previewNotice = textOf(previewBlocked.document.getElementById('pivit-expired-link'));
  assert.ok(previewNotice.includes('This preview link has expired.'));
  assert.ok(previewNotice.includes('Checkout step'));
  assert.ok(previewNotice.includes('Archived'));
  assert.deepStrictEqual(previewBlocked.writes, []);
  assert.strictEqual(previewBlocked.h1.textContent, 'Original');
  assert.strictEqual(previewBlocked.head.children.length, 0);

  const missingSelector = harness({
    href: `https://cantsaythat.co.uk/checkout?ab_edit=${variantId}&token=edit-token`,
    currentScript: editorScript(),
    respond: () => jsonResponse(true, {
      id: variantId,
      experiment_id: expId,
      experiment_name: 'Checkout',
      name: 'Headline',
      experiment_status: 'draft',
      experiment_status_label: 'Draft',
      edit_warning: '',
      changes: [{ selector: '.not-on-this-page', type: 'text', value: 'New headline' }],
      goals: [],
    }),
  });
  vm.runInNewContext(editorSrc, missingSelector.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(
    missingSelector.document.getElementById('pivit-selector-warning').textContent,
    "This selector isn't on the current page."
  );
  assert.ok(textOf(missingSelector.document.body).includes("This selector isn't on the current page."));

  console.log('editor archive tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
