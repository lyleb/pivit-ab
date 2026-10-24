// Insert banner stores one banner change and the snippet paints a single bar.
// The sale banner is text plus a UK-midnight countdown, with no custom code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../snippet/ab.js');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const variantId = '11111111-1111-4111-8111-111111111111';
const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const elementChanges = [
  { selector: '#cta', type: 'html', value: '<b>Buy</b>' },
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
      checked: false,
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
      PivitRuntime: runtime,
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

function textOf(node) {
  let text = '';
  walk(node, (child) => { text += child.textContent || ''; });
  return text;
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  assert.ok(editorSrc.includes('Insert banner'));
  assert.ok(editorSrc.includes('UK midnight daily'));
  assert.ok(editorSrc.includes('Background colour'));
  assert.ok(editorSrc.includes('Text colour'));
  assert.ok(editorSrc.includes("type: 'banner'"));
  assert.ok(editorSrc.includes('Europe/London'));
  assert.ok(!editorSrc.includes('Background color'));
  assert.ok(!editorSrc.includes('Text color'));

  const fresh = harness(elementChanges.slice());
  vm.runInNewContext(editorSrc, fresh.sandbox, { filename: 'editor.js' });
  await flush();

  const insert = fresh.document.getElementById('pivit-insert-banner');
  assert.ok(insert);
  assert.strictEqual(insert.textContent, 'Insert banner');
  insert.click();
  await flush();

  const panel = fresh.document.getElementById('pivit-banner-panel');
  assert.ok(panel);
  const copy = textOf(panel);
  assert.ok(copy.includes('Insert banner'));
  assert.ok(copy.includes('UK midnight daily'));
  assert.ok(copy.includes('Background colour'));
  assert.ok(copy.includes('Text colour'));
  assert.ok(copy.includes('Sticky'));
  assert.ok(copy.includes('Sale ends in'));
  assert.ok(copy.indexOf('Pivit') === -1);

  findButton(panel, 'Apply').click();
  await flush();
  assert.strictEqual(fresh.document.getElementById('pivit-banner-error').textContent, 'Enter the banner text.');
  assert.strictEqual(fresh.document.getElementById('pivit-banner-panel') != null, true);

  fresh.document.getElementById('pivit-banner-text').value = 'Sale ends in';
  fresh.document.getElementById('pivit-banner-countdown').value = 'midnight';
  fresh.document.getElementById('pivit-banner-background').value = '#5635FB';
  fresh.document.getElementById('pivit-banner-color').value = '#ffffff';
  fresh.document.getElementById('pivit-banner-position').value = 'top';
  fresh.document.getElementById('pivit-banner-sticky').checked = true;
  fresh.document.getElementById('pivit-banner-href').value = 'https://cantsaythat.co.uk/sale';
  findButton(panel, 'Apply').click();
  await flush();

  assert.strictEqual(fresh.document.getElementById('pivit-banner-panel'), null);
  assert.strictEqual(fresh.reloads.length, 0);
  const bar = fresh.document.getElementById('pivit-banner');
  assert.ok(bar);
  assert.strictEqual(bar.getAttribute('data-pivit-banner'), '');
  assert.ok(textOf(bar).indexOf('Sale ends in') === 0);
  assert.strictEqual(fresh.document.documentElement.style.paddingTop, '48px');
  const css = fresh.document.getElementById('pivit-banner-css');
  assert.ok(css);
  assert.ok(css.textContent.indexOf('@media (max-width:640px)') !== -1);
  assert.ok(css.textContent.indexOf('position:fixed') !== -1);
  assert.strictEqual(fresh.document.getElementById('pivit-insert-banner').textContent, 'Edit banner');

  // A second apply from the editor updates the same bar.
  fresh.document.getElementById('pivit-insert-banner').click();
  await flush();
  const again = fresh.document.getElementById('pivit-banner-panel');
  assert.strictEqual(fresh.document.getElementById('pivit-banner-text').value, 'Sale ends in');
  assert.strictEqual(fresh.document.getElementById('pivit-banner-countdown').value, 'midnight');
  fresh.document.getElementById('pivit-banner-href').value = 'javascript:alert(1)';
  findButton(again, 'Save change').click();
  await flush();
  assert.strictEqual(
    fresh.document.getElementById('pivit-banner-error').textContent,
    'Use a full https:// link, or a path starting with /.'
  );
  fresh.document.getElementById('pivit-banner-href').value = 'https://cantsaythat.co.uk/sale';
  findButton(again, 'Cancel').click();
  await flush();

  const save = findButton(fresh.document.body, '💾 Save');
  save.click();
  await flush();
  const patch = fresh.fetches.filter((call) => call.opts.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  const saved = JSON.parse(patch[0].opts.body);
  assert.deepStrictEqual(saved.changes.slice(0, 2), elementChanges);
  assert.deepStrictEqual(saved.changes[2], {
    type: 'banner',
    text: 'Sale ends in',
    countdown: 'midnight',
    background: '#5635fb',
    color: '#ffffff',
    position: 'top',
    sticky: true,
    href: 'https://cantsaythat.co.uk/sale',
  });
  assert.strictEqual(fresh.ids['pivit-banner'], bar);

  const existing = harness([{
    type: 'banner',
    text: 'Sale ends in',
    countdown: 'fixed',
    end: '2026-12-01T18:00:00.000Z',
    background: '#131723',
    color: '#ffffff',
    position: 'bottom',
    sticky: false,
  }]);
  vm.runInNewContext(editorSrc, existing.sandbox, { filename: 'editor.js' });
  await flush();
  assert.ok(existing.document.getElementById('pivit-banner'));
  assert.strictEqual(existing.document.documentElement.style.paddingBottom, '48px');
  assert.strictEqual(existing.document.getElementById('pivit-insert-banner').textContent, 'Edit banner');
  existing.document.getElementById('pivit-insert-banner').click();
  await flush();
  assert.strictEqual(existing.document.getElementById('pivit-banner-countdown').value, 'fixed');
  assert.strictEqual(existing.document.getElementById('pivit-banner-position').value, 'bottom');
  assert.strictEqual(existing.document.getElementById('pivit-banner-sticky').checked, false);
  const endInput = existing.document.getElementById('pivit-banner-end');
  const endDate = new Date('2026-12-01T18:00:00.000Z');
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const localEnd = endDate.getFullYear() + '-' + pad(endDate.getMonth() + 1) + '-' + pad(endDate.getDate())
    + 'T' + pad(endDate.getHours()) + ':' + pad(endDate.getMinutes());
  assert.strictEqual(endInput.value, localEnd);
  existing.document.getElementById('pivit-banner-text').value = 'Offer ends in';
  existing.document.getElementById('pivit-banner-end').value = '2026-12-01T18:30';
  findButton(existing.document.getElementById('pivit-banner-panel'), 'Save change').click();
  await flush();
  const choice = existing.document.getElementById('pivit-replay-choice');
  assert.ok(choice);
  findButton(choice, 'Reload the page').click();
  await flush();
  assert.strictEqual(existing.reloads.length, 1);
  const stored = JSON.parse(existing.sandbox.sessionStorage.getItem(`pivit_editor_changes_${expId}_${variantId}`));
  assert.strictEqual(stored.changes.length, 1);
  assert.strictEqual(stored.changes[0].type, 'banner');
  assert.strictEqual(stored.changes[0].text, 'Offer ends in');
  assert.strictEqual(stored.changes[0].countdown, 'fixed');
  assert.strictEqual(stored.changes[0].position, 'bottom');
  assert.strictEqual(stored.changes[0].sticky, false);
  assert.strictEqual(new Date(stored.changes[0].end).getTime(), new Date('2026-12-01T18:30').getTime());
  assert.strictEqual(existing.document.getElementById('pivit-banner') != null, true);

  console.log('banner.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
