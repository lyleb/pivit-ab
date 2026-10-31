// Edit text writes a text change for the selected element. HTML, CSS and JS
// stay on Edit element. Preview already applies type "text".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
assert.ok(editorSrc.includes("title: 'Edit text'"));
assert.ok(editorSrc.includes("type: 'text'"));
assert.ok(editorSrc.includes("label: 'HTML'"));
assert.ok(editorSrc.includes("label: 'CSS'"));
assert.ok(editorSrc.includes("label: 'JS'"));
assert.ok(snippetSrc.includes("case 'text':"));
assert.ok(snippetSrc.includes('el.textContent = change.value'));

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
  function makeEl(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
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
  body.appendChild(headline);
  const documentElement = makeEl('html');
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
      return [];
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((row) => row.type === type && row.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  documentElement.appendChild(head);
  documentElement.appendChild(body);

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
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
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
  return { sandbox, document, fetches, headline, dispatchClick, ids };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function findExact(root, label) {
  let found = null;
  walk(root, (node) => {
    if (node.textContent === label) found = node;
  });
  return found;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const env = harness();
  vm.runInNewContext(editorSrc, env.sandbox, { filename: 'editor.js' });
  await flush();
  const select = env.document.getElementById('pivit-pick-btn');
  assert.ok(select);
  select.click();
  env.dispatchClick(env.headline);
  const editText = findExact(env.document.body, 'Edit text');
  const editElement = findExact(env.document.body, '✎ Edit element');
  assert.ok(editText);
  assert.ok(editElement);
  editText.click();
  await flush();
  const panel = env.document.getElementById('pivit-edit-text-panel');
  assert.ok(panel);
  let panelText = '';
  const areas = [];
  walk(panel, (node) => {
    panelText += node.textContent || '';
    if (node.tagName === 'TEXTAREA') areas.push(node);
  });
  assert.ok(panelText.includes('Edit text'));
  assert.ok(panelText.includes('No HTML'));
  assert.strictEqual(areas.length, 1);
  assert.strictEqual(areas[0].value, 'Goods from the hill, made to be used.');
  areas[0].value = 'Goods from the hill, ready this week.';
  const apply = findExact(panel, 'Apply');
  assert.ok(apply);
  apply.click();
  await flush();
  assert.strictEqual(env.document.getElementById('pivit-edit-text-panel'), null);
  assert.strictEqual(env.headline.textContent, 'Goods from the hill, ready this week.');

  const save = findExact(env.document.body, '💾 Save');
  assert.ok(save);
  save.click();
  await flush();
  const patch = env.fetches.filter((call) => call.opts.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  const saved = JSON.parse(patch[0].opts.body);
  assert.deepStrictEqual(saved.changes, [{
    selector: '#headline',
    type: 'text',
    value: 'Goods from the hill, ready this week.',
  }]);

  console.log('edit-text tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
