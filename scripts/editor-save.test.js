// Save confirmation, a failed save that keeps the edit, and undo in the editor.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../snippet/ab.js');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const variantId = '11111111-1111-4111-8111-111111111111';
const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function harness(options) {
  const opts = options || {};
  const ids = {};
  const fetches = [];
  const listeners = [];
  let failSaves = opts.failSaves || 0;
  let mismatch = !!opts.mismatch;
  function makeEl(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      children: [],
      style: {},
      parentElement: null,
      textContent: '',
      value: '',
      className: '',
      attributes: {},
      disabled: false,
      setAttribute(name, value) {
        node.attributes[name] = String(value);
        if (name === 'id') node.id = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
      },
      addEventListener(type, fn) {
        node.listeners = node.listeners || {};
        node.listeners[type] = node.listeners[type] || [];
        node.listeners[type].push(fn);
      },
      click() {
        (node.listeners && node.listeners.click || []).forEach((fn) => fn({
          target: node,
          preventDefault() {},
          stopPropagation() {},
        }));
      },
      focus() {},
      appendChild(child) {
        child.parentElement = node;
        node.children.push(child);
        return child;
      },
      remove() {
        if (node.id && ids[node.id] === node) delete ids[node.id];
        const list = this.parentElement && this.parentElement.children;
        if (!list) return;
        const index = list.indexOf(this);
        if (index >= 0) list.splice(index, 1);
        this.parentElement = null;
      },
      contains() { return false; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
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

  const head = makeEl('head');
  const body = makeEl('body');
  const headline = makeEl('h1');
  headline.id = 'headline';
  headline.textContent = 'Goods from the hill, made to be used.';
  body.appendChild(headline);
  const documentElement = makeEl('html');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  function allNodes() {
    const out = [];
    (function walk(node) {
      out.push(node);
      (node.children || []).forEach(walk);
    })(documentElement);
    return out;
  }

  const document = {
    readyState: 'complete',
    currentScript: {
      src: 'https://pivitlab.com/snippet/editor.js',
      getAttribute(name) {
        if (name === 'data-api') return 'https://pivitlab.com';
        if (name === 'data-variant-id') return variantId;
        return null;
      },
    },
    documentElement,
    head,
    body,
    createElement: makeEl,
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById(id) { return ids[id] || null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '#headline') return [headline];
      if (selector === 'style[data-pivit-css], style[data-pivit-page-css]') {
        return allNodes().filter((node) => node.getAttribute && (
          node.getAttribute('data-pivit-css') != null || node.getAttribute('data-pivit-page-css') != null
        ));
      }
      return [];
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener() {},
  };

  const variant = {
    id: variantId,
    experiment_id: expId,
    experiment_name: 'Homepage headline',
    name: 'Offer',
    experiment_status: opts.status || 'draft',
    experiment_status_label: opts.status === 'running' ? 'Running' : 'Draft',
    edit_warning: opts.status === 'running' ? 'This test is running. Saves go live to visitors straight away.' : '',
    changes: [],
    goals: [],
    goals_scope: 'shared',
    content_revision: 1,
    steps_note: '',
  };

  const sandbox = {
    document,
    window: {
      location: {
        href: `https://demo.pivitlab.com/?ab_edit=${variantId}&token=edit-token`,
        search: `?ab_edit=${variantId}&token=edit-token`,
        origin: 'https://demo.pivitlab.com',
        reload() {},
      },
      history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280,
      innerHeight: 800,
      PivitRuntime: runtime,
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    Array,
    Object,
    JSON,
    fetch: async (target, request) => {
      fetches.push({ url: String(target), opts: request || {} });
      const method = request && request.method;
      if (method === 'PATCH') {
        if (failSaves > 0) {
          failSaves -= 1;
          return { ok: false, status: 500, json: async () => ({ error: 'The network dropped the save.' }) };
        }
        const sent = JSON.parse(request.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            changes: mismatch ? [] : sent.changes,
            goals: sent.goals || [],
            steps_note: sent.steps_note || '',
            content_revision: 2,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => variant };
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.window.document = document;
  return { sandbox, document, fetches, listeners, headline, body };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function findExact(root, label) {
  let found = null;
  walk(root, (node) => {
    if (node.textContent === label && !found) found = node;
  });
  return found;
}

function textOf(node) {
  let text = '';
  walk(node, (item) => { text += item.textContent || ''; });
  return text;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function openDelete(env) {
  env.document.getElementById('pivit-pick-btn').click();
  const event = {
    target: env.headline,
    clientX: 20,
    clientY: 20,
    preventDefault() {},
    stopPropagation() {},
  };
  env.listeners.filter((row) => row.type === 'click').forEach((row) => row.fn(event));
  findExact(env.document.body, 'Just this element').click();
  findExact(env.document.body, 'Delete element').click();
}

function key(env, fields) {
  const event = Object.assign({
    key: 'z',
    target: env.body,
    preventDefault() {},
    stopPropagation() {},
  }, fields);
  env.listeners.filter((row) => row.type === 'keydown').forEach((row) => row.fn(event));
}

function storageKey() {
  return `pivit_editor_changes_${expId}_${variantId}`;
}

(async () => {
  const draft = harness({ failSaves: 1 });
  vm.runInNewContext(editorSrc, draft.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(draft.document.getElementById('pivit-live-state').textContent, 'Draft');
  assert.strictEqual(draft.document.getElementById('pivit-live-detail').textContent, 'This is a draft. Visitors are not seeing it yet.');
  assert.strictEqual(draft.document.getElementById('pivit-revision').textContent, 'Revision 1');
  assert.strictEqual(draft.document.getElementById('pivit-save-state').textContent, 'Saved');
  assert.strictEqual(draft.document.getElementById('pivit-undo').disabled, true);

  openDelete(draft);
  draft.document.getElementById('pivit-delete-confirm-yes').click();
  await flush();
  assert.strictEqual(draft.document.getElementById('pivit-save-state').textContent, 'Unsaved changes');
  assert.ok(findExact(draft.document.body, 'Changes (1) ▼'));
  const storedFail = JSON.parse(draft.sandbox.localStorage.getItem(storageKey()));
  assert.strictEqual(storedFail.changes[0].type, 'delete');

  findExact(draft.document.body, '💾 Save').click();
  await flush();
  assert.strictEqual(draft.document.getElementById('pivit-save-state').textContent, 'Save failed');
  assert.ok(draft.document.getElementById('pivit-save-state').textContent !== 'Saved');
  assert.strictEqual(draft.document.getElementById('pivit-save-error').style.display, 'block');
  assert.ok(textOf(draft.document.getElementById('pivit-save-error')).includes('The network dropped the save.'));
  assert.ok(draft.document.getElementById('pivit-save-retry'));
  assert.ok(findExact(draft.document.body, 'Changes (1) ▼'));
  assert.strictEqual(JSON.parse(draft.sandbox.localStorage.getItem(storageKey())).changes[0].type, 'delete');
  assert.strictEqual(draft.fetches.filter((call) => call.opts.method === 'PATCH').length, 1);

  draft.document.getElementById('pivit-save-retry').click();
  await flush();
  assert.strictEqual(draft.document.getElementById('pivit-save-state').textContent, 'Saved');
  assert.strictEqual(draft.document.getElementById('pivit-save-error').style.display, 'none');
  assert.strictEqual(draft.document.getElementById('pivit-revision').textContent, 'Revision 2');
  assert.strictEqual(draft.sandbox.localStorage.getItem(storageKey()), null);
  assert.strictEqual(draft.sandbox.sessionStorage.getItem(storageKey()), null);

  key(draft, { ctrlKey: true });
  await flush();
  assert.ok(findExact(draft.document.body, 'Changes (0) ▼'));
  assert.strictEqual(draft.document.getElementById('pivit-save-state').textContent, 'Unsaved changes');
  key(draft, { ctrlKey: true, shiftKey: true });
  await flush();
  assert.ok(findExact(draft.document.body, 'Changes (1) ▼'));

  key(draft, { ctrlKey: true });
  await flush();
  draft.document.getElementById('pivit-reset-variant').click();
  await flush();
  const reset = draft.document.getElementById('pivit-reset-confirm');
  assert.ok(textOf(reset).includes('last saved version'));
  draft.document.getElementById('pivit-reset-confirm-yes').click();
  await flush();
  assert.ok(findExact(draft.document.body, 'Changes (1) ▼'));

  draft.document.getElementById('pivit-remove-all').click();
  await flush();
  draft.document.getElementById('pivit-remove-confirm-yes').click();
  await flush();
  assert.ok(findExact(draft.document.body, 'Changes (0) ▼'));
  draft.document.getElementById('pivit-undo').click();
  await flush();
  assert.ok(findExact(draft.document.body, 'Changes (1) ▼'));

  const lying = harness({ mismatch: true });
  vm.runInNewContext(editorSrc, lying.sandbox, { filename: 'editor.js' });
  await flush();
  openDelete(lying);
  lying.document.getElementById('pivit-delete-confirm-yes').click();
  await flush();
  findExact(lying.document.body, '💾 Save').click();
  await flush();
  assert.strictEqual(lying.document.getElementById('pivit-save-state').textContent, 'Save failed');
  assert.ok(textOf(lying.document.getElementById('pivit-save-error')).includes('does not match'));
  assert.strictEqual(JSON.parse(lying.sandbox.localStorage.getItem(storageKey())).changes.length, 1);

  const live = harness({ status: 'running' });
  vm.runInNewContext(editorSrc, live.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(live.document.getElementById('pivit-live-state').textContent, 'Live');
  assert.strictEqual(live.document.getElementById('pivit-live-detail').textContent, 'Visitors can see this test now.');
  findExact(live.document.body, '💾 Save').click();
  await flush();
  const confirm = live.document.getElementById('pivit-live-save-confirm');
  assert.ok(confirm);
  assert.ok(textOf(confirm).includes('This will change the live test for visitors now.'));
  assert.strictEqual(live.fetches.filter((call) => call.opts.method === 'PATCH').length, 0);
  live.document.getElementById('pivit-live-save-confirm-no').click();
  await flush();
  assert.strictEqual(live.fetches.filter((call) => call.opts.method === 'PATCH').length, 0);
  findExact(live.document.body, '💾 Save').click();
  await flush();
  live.document.getElementById('pivit-live-save-confirm-yes').click();
  await flush();
  assert.strictEqual(live.fetches.filter((call) => call.opts.method === 'PATCH').length, 1);
  assert.strictEqual(live.document.getElementById('pivit-save-state').textContent, 'Saved');

  console.log('editor save tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
