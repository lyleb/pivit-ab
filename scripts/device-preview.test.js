// Device frames must run the variant the same way the live snippet does.
// The shell frames the preview URL with pivit_device removed, and without a
// sandbox, so CSS, HTML and JavaScript all run inside the frame. Switching
// device or refreshing replaces the frame, which loads the page again.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const preview = require('../snippet/device-preview.js');
const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const deviceSrc = fs.readFileSync(path.join(__dirname, '../snippet/device-preview.js'), 'utf8');

assert.deepStrictEqual(Object.keys(preview.DEVICES), ['desktop', 'tablet', 'mobile']);
assert.strictEqual(preview.DEVICES.mobile.width, 390);
assert.strictEqual(preview.DEVICES.tablet.width, 768);
assert.strictEqual(preview.DEVICES.desktop.width, 1280);
assert.strictEqual(preview.deviceName('Tablet'), 'tablet');
assert.strictEqual(preview.deviceName('tablet'), 'tablet');
assert.strictEqual(preview.deviceName('phone'), '');

const page = 'https://cantsaythat.co.uk/pricing?ab_preview=variant-1&ab_preview_token=signed&pivit_device=mobile&utm=1#offer';
const framed = new URL(preview.frameUrl(page));
assert.strictEqual(framed.searchParams.get('pivit_device'), null);
assert.strictEqual(framed.searchParams.get('ab_preview'), 'variant-1');
assert.strictEqual(framed.searchParams.get('ab_preview_token'), 'signed');
assert.strictEqual(framed.searchParams.get('utm'), '1');
assert.strictEqual(framed.hash, '#offer');
assert.strictEqual(preview.deviceFromHref(page), 'mobile');
assert.strictEqual(preview.deviceFromHref(preview.frameUrl(page)), '');

assert.ok(serverSrc.includes("app.use('/snippet/device-preview.js'"));
assert.ok(serverSrc.includes("res.set('Cache-Control', 'no-store')"));
assert.ok(snippetSrc.includes('snippet/device-preview.js?v='));
assert.ok(snippetSrc.includes('pivit-device-shell'));
assert.ok(editorSrc.includes("url.searchParams.set('pivit_device', device === 'tablet' || device === 'mobile' ? device : 'desktop')"));
assert.ok(adminSrc.includes('function devicePreviewUrl('));
assert.ok(adminSrc.includes("url.searchParams.set('pivit_device', 'desktop')"));
assert.ok(!deviceSrc.includes("setAttribute('sandbox'"));
assert.ok(!deviceSrc.includes('sandbox='));
assert.ok(deviceSrc.includes('pivitlab preview'));
assert.ok(deviceSrc.includes('whole-page CSS and JavaScript'));
assert.ok(snippetSrc.includes("change.type === 'page_css'"));
assert.ok(snippetSrc.includes("change.type === 'page_js'"));
assert.ok(editorSrc.includes('id = \'pivit-whole-page\''));
assert.ok(snippetSrc.includes('including page_css and page_js'));

function element() {
  const attrs = {};
  const listeners = {};
  const node = {
    children: [],
    style: {},
    parentElement: null,
    textContent: '',
    title: '',
    src: '',
    id: '',
    setAttribute(name, value) { attrs[name] = String(value); if (name === 'id') node.id = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { if (listeners.click) listeners.click(); },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      child.parentElement = null;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text || ''; },
    set(value) {
      node._text = String(value);
      node.children.splice(0, node.children.length);
    },
  });
  return node;
}

function mockDocument() {
  const ids = {};
  const doc = {
    documentElement: null,
    body: null,
    createElement() { return element(); },
    getElementById(id) { return ids[id] || null; },
  };
  const html = element();
  html.id = 'html';
  const body = element();
  body.id = 'body';
  html.appendChild(body);
  doc.documentElement = html;
  doc.body = body;
  const realCreate = doc.createElement;
  doc.createElement = (tag) => {
    const node = realCreate();
    node.tagName = tag;
    const originalSet = node.setAttribute;
    node.setAttribute = (name, value) => {
      originalSet(name, value);
      if (name === 'id') ids[value] = node;
    };
    return node;
  };
  return doc;
}

const href = 'https://cantsaythat.co.uk/pricing?ab_preview=variant-1&ab_preview_token=signed&pivit_device=mobile';
const doc = mockDocument();
const history = [];
const shellApi = preview.boot(doc, href, {
  history: { replaceState(_state, _title, next) { history.push(String(next)); } },
});
const shell = doc.getElementById('pivit-device-shell');
assert.ok(shell);
const frames = () => {
  const bezel = shell.children.find((node) => node.getAttribute && node.getAttribute('data-bezel'));
  // The bezel sits inside the stage, which is a child of the shell.
  const stage = shell.children.find((node) => node.children && node.children.some((child) => child.getAttribute && child.getAttribute('data-bezel')));
  const found = stage || bezel;
  const holder = stage
    ? stage.children.find((child) => child.getAttribute && child.getAttribute('data-bezel'))
    : bezel;
  return holder ? holder.children : [];
};
let shown = frames();
assert.strictEqual(shown.length, 1);
assert.strictEqual(shown[0].getAttribute('sandbox'), null);
assert.strictEqual(shown[0].title, 'Mobile preview');
assert.strictEqual(shown[0].style.width, '390px');
const firstSrc = new URL(shown[0].src);
assert.strictEqual(firstSrc.searchParams.get('pivit_device'), null);
assert.strictEqual(firstSrc.searchParams.get('ab_preview'), 'variant-1');

const tablet = shell.children[0].children.find((node) => node.getAttribute && node.getAttribute('data-device') === 'tablet');
tablet.click();
shown = frames();
assert.strictEqual(shown.length, 1);
assert.strictEqual(shown[0].style.width, '768px');
assert.strictEqual(shown[0].title, 'Tablet preview');
assert.strictEqual(new URL(shown[0].src).searchParams.get('pivit_device'), null);
assert.notStrictEqual(shown[0].getAttribute('data-pivit-frame'), '1');

const refresh = shell.children[0].children.find((node) => node.getAttribute && node.getAttribute('data-refresh'));
const beforeRefresh = shown[0].getAttribute('data-pivit-frame');
refresh.click();
shown = frames();
assert.strictEqual(shown.length, 1);
assert.strictEqual(shown[0].style.width, '768px');
assert.notStrictEqual(shown[0].getAttribute('data-pivit-frame'), beforeRefresh);
assert.strictEqual(new URL(shown[0].src).searchParams.get('ab_preview_token'), 'signed');
assert.ok(history.length >= 2);
assert.ok(history[history.length - 1].includes('pivit_device=tablet'));

assert.ok(shellApi && shellApi.shell === shell);

function snippetDocument(search) {
  const scripts = [];
  const head = {
    children: [],
    appendChild(child) { this.children.push(child); scripts.push(child); return child; },
  };
  const ids = {};
  function make(tag) {
    const attrs = {};
    const node = {
      tagName: tag,
      style: {},
      id: '',
      children: [],
      setAttribute(name, value) {
        attrs[name] = String(value);
        if (name === 'id') {
          node.id = String(value);
          ids[node.id] = node;
        }
      },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      appendChild(child) { node.children.push(child); return child; },
    };
    return node;
  }
  const html = make('html');
  html.classList = { remove() {} };
  const fetches = [];
  const sandbox = {
    document: {
      readyState: 'complete',
      currentScript: {
        getAttribute(name) { return name === 'data-api' ? 'https://pivit.example' : null; },
        src: 'https://pivit.example/snippet/ab.js',
      },
      documentElement: html,
      head,
      body: make('body'),
      createElement: make,
      getElementById(id) { return ids[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    window: { location: { href: 'https://cantsaythat.co.uk/pricing' + search, search } },
    localStorage: { getItem() { return null; }, setItem() {}, length: 0, key() { return null; } },
    navigator: { sendBeacon() { return true; } },
    fetch: async (target) => {
      fetches.push(String(target));
      return { ok: true, json: async () => ({ experiments: [], preview: null }) };
    },
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.window.document = sandbox.document;
  return { sandbox, fetches, head };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const mobile = snippetDocument('?ab_preview=variant-1&ab_preview_token=signed&pivit_device=mobile');
  vm.runInNewContext(snippetSrc, mobile.sandbox, { filename: 'ab.js' });
  await flush();
  assert.strictEqual(mobile.fetches.length, 0);
  const loader = mobile.head.children.find((node) => node.getAttribute && node.getAttribute('data-pivit-device-preview'));
  assert.ok(loader);
  assert.ok(loader.src.includes('/snippet/device-preview.js?v='));
  assert.strictEqual(loader.getAttribute('data-device'), 'mobile');
  assert.ok(mobile.sandbox.document.getElementById('pivit-device-shell'));

  const plain = snippetDocument('?ab_preview=variant-1&ab_preview_token=signed');
  vm.runInNewContext(snippetSrc, plain.sandbox, { filename: 'ab.js' });
  await flush();
  assert.ok(plain.fetches.some((target) => target.includes('/api/experiments')));
  assert.ok(!plain.head.children.some((node) => node.getAttribute && node.getAttribute('data-pivit-device-preview')));

  console.log('device-preview.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
