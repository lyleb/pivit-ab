// Browse and Select, the steps note, and applying an existing change without
// leaving the current screen.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  const reloads = [];
  const pushed = [];
  let href = opts.href || `https://site3-checkout.netlify.app/play?ab_edit=${variantId}&token=edit-token`;
  const script = {
    src: 'https://pivitlab.com/snippet/ab.js',
    getAttribute(name) {
      if (name === 'data-api') return 'https://pivitlab.com';
      if (name === 'data-variant-id') return variantId;
      if (name === 'data-spa') return opts.spa === undefined ? null : opts.spa;
      if (name === 'data-token') return 'edit-token';
      return null;
    },
  };
  function makeEl(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      style: {},
      parentElement: null,
      textContent: '',
      value: '',
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
      contains(other) {
        if (!other) return false;
        let nodeCursor = other;
        while (nodeCursor) {
          if (nodeCursor === node) return true;
          nodeCursor = nodeCursor.parentElement;
        }
        return false;
      },
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
        if (name === 'data-token') return 'edit-token';
        return null;
      },
    },
    documentElement,
    head,
    body,
    createElement: makeEl,
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById(id) { return ids[id] || null; },
    querySelector(selector) {
      if (String(selector).indexOf('ab.js') !== -1 || String(selector).indexOf('data-spa') !== -1) return script;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const history = {
    pushState(state, title, url) {
      href = new URL(url, href).href;
      pushed.push(href);
    },
    replaceState(state, title, url) {
      href = new URL(url, href).href;
      pushed.push(href);
    },
    state: null,
  };
  const sandbox = {
    document,
    window: {
      location: {
        get href() { return href; },
        get search() { return new URL(href).search; },
        get origin() { return new URL(href).origin; },
        reload() { reloads.push(1); },
      },
      history,
      innerWidth: 1280,
      innerHeight: 800,
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    fetch: async (target, request) => {
      fetches.push({ url: String(target), opts: request || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: variantId,
          experiment_id: expId,
          experiment_name: 'Checkout',
          name: 'Offer',
          experiment_status: 'draft',
          experiment_status_label: 'Draft',
          edit_warning: '',
          changes: opts.changes || [],
          goals: [],
          goals_scope: 'shared',
          steps_note: opts.stepsNote || '',
        }),
      };
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    Date,
  };
  sandbox.window.document = document;
  return { sandbox, document, fetches, reloads, pushed, href: () => href, history };
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
  const page = harness({
    changes: [{
      type: 'page_js',
      value: 'document.documentElement.setAttribute("data-runs", String(Number(document.documentElement.getAttribute("data-runs") || 0) + 1))',
    }],
    stepsNote: 'Click Continue twice',
  });
  vm.runInNewContext(editorSrc, page.sandbox, { filename: 'editor.js' });
  await flush();

  const browse = page.document.getElementById('pivit-browse-btn');
  const select = page.document.getElementById('pivit-pick-btn');
  const status = page.document.getElementById('pivit-mode-status');
  assert.strictEqual(browse.textContent, 'Browse');
  assert.strictEqual(select.textContent, 'Select');
  assert.strictEqual(browse.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(select.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(status.textContent, 'Browse is on. Clicks go to the site.');

  select.click();
  assert.strictEqual(select.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(browse.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(status.textContent, 'Select is on. Click an element to pick it.');
  browse.click();
  assert.strictEqual(status.textContent, 'Browse is on. Clicks go to the site.');

  const note = page.document.getElementById('pivit-steps-note-input');
  assert.strictEqual(note.value, 'Click Continue twice');
  note.value = 'Click Continue twice, then pay';
  note.listeners.input();

  // The checkout calls replaceState('/play') and would drop the editor.
  page.history.replaceState({ step: 'step-basket' }, '', '/play');
  const kept = new URL(page.href());
  assert.strictEqual(kept.pathname, '/play');
  assert.strictEqual(kept.searchParams.get('ab_edit'), variantId);
  assert.strictEqual(kept.searchParams.get('token'), 'edit-token');
  page.history.pushState({ step: 'step-payment' }, '', '/play?mode=hash#step-payment');
  const stepped = new URL(page.href());
  assert.strictEqual(stepped.hash, '#step-payment');
  assert.strictEqual(stepped.searchParams.get('ab_edit'), variantId);
  assert.strictEqual(stepped.searchParams.get('token'), 'edit-token');
  assert.strictEqual(stepped.searchParams.get('mode'), 'hash');

  page.document.getElementById('pivit-whole-page').click();
  await flush();
  const panel = page.document.getElementById('pivit-whole-page-panel');
  const areas = fields(panel);
  areas[1].value = 'document.documentElement.setAttribute("data-runs", "9")';
  findButton(panel, 'Save change').click();
  await flush();
  const choice = page.document.getElementById('pivit-replay-choice');
  assert.ok(choice);
  let choiceText = '';
  walk(choice, (node) => { choiceText += node.textContent || ''; });
  assert.ok(choiceText.includes('Apply without reloading runs the change list again on this screen'));
  assert.ok(choiceText.includes('Reloading goes back to the first step.'));
  findButton(choice, 'Apply without reloading').click();
  await flush();
  assert.strictEqual(page.reloads.length, 0);
  assert.strictEqual(page.document.documentElement.getAttribute('data-runs'), '9');
  assert.strictEqual(new URL(page.href()).hash, '#step-payment');

  // A second edit of the same change still does not reload.
  page.document.getElementById('pivit-whole-page').click();
  await flush();
  const again = page.document.getElementById('pivit-whole-page-panel');
  fields(again)[1].value = 'document.documentElement.setAttribute("data-runs", "3")';
  findButton(again, 'Save change').click();
  await flush();
  findButton(page.document.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  assert.strictEqual(page.reloads.length, 0);
  assert.strictEqual(page.document.documentElement.getAttribute('data-runs'), '3');
  assert.strictEqual(new URL(page.href()).hash, '#step-payment');

  findButton(page.document.body, '💾 Save').click();
  await flush();
  const patch = page.fetches.filter((call) => call.opts.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  const saved = JSON.parse(patch[0].opts.body);
  assert.strictEqual(saved.steps_note, 'Click Continue twice, then pay');
  assert.strictEqual(saved.changes[0].type, 'page_js');
  assert.ok(saved.changes[0].value.includes('"3"'));

  const classic = harness({
    spa: 'off',
    changes: [{ type: 'page_js', value: 'document.documentElement.setAttribute("data-runs", "1")' }],
  });
  vm.runInNewContext(editorSrc, classic.sandbox, { filename: 'editor.js' });
  await flush();
  classic.document.getElementById('pivit-whole-page').click();
  await flush();
  const classicPanel = classic.document.getElementById('pivit-whole-page-panel');
  fields(classicPanel)[1].value = 'document.documentElement.setAttribute("data-runs", "2")';
  findButton(classicPanel, 'Save change').click();
  await flush();
  assert.strictEqual(classic.document.getElementById('pivit-replay-choice'), null);
  assert.strictEqual(classic.reloads.length, 1);

  console.log('editor-spa.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
