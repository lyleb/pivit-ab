// The visual editor offers Whole page beside Select element. Applying it
// stores page_css and page_js and leaves element HTML, CSS and JS entries
// exactly as they were.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
assert.ok(editorSrc.includes('This picks the element by its position on the page, so it may break if the page layout changes.'));
assert.ok(editorSrc.includes('isPositionalSelector(suggested)'));
assert.ok(!editorSrc.includes('positional selector'));
const variantId = '11111111-1111-4111-8111-111111111111';
const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const elementChanges = [
  { selector: '#cta', type: 'html', value: '<b>Buy</b>' },
  { selector: '#cta', type: 'replace', value: '<a id="cta">Buy</a>' },
  { selector: '#cta', type: 'stylesheet', value: '#cta{color:red}' },
  { selector: '#cta', type: 'js', value: 'el.dataset.ready = "1"' },
];

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

function harness(changes) {
  const ids = {};
  const fetches = [];
  const reloads = [];
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
        node.listeners[type] = fn;
      },
      click() {
        if (node.listeners && node.listeners.click) node.listeners.click();
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
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const sandbox = {
    document,
    window: {
      location: {
        href: `https://cantsaythat.co.uk/pricing?ab_edit=${variantId}&token=edit-token`,
        search: `?ab_edit=${variantId}&token=edit-token`,
        reload() { reloads.push(1); },
      },
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
          experiment_name: 'Pricing',
          name: 'Offer',
          experiment_status: 'draft',
          experiment_status_label: 'Draft',
          edit_warning: '',
          changes,
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
  return { sandbox, document, fetches, reloads, ids };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function findButton(root, label) {
  let found = null;
  walk(root, (node) => {
    if (node.tagName === 'BUTTON' && node.textContent === label) found = node;
  });
  return found;
}

function fields(panel) {
  const areas = [];
  walk(panel, (node) => {
    if (node.tagName === 'TEXTAREA') areas.push(node);
  });
  return areas;
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  assert.ok(editorSrc.includes('Whole page'));
  assert.ok(editorSrc.includes("type: 'page_css'"));
  assert.ok(editorSrc.includes("type: 'page_js'"));
  assert.ok(editorSrc.includes("type: 'stylesheet'"));
  assert.ok(editorSrc.includes("type: 'replace'"));
  assert.ok(!editorSrc.includes('Pivit editor'));

  const fresh = harness(elementChanges.slice());
  vm.runInNewContext(editorSrc, fresh.sandbox, { filename: 'editor.js' });
  await flush();

  const pageBtn = fresh.document.getElementById('pivit-whole-page');
  const pickBtn = fresh.document.getElementById('pivit-pick-btn');
  assert.ok(pageBtn);
  assert.ok(pickBtn);
  assert.strictEqual(pageBtn.textContent, 'Whole page');
  assert.strictEqual(pickBtn.textContent, 'Select');
  const browseBtn = fresh.document.getElementById('pivit-browse-btn');
  const modeStatus = fresh.document.getElementById('pivit-mode-status');
  assert.strictEqual(browseBtn.textContent, 'Browse');
  assert.strictEqual(browseBtn.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(modeStatus.textContent, 'Browse is on. Clicks go to the site.');

  pageBtn.click();
  await flush();
  const panel = fresh.document.getElementById('pivit-whole-page-panel');
  assert.ok(panel);
  let title = '';
  walk(panel, (node) => { title += node.textContent || ''; });
  assert.ok(title.includes('Whole page'));
  assert.ok(title.includes('This page, not one element'));
  assert.ok(title.includes('single style tag'));
  assert.ok(title.includes('once each time this page is viewed'));
  assert.ok(title.indexOf('Pivit') === -1);

  const areas = fields(panel);
  assert.strictEqual(areas.length, 2);
  areas[0].value = 'body { margin: 0; }';
  areas[1].value = 'document.documentElement.setAttribute("data-page", "1")';
  const apply = findButton(panel, 'Apply');
  assert.ok(apply);
  apply.click();
  await flush();
  assert.strictEqual(fresh.document.getElementById('pivit-whole-page-panel'), null);
  assert.strictEqual(fresh.reloads.length, 0);
  assert.strictEqual(fresh.document.documentElement.getAttribute('data-page'), '1');

  const save = findButton(fresh.document.body, '💾 Save');
  assert.ok(save);
  save.click();
  await flush();
  const patch = fresh.fetches.filter((call) => call.opts.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  const saved = JSON.parse(patch[0].opts.body);
  assert.deepStrictEqual(saved.changes.slice(0, 4), elementChanges);
  assert.deepStrictEqual(saved.changes[4], { type: 'page_css', value: 'body { margin: 0; }' });
  assert.deepStrictEqual(saved.changes[5], { type: 'page_js', value: 'document.documentElement.setAttribute("data-page", "1")' });

  const existing = harness([
    { type: 'page_css', value: 'body{margin:0}' },
    { type: 'page_js', value: 'document.documentElement.setAttribute("data-runs", String(Number(document.documentElement.getAttribute("data-runs") || 0) + 1))' },
    { selector: 'h1', type: 'html', value: '<span>Keep</span>' },
  ]);
  vm.runInNewContext(editorSrc, existing.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(existing.document.documentElement.getAttribute('data-runs'), '1');
  existing.document.getElementById('pivit-whole-page').click();
  await flush();
  const editPanel = existing.document.getElementById('pivit-whole-page-panel');
  const editAreas = fields(editPanel);
  assert.strictEqual(editAreas[0].value, 'body{margin:0}');
  assert.ok(editAreas[1].value.includes('data-runs'));
  editAreas[1].value = 'document.documentElement.setAttribute("data-runs", "99")';
  findButton(editPanel, 'Save change').click();
  await flush();
  const choice = existing.document.getElementById('pivit-replay-choice');
  assert.ok(choice);
  let choiceText = '';
  walk(choice, (node) => { choiceText += node.textContent || ''; });
  assert.ok(choiceText.includes('Reloading goes back to the first step.'));
  findButton(choice, 'Reload the page').click();
  await flush();
  assert.strictEqual(existing.reloads.length, 1);
  assert.strictEqual(existing.document.documentElement.getAttribute('data-runs'), '1');
  const stored = JSON.parse(existing.sandbox.sessionStorage.getItem(`pivit_editor_changes_${expId}_${variantId}`));
  assert.deepStrictEqual(stored.changes[0], { type: 'page_css', value: 'body{margin:0}' });
  assert.deepStrictEqual(stored.changes[1], { type: 'page_js', value: 'document.documentElement.setAttribute("data-runs", "99")' });
  assert.deepStrictEqual(stored.changes[2], { selector: 'h1', type: 'html', value: '<span>Keep</span>' });

  console.log('page-editor.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
