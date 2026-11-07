// Delete element confirms, hides the node without removing it, and can be
// undone in the editing session. The snippet applies the same change.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ui = require('../public/admin-ui');
const { validateChanges } = require('../src/changes');
const runtime = require('../snippet/ab.js');

assert.strictEqual(validateChanges([{ selector: '#pay-now', type: 'delete', label: 'Pay now' }]), null);
assert.strictEqual(
  ui.describeChange({ type: 'delete', selector: 'h1', label: 'Goods from the hill, made to be used.' }),
  'Deleted: Goods from the hill, made to be used.'
);
assert.strictEqual(ui.describeChange({ type: 'delete', selector: '#pay-now', label: '  ' }), 'Deleted: #pay-now');
assert.strictEqual(ui.describeChange({ type: 'delete' }), 'Deleted: element');
assert.strictEqual(
  runtime.cssForChange({ selector: '#headline', type: 'delete', label: 'Heading' }),
  '#headline{display:none !important}'
);

const dashboard = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const experiments = fs.readFileSync(path.join(__dirname, '../src/routes/experiments.js'), 'utf8');
assert.ok(dashboard.includes('function variantChangeLines'));
assert.ok(dashboard.includes('function wizardChangeLines'));
assert.ok(dashboard.includes('UI.describeChange'));
assert.ok(dashboard.includes("if (hash === '#create' && !agencyCanChange())"));
assert.ok(dashboard.includes('data-manage="edit"'));
assert.ok(!dashboard.includes('Delete element'));
const editRoute = experiments.indexOf("router.post('/:id/variants/:variantId/edit-link'");
assert.ok(editRoute !== -1);
assert.ok(experiments.slice(editRoute, editRoute + 1400).includes('refuseViewOnly(req, res)'));

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
assert.ok(editorSrc.includes("['Delete element', () => openDeleteConfirm(el, selector)]"));
assert.ok(editorSrc.includes("type: 'delete'"));
assert.ok(editorSrc.includes('editing session'));

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

function harness() {
  const ids = {};
  const fetches = [];
  const listeners = [];
  let removedHeadline = 0;
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
        (node.listeners && node.listeners.click || []).forEach((fn) => fn({ target: node, preventDefault() {}, stopPropagation() {} }));
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
  const originalRemove = headline.remove.bind(headline);
  headline.remove = () => { removedHeadline += 1; originalRemove(); };
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

  function dispatchClick(target) {
    const event = {
      target,
      clientX: 20,
      clientY: 20,
      preventDefault() {},
      stopPropagation() {},
    };
    listeners.filter((row) => row.type === 'click').forEach((row) => row.fn(event));
  }

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
    fetch: async (target, opts) => {
      fetches.push({ url: String(target), opts: opts || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: variantId,
          experiment_id: expId,
          experiment_name: 'Homepage headline',
          name: 'Offer',
          experiment_status: 'draft',
          experiment_status_label: 'Draft',
          edit_warning: '',
          changes: [],
          goals: [],
          goals_scope: 'shared',
        }),
      };
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.window.document = document;
  return { sandbox, document, fetches, headline, dispatchClick, head, removed: () => removedHeadline };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function findId(root, id) {
  let found = null;
  walk(root, (node) => { if (node.id === id) found = node; });
  return found;
}

function findExact(root, label) {
  let found = null;
  walk(root, (node) => {
    if (node.textContent === label) found = node;
  });
  return found;
}

function textOf(node) {
  let text = '';
  walk(node, (item) => { text += item.textContent || ''; });
  return text;
}

function hideRules(head) {
  return (head.children || []).map((node) => node.textContent || '').join('\n');
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function openDelete(env) {
  env.document.getElementById('pivit-pick-btn').click();
  env.dispatchClick(env.headline);
  const one = findExact(env.document.body, 'Just this element');
  assert.ok(one);
  one.click();
  const action = findExact(env.document.body, 'Delete element');
  assert.ok(action);
  action.click();
}

(async () => {
  const env = harness();
  vm.runInNewContext(editorSrc, env.sandbox, { filename: 'editor.js' });
  await flush();

  openDelete(env);
  const panel = env.document.getElementById('pivit-delete-confirm');
  assert.ok(panel);
  const panelText = textOf(panel);
  assert.ok(panelText.includes('Goods from the hill, made to be used.'), panelText);
  assert.ok(panelText.includes('editing session'), panelText);
  assert.ok(panelText.includes('undo'), panelText);
  env.document.getElementById('pivit-delete-confirm-no').click();
  assert.strictEqual(env.document.getElementById('pivit-delete-confirm'), null);
  assert.strictEqual(hideRules(env.head).indexOf('display:none'), -1);
  assert.strictEqual(env.removed(), 0);
  assert.strictEqual(env.headline.parentElement, env.document.body);

  openDelete(env);
  const confirm = env.document.getElementById('pivit-delete-confirm');
  findId(confirm, 'pivit-delete-confirm-yes').click();
  await flush();
  assert.ok(hideRules(env.head).indexOf('#headline{display:none !important}') !== -1);
  assert.strictEqual(env.headline.parentElement, env.document.body);
  assert.strictEqual(env.removed(), 0);
  const warn = env.document.getElementById('pivit-selector-warning');
  assert.ok(warn);
  assert.strictEqual(warn.style.display, 'none');

  openDelete(env);
  const again = env.document.getElementById('pivit-delete-confirm');
  assert.ok(textOf(again).includes('already deleted'), textOf(again));
  assert.strictEqual(findId(again, 'pivit-delete-confirm-yes'), null);
  findId(again, 'pivit-delete-confirm-no').click();

  const toggle = findExact(env.document.body, 'Changes (1) ▼');
  assert.ok(toggle);
  toggle.click();
  assert.ok(findExact(env.document.body, 'Deleted: Goods from the hill, made to be used.'));
  const undo = findExact(env.document.body, 'Undo');
  assert.ok(undo);
  undo.click();
  await flush();
  assert.strictEqual(hideRules(env.head).indexOf('display:none'), -1);
  assert.strictEqual(env.headline.parentElement, env.document.body);
  assert.strictEqual(env.removed(), 0);
  assert.ok(findExact(env.document.body, 'Changes (0) ▲') || findExact(env.document.body, 'Changes (0) ▼'));

  openDelete(env);
  const savedPanel = env.document.getElementById('pivit-delete-confirm');
  findId(savedPanel, 'pivit-delete-confirm-yes').click();
  await flush();
  findExact(env.document.body, '💾 Save').click();
  await flush();
  const patch = env.fetches.filter((call) => call.opts && call.opts.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  const saved = JSON.parse(patch[0].opts.body);
  assert.deepStrictEqual(saved.changes, [{
    selector: '#headline',
    type: 'delete',
    label: 'Goods from the hill, made to be used.',
  }]);

  console.log('delete-element tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
