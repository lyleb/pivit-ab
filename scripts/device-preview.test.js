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
assert.ok(snippetSrc.includes('including page_css, page_js and banner'));
assert.ok(snippetSrc.includes("change.type === 'banner'"));
assert.ok(editorSrc.includes('id = \'pivit-insert-banner\''));
assert.ok(editorSrc.includes('UK midnight daily'));
assert.ok(deviceSrc.includes('including a banner and whole-page CSS and JavaScript'));

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
    addEventListener(type, fn) {
      listeners[type] = fn;
      if (!node._listeners) node._listeners = {};
      if (!node._listeners[type]) node._listeners[type] = [];
      node._listeners[type].push(fn);
    },
    dispatchEvent(event) {
      const list = (node._listeners && node._listeners[event.type]) || [];
      list.forEach((fn) => fn(event));
    },
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

const csp = 'frame-ancestors *.builder-preview.com *.hostinger.com';
assert.strictEqual(preview.framingBlockedByHeaders({
  csp,
  xfo: '',
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), true);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: "default-src 'self'; frame-ancestors 'self'",
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), false);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: "frame-ancestors 'self'",
  ancestorOrigin: 'https://pivitlab.com',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), true);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: 'frame-ancestors *',
  xfo: 'DENY',
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), false);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: '',
  xfo: 'DENY',
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), true);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: '',
  xfo: 'SAMEORIGIN',
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), false);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: '',
  xfo: 'SAMEORIGIN',
  ancestorOrigin: 'https://pivitlab.com',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), true);
assert.strictEqual(preview.framingBlockedByHeaders({
  csp: "frame-ancestors 'none'",
  ancestorOrigin: 'https://cantsaythat.co.uk',
  resourceOrigin: 'https://cantsaythat.co.uk',
}), true);
assert.deepStrictEqual(preview.popupOptions('tablet'), {
  device: 'tablet',
  target: 'pivitlab-preview',
  features: 'popup,width=820,height=1180',
  width: 820,
  height: 1180,
});
assert.deepStrictEqual(preview.popupOptions('mobile'), {
  device: 'mobile',
  target: 'pivitlab-preview',
  features: 'popup,width=390,height=844',
  width: 390,
  height: 844,
});
assert.strictEqual(preview.popupOptions('desktop').features, '');
assert.strictEqual(preview.popupOptions('desktop').target, '_blank');
assert.strictEqual(preview.popupLabel('desktop'), 'Open in a tab');
assert.strictEqual(preview.popupLabel('tablet'), 'Open tablet window');
assert.strictEqual(preview.popupLabel('mobile'), 'Open mobile window');
assert.strictEqual(preview.BLOCKED_MESSAGE, "This site doesn't allow previews inside another page, so we'll open it in its own window.");
assert.ok(deviceSrc.includes(preview.BLOCKED_MESSAGE));
assert.ok(deviceSrc.includes('win.resizeTo(choice.width, choice.height)'));
assert.ok(deviceSrc.includes('Open the preview in a tab'));
assert.ok(!deviceSrc.includes('This page cannot be shown in a frame'));

function findAttr(node, attr, value) {
  if (!node) return null;
  if (node.getAttribute && node.getAttribute(attr) === value) return node;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    const found = findAttr(kids[i], attr, value);
    if (found) return found;
  }
  return null;
}

function bezelOf(shellNode) {
  const stage = shellNode.children.find((node) => node.children && node.children.some((child) => child.getAttribute && child.getAttribute('data-bezel')));
  return stage.children.find((child) => child.getAttribute && child.getAttribute('data-bezel'));
}

function dispatchLoad(frame, docState) {
  if (docState === 'shown') {
    frame.contentDocument = { documentElement: {}, URL: frame.src };
  } else if (docState === 'blank') {
    frame.contentDocument = { documentElement: {}, URL: 'about:blank' };
  } else {
    frame.contentDocument = null;
  }
  frame.dispatchEvent({ type: 'load' });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const opened = [];
  const fetches = [];
  const timers = [];
  const blockedDoc = mockDocument();
  const blockedHref = 'https://cantsaythat.co.uk/pricing?ab_preview=variant-1&ab_preview_token=signed&pivit_device=mobile&utm=1#offer';
  preview.boot(blockedDoc, blockedHref, {
    history: { replaceState() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    headersFor(url) {
      fetches.push(String(url));
      return {
        csp,
        xfo: '',
        resourceOrigin: 'https://cantsaythat.co.uk',
      };
    },
    open(url, target, features) {
      opened.push({ url, target, features });
      return { opener: {} };
    },
  });
  const blockedShell = blockedDoc.getElementById('pivit-device-shell');
  const blockedBezel = bezelOf(blockedShell);
  const blockedFrame = blockedBezel.children[0];
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, preview.LOAD_TIMEOUT_MS);
  assert.strictEqual(new URL(blockedFrame.src).searchParams.get('pivit_device'), null);
  assert.strictEqual(new URL(blockedFrame.src).searchParams.get('ab_preview'), 'variant-1');
  assert.strictEqual(new URL(blockedFrame.src).searchParams.get('ab_preview_token'), 'signed');
  assert.strictEqual(new URL(blockedFrame.src).hash, '#offer');
  dispatchLoad(blockedFrame, 'opaque');
  await settle();
  const fail = findAttr(blockedBezel, 'data-frame-fallback', '1');
  assert.ok(fail);
  const fallbackMessage = findAttr(fail, 'data-fallback-message', '1');
  assert.strictEqual(fallbackMessage.textContent, preview.BLOCKED_MESSAGE);
  assert.strictEqual(blockedFrame.style.display, 'none');
  const anchor = (function walk(node) {
    if (node && node.textContent === 'Open the preview in a tab' && node.href) return node;
    const kids = (node && node.children) || [];
    for (let i = 0; i < kids.length; i++) {
      const found = walk(kids[i]);
      if (found) return found;
    }
    return null;
  })(fail);
  assert.ok(anchor);
  assert.strictEqual(anchor.href, blockedFrame.src);
  assert.strictEqual(anchor.target, '_blank');
  assert.strictEqual(anchor.rel, 'noopener');
  const mobileOpen = findAttr(fail, 'data-open-window', 'mobile');
  const tabletOpen = findAttr(fail, 'data-open-window', 'tablet');
  const desktopOpen = findAttr(fail, 'data-open-window', 'desktop');
  assert.strictEqual(mobileOpen.getAttribute('data-popup-features'), 'popup,width=390,height=844');
  assert.strictEqual(tabletOpen.getAttribute('data-popup-features'), 'popup,width=820,height=1180');
  assert.strictEqual(desktopOpen.getAttribute('data-popup-features'), null);
  mobileOpen.click();
  tabletOpen.click();
  desktopOpen.click();
  assert.strictEqual(opened.length, 3);
  assert.strictEqual(opened[0].url, blockedFrame.src);
  assert.strictEqual(opened[0].target, 'pivitlab-preview');
  assert.strictEqual(opened[0].features, 'popup,width=390,height=844');
  assert.strictEqual(opened[1].features, 'popup,width=820,height=1180');
  assert.strictEqual(opened[2].target, '_blank');
  assert.strictEqual(opened[2].features, undefined);
  assert.ok(fetches.length >= 1);
  assert.ok(!fetches[0].includes('pivit_device'));

  timers[0].fn();
  assert.strictEqual(findAttr(blockedBezel, 'data-frame-fallback', '1'), fail);

  const allowedDoc = mockDocument();
  let allowedFetches = 0;
  preview.boot(allowedDoc, 'https://shop.example/pricing?ab_preview=variant-1&pivit_device=desktop', {
    history: { replaceState() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    headersFor() { allowedFetches += 1; return { csp: '', xfo: '', resourceOrigin: 'https://shop.example' }; },
    fetch() { allowedFetches += 1; throw new Error('fetch should not run for a readable frame'); },
  });
  const allowedFrame = bezelOf(allowedDoc.getElementById('pivit-device-shell')).children[0];
  dispatchLoad(allowedFrame, 'shown');
  await settle();
  assert.strictEqual(findAttr(allowedFrame.parentElement, 'data-frame-fallback', '1'), null);
  assert.notStrictEqual(allowedFrame.style.display, 'none');
  assert.strictEqual(allowedFetches, 0);

  const redirected = mockDocument();
  preview.boot(redirected, 'https://shop.example/go?ab_preview=variant-1&pivit_device=tablet', {
    history: { replaceState() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    headersFor() {
      return { csp: '', xfo: '', resourceOrigin: 'https://checkout.example' };
    },
  });
  const redirectedFrame = bezelOf(redirected.getElementById('pivit-device-shell')).children[0];
  dispatchLoad(redirectedFrame, 'opaque');
  await settle();
  assert.strictEqual(findAttr(redirectedFrame.parentElement, 'data-frame-fallback', '1'), null);
  assert.strictEqual(redirectedFrame.style.display, 'block');

  const reported = mockDocument();
  let reportedHeaders = 0;
  preview.boot(reported, 'https://cantsaythat.co.uk/?pivit_device=desktop', {
    history: { replaceState() {} },
    setTimeout(fn) { return { fn }; },
    clearTimeout() {},
    headersFor() { reportedHeaders += 1; return null; },
  });
  const reportedFrame = bezelOf(reported.getElementById('pivit-device-shell')).children[0];
  reportedFrame.dispatchEvent({
    type: 'securitypolicyviolation',
    effectiveDirective: 'frame-ancestors',
    violatedDirective: 'frame-ancestors',
    blockedURI: reportedFrame.src,
  });
  await settle();
  assert.ok(findAttr(reportedFrame.parentElement, 'data-frame-fallback', '1'));
  assert.strictEqual(reportedHeaders, 0);
  reportedFrame.dispatchEvent({
    type: 'securitypolicyviolation',
    effectiveDirective: 'script-src',
    violatedDirective: 'script-src',
    blockedURI: 'https://example.com/app.js',
  });

  const timed = mockDocument();
  const timedTimers = [];
  preview.boot(timed, 'https://slow.example/?ab_preview=variant-1&pivit_device=mobile', {
    history: { replaceState() {} },
    setTimeout(fn, ms) { timedTimers.push({ fn, ms }); return timedTimers.length; },
    clearTimeout(id) { if (timedTimers[id - 1]) timedTimers[id - 1].cleared = true; },
    headersFor() { return { csp: '', xfo: '', resourceOrigin: 'https://slow.example' }; },
  });
  const timedFrame = bezelOf(timed.getElementById('pivit-device-shell')).children[0];
  assert.strictEqual(findAttr(timedFrame.parentElement, 'data-frame-fallback', '1'), null);
  timedTimers[0].fn();
  assert.ok(findAttr(timedFrame.parentElement, 'data-frame-fallback', '1'));
  dispatchLoad(timedFrame, 'shown');
  await settle();
  assert.strictEqual(findAttr(timedFrame.parentElement, 'data-frame-fallback', '1'), null);
  assert.strictEqual(timedFrame.style.display, 'block');

  const responseHeaders = preview.headersFromResponse({
    type: 'basic',
    url: 'https://cantsaythat.co.uk/pricing',
    headers: { get(name) { return name === 'content-security-policy' ? csp : ''; } },
  }, 'https://cantsaythat.co.uk/pricing');
  assert.strictEqual(responseHeaders.csp, csp);
  assert.strictEqual(responseHeaders.resourceOrigin, 'https://cantsaythat.co.uk');
  assert.strictEqual(preview.headersFromResponse({ type: 'opaque', headers: { get() { return csp; } } }, 'https://cantsaythat.co.uk/'), null);

  console.log('device-preview fallback checks ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
