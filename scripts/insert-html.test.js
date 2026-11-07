// Insert HTML is one block. Editing it, applying it again, and a late render
// replace that block. Remove and Undo drop it. The dashboard logo links home.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../snippet/ab.js');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const variantId = '11111111-1111-4111-8111-111111111111';
const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const selector = 'div.product-list__content';

assert.ok(admin.includes('id="brand-home"'));
assert.ok(admin.includes('class="brand-home"'));
assert.ok(admin.includes('href="#home"'));
assert.ok(admin.includes('data-go="#home"'));
assert.ok(admin.includes('aria-label="pivitlab home"'));
assert.ok(admin.includes('<span class="brand-logo" role="img" aria-label="pivitlab" aria-hidden="true"></span>'));
assert.ok(admin.indexOf('aria-label="pivitlab home"') < admin.indexOf('class="brand-logo"'));
assert.ok(admin.includes('a.brand-home:focus-visible'));
assert.ok(!admin.includes('Pivitlab'));

function matchCompound(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  const nth = compound.match(/:nth-of-type\((\d+)\)/);
  const base = compound.replace(/:nth-of-type\(\d+\)/g, '');
  if (nth) {
    const parent = node.parentElement;
    if (!parent) return false;
    const same = parent.children.filter((child) => child.tagName === node.tagName);
    if (same.indexOf(node) + 1 !== Number(nth[1])) return false;
  }
  if (!base) return true;
  if (base.charAt(0) === '#') return node.id === base.slice(1);
  const match = base.match(/^([a-zA-Z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/);
  if (!match) return false;
  if (match[1] && String(node.tagName || '').toLowerCase() !== match[1]) return false;
  if (match[2]) {
    const want = match[2].slice(1).split('.');
    const have = String(node.className || '').split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function matchSelector(node, selectorText) {
  if (!node || node.nodeType !== 1) return false;
  const selectorValue = String(selectorText || '').trim();
  if (!selectorValue || selectorValue.indexOf(',') !== -1 || selectorValue.indexOf('[') !== -1) return false;
  if (selectorValue.indexOf('>') !== -1) {
    const parts = selectorValue.split(/\s*>\s*/);
    let current = node;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!current || !matchCompound(current, parts[i])) return false;
      current = current.parentElement;
    }
    return true;
  }
  const parts = selectorValue.split(/\s+/);
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (ancestor && !matchCompound(ancestor, parts[i])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function createDocument() {
  const registry = [];
  const ids = {};
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.dead = false; }
    observe() { registry.push(this); }
    disconnect() { this.dead = true; }
    takeRecords() { return []; }
  }
  function notify(nodes) {
    const added = (nodes || []).filter((node) => node && node.nodeType === 1);
    if (!added.length) return;
    const record = { addedNodes: added, type: 'childList' };
    registry.slice().forEach((observer) => { if (!observer.dead) observer.cb([record]); });
  }
  function textNode(text) {
    const node = {
      nodeType: 3,
      textContent: String(text),
      parentElement: null,
      parentNode: null,
      isConnected: false,
      children: [],
    };
    node.remove = () => {
      const parent = node.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
      node.parentElement = null;
      node.parentNode = null;
      node.isConnected = false;
    };
    return node;
  }
  function parseHTML(html) {
    const source = String(html || '');
    const nodes = [];
    const re = /<([a-z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let last = 0;
    let found;
    while ((found = re.exec(source))) {
      if (found.index > last) {
        const between = source.slice(last, found.index);
        if (between) nodes.push(textNode(between));
      }
      const node = createEl(found[1]);
      const cls = /class="([^"]*)"/.exec(found[2]);
      if (cls) node.className = cls[1];
      node.textContent = found[3].replace(/<[^>]+>/g, '').trim();
      node.innerHTML = found[3];
      nodes.push(node);
      last = re.lastIndex;
    }
    if (!nodes.length && source) nodes.push(textNode(source));
    else if (last < source.length && source.slice(last)) nodes.push(textNode(source.slice(last)));
    return nodes;
  }
  function createEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      children: [],
      parentElement: null,
      parentNode: null,
      attributes: {},
      textContent: '',
      value: '',
      checked: false,
      isConnected: false,
      _innerHTML: '',
    };
    const style = {};
    style.setProperty = (prop, val) => { style[prop] = val; };
    style.removeProperty = (prop) => { delete style[prop]; };
    el.style = style;
    Object.defineProperty(el, 'nextSibling', { get() {
      if (!el.parentElement) return null;
      const index = el.parentElement.children.indexOf(el);
      return el.parentElement.children[index + 1] || null;
    } });
    Object.defineProperty(el, 'previousSibling', { get() {
      if (!el.parentElement) return null;
      const index = el.parentElement.children.indexOf(el);
      return index > 0 ? el.parentElement.children[index - 1] : null;
    } });
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML; },
      set(value) {
        el._innerHTML = value == null ? '' : String(value);
        if (!el._innerHTML) {
          while (el.children.length) {
            const child = el.children.pop();
            if (!child) continue;
            child.parentElement = null;
            child.parentNode = null;
            child.isConnected = false;
          }
        }
      },
    });
    el.setAttribute = (name, value) => {
      el.attributes[name] = String(value);
      if (name === 'id') el.id = String(value);
      if (name === 'class') el.className = String(value);
    };
    el.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null);
    el.removeAttribute = (name) => {
      delete el.attributes[name];
      if (name === 'id') el.id = '';
      if (name === 'class') el.className = '';
    };
    el.matches = (sel) => matchSelector(el, sel);
    el.querySelectorAll = (sel) => walk(el, false).filter((node) => matchSelector(node, sel));
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    el.contains = (other) => {
      let cursor = other;
      while (cursor) {
        if (cursor === el) return true;
        cursor = cursor.parentElement;
      }
      return false;
    };
    el.addEventListener = (type, fn) => {
      el.listeners = el.listeners || {};
      el.listeners[type] = el.listeners[type] || [];
      el.listeners[type].push(fn);
    };
    el.click = () => {
      (el.listeners && el.listeners.click || []).forEach((fn) => fn({ target: el, preventDefault() {}, stopPropagation() {} }));
    };
    el.focus = () => {};
    el.remove = () => {
      if (el.id && ids[el.id] === el) delete ids[el.id];
      const parent = el.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(el);
      if (index >= 0) parent.children.splice(index, 1);
      el.parentElement = null;
      el.parentNode = null;
      el.isConnected = false;
    };
    el.appendChild = (child) => {
      if (child.parentElement) child.remove();
      child.parentElement = el;
      child.parentNode = el;
      child.isConnected = true;
      el.children.push(child);
      notify([child]);
      return child;
    };
    el.insertAdjacentElement = (position, child) => {
      if (position !== 'afterend' && position !== 'beforebegin') throw new Error('unsupported position ' + position);
      const parent = el.parentElement;
      if (child.parentElement) child.remove();
      child.parentElement = parent;
      child.parentNode = parent;
      child.isConnected = true;
      const index = parent.children.indexOf(el) + (position === 'afterend' ? 1 : 0);
      parent.children.splice(index, 0, child);
      notify([child]);
      return child;
    };
    el.insertAdjacentHTML = (position, html) => {
      const nodes = parseHTML(html);
      const parent = el.parentElement;
      let index = parent.children.indexOf(el);
      if (position === 'afterend') index += 1;
      nodes.forEach((node, offset) => {
        node.parentElement = parent;
        node.parentNode = parent;
        node.isConnected = true;
        parent.children.splice(index + offset, 0, node);
      });
      notify(nodes);
    };
    let id = '';
    Object.defineProperty(el, 'id', {
      configurable: true,
      get() { return id; },
      set(value) {
        if (id && ids[id] === el) delete ids[id];
        id = value || '';
        el.attributes.id = id;
        if (id) ids[id] = el;
      },
    });
    return el;
  }
  function walk(root, includeSelf) {
    const out = [];
    function rec(node) {
      (node.children || []).forEach((child) => {
        if (child.nodeType === 1) out.push(child);
        rec(child);
      });
    }
    if (includeSelf && root && root.nodeType === 1) out.push(root);
    if (root) rec(root);
    return out;
  }
  const doc = {
    nodeType: 9,
    readyState: 'complete',
    createElement(tag) { return createEl(tag); },
    createTextNode(text) { return textNode(text); },
    getElementById(id) {
      if (ids[id]) return ids[id];
      return walk(doc.documentElement, true).find((node) => node.id === id) || null;
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      try {
        return walk(doc.documentElement, true).filter((node) => matchSelector(node, sel));
      } catch (err) {
        return [];
      }
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.MutationObserver = MutationObserver;
  doc.notify = notify;
  return doc;
}

function applierFor(doc, extra) {
  return runtime.createApplier(doc, Object.assign({
    schedule: (fn) => fn(),
    MutationObserver: doc.MutationObserver,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, extra || {}));
}

function addContent(doc) {
  const el = doc.createElement('div');
  el.className = 'product-list__content';
  doc.body.appendChild(el);
  return el;
}

function headings(doc) {
  return doc.querySelectorAll('h2');
}

function textBefore(el) {
  const out = [];
  let node = el.previousSibling;
  while (node) {
    if (node.nodeType === 3) out.push(node);
    node = node.previousSibling;
  }
  return out;
}

const above = { selector: selector, type: 'insert_before', value: '<h2>Small batches...</h2>' };
const below = { selector: selector, type: 'insert_after', value: '<h2>Below the grid</h2>' };

// One insert, applied again, stays one. Editing the HTML replaces it.
{
  const doc = createDocument();
  const target = addContent(doc);
  const applier = applierFor(doc);
  const change = Object.assign({}, above);
  applier.applyAll([change], 'edit');
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(headings(doc)[0].textContent, 'Small batches...');
  assert.strictEqual(headings(doc)[0].getAttribute('data-pivit-insert'), 'edit:0');
  assert.strictEqual(target.previousSibling, headings(doc)[0]);
  const first = headings(doc)[0];
  applier.applyAll([change], 'edit');
  doc.notify([target]);
  doc.notify([first]);
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(headings(doc)[0], first);
  change.value = '<h2>Smaller batches...</h2>';
  applier.applyAll([change], 'edit');
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(headings(doc)[0].textContent, 'Smaller batches...');
  assert.notStrictEqual(headings(doc)[0], first);
}

// A new applier with the same HTML does not add a second heading. A different
// experiment with different HTML still gets its own heading.
{
  const doc = createDocument();
  addContent(doc);
  applierFor(doc).applyAll([above], 'variant-a');
  applierFor(doc).applyAll([above], 'variant-b');
  assert.strictEqual(headings(doc).length, 1);
  const other = createDocument();
  addContent(other);
  applierFor(other).applyAll([above], 'variant-a');
  applierFor(other).applyAll([{ selector: selector, type: 'insert_before', value: '<h2>Two</h2>' }], 'variant-b');
  const texts = headings(other).map((node) => node.textContent).sort();
  assert.deepStrictEqual(texts, ['Small batches...', 'Two']);
}

// Above and below are different changes. Applying both twice keeps one of each.
// Two anchors get one heading each.
{
  const doc = createDocument();
  addContent(doc);
  const applier = applierFor(doc);
  const changes = [above, below];
  applier.applyAll(changes, 'both');
  applier.applyAll(changes, 'both');
  assert.strictEqual(headings(doc).length, 2);
  const pair = createDocument();
  addContent(pair);
  addContent(pair);
  const many = applierFor(pair);
  many.applyAll([above], 'pair');
  many.applyAll([above], 'pair');
  assert.strictEqual(headings(pair).length, 2);
}

// Plain text is inserted once, including when the same change is applied again.
{
  const doc = createDocument();
  const target = addContent(doc);
  const change = { selector: selector, type: 'insert_before', value: 'Small batches...' };
  const applier = applierFor(doc);
  applier.applyAll([change], 'text');
  applier.applyAll([change], 'text');
  const notes = textBefore(target).filter((node) => node.textContent.indexOf('Small batches') !== -1);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].textContent, 'Small batches...');
}

// Inserted markup that matches the anchor is not inserted again inside itself.
{
  const doc = createDocument();
  addContent(doc);
  const applier = applierFor(doc);
  applier.applyAll([{
    selector: selector,
    type: 'insert_before',
    value: '<div class="product-list__content">Inside</div>',
  }], 'nest');
  doc.notify(doc.querySelectorAll(selector));
  assert.strictEqual(doc.querySelectorAll(selector).length, 2);
}

// The anchor is replaced after the insert. The old block goes and one new
// block is added. Re-watching a late element inserts once.
{
  const doc = createDocument();
  const target = addContent(doc);
  const applier = applierFor(doc);
  applier.applyAll([above], 'live');
  assert.strictEqual(headings(doc).length, 1);
  target.remove();
  const fresh = addContent(doc);
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(fresh.previousSibling, headings(doc)[0]);
  assert.strictEqual(headings(doc)[0].textContent, 'Small batches...');
}

{
  const doc = createDocument();
  const timers = [];
  const missed = [];
  const applier = runtime.createApplier(doc, {
    schedule: (fn) => fn(),
    MutationObserver: doc.MutationObserver,
    setTimeout(fn, ms) {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    onMissed(change) { missed.push(change.selector); },
  });
  applier.applyAll([above], 'wait');
  assert.strictEqual(headings(doc).length, 0);
  assert.strictEqual(timers.length, 1);
  timers[0].fn();
  assert.deepStrictEqual(missed, [selector]);
  const late = addContent(doc);
  assert.strictEqual(headings(doc).length, 0);
  applier.rewatchUnmatched();
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(late.previousSibling, headings(doc)[0]);
  applier.rewatchUnmatched();
  doc.notify([late]);
  assert.strictEqual(headings(doc).length, 1);
  late.remove();
  const again = addContent(doc);
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(again.previousSibling.tagName, 'H2');
}

// Below the anchor follows the same replace rule.
{
  const doc = createDocument();
  const target = addContent(doc);
  const change = Object.assign({}, below);
  const applier = applierFor(doc);
  applier.applyAll([change], 'after');
  applier.applyAll([change], 'after');
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(target.nextSibling, headings(doc)[0]);
  change.value = '<h2>Still one</h2>';
  applier.applyAll([change], 'after');
  assert.strictEqual(headings(doc).length, 1);
  assert.strictEqual(headings(doc)[0].textContent, 'Still one');
}

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

function editorPage(options) {
  const opts = options || {};
  const doc = createDocument();
  const target = addContent(doc);
  const blurb = doc.createElement('p');
  blurb.className = 'blurb';
  blurb.textContent = 'Subtle, annoying apparel';
  doc.body.insertBefore = undefined;
  doc.body.appendChild(blurb);
  // appendChild notifies and the blurb is after the grid. Move it in front
  // without a second insert by splicing the child list.
  doc.body.children.pop();
  doc.body.children.unshift(blurb);
  blurb.parentElement = doc.body;
  blurb.parentNode = doc.body;
  blurb.isConnected = true;

  const reloads = [];
  const fetches = [];
  let changes = opts.changes || [above];
  const sandbox = {
    document: doc,
    window: {
      location: {
        href: `https://cantsaythat.co.uk/collections/all?ab_edit=${variantId}&token=edit-token`,
        search: `?ab_edit=${variantId}&token=edit-token`,
        origin: 'https://cantsaythat.co.uk',
        reload() { reloads.push(1); },
      },
      history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280,
      innerHeight: 800,
      document: doc,
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    fetch: async (url, request) => {
      fetches.push({ url: String(url), opts: request || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: variantId,
          experiment_id: expId,
          experiment_name: 'Collection',
          name: 'Offer',
          experiment_status: 'draft',
          experiment_status_label: 'Draft',
          edit_warning: '',
          changes: changes,
          goals: [],
          goals_scope: 'shared',
          steps_note: '',
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
    Array,
    Object,
    JSON,
    Function,
    Set,
    Map,
  };
  if (opts.runtime !== false) sandbox.window.PivitRuntime = runtime;
  doc.currentScript = {
    src: 'https://pivitlab.com/snippet/editor.js',
    getAttribute(name) {
      if (name === 'data-api') return 'https://pivitlab.com';
      if (name === 'data-variant-id') return variantId;
      if (name === 'data-token') return 'edit-token';
      return null;
    },
  };
  return { doc, target, blurb, sandbox, reloads, fetches, setChanges(next) { changes = next; } };
}

function walkAll(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walkAll(child, visit));
}

function findButton(root, label) {
  let found = null;
  walkAll(root, (node) => {
    if (node.tagName === 'BUTTON' && node.textContent === label) found = node;
  });
  return found;
}

function findTextarea(root) {
  let found = null;
  walkAll(root, (node) => {
    if (node.tagName === 'TEXTAREA') found = node;
  });
  return found;
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const page = editorPage();
  vm.runInNewContext(editorSrc, page.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(headings(page.doc).length, 1);
  assert.strictEqual(headings(page.doc)[0].textContent, 'Small batches...');

  page.doc.getElementById('pivit-changes-toggle').click();
  findButton(page.doc.body, 'Edit').click();
  await flush();
  const area = findTextarea(page.doc.body);
  assert.ok(area);
  assert.strictEqual(area.value, '<h2>Small batches...</h2>');
  area.value = '<h2>Smaller batches...</h2>';
  findButton(page.doc.body, 'Save change').click();
  await flush();
  const choice = page.doc.getElementById('pivit-replay-choice');
  assert.ok(choice);
  findButton(choice, 'Apply without reloading').click();
  await flush();
  assert.strictEqual(page.reloads.length, 0);
  assert.strictEqual(headings(page.doc).length, 1);
  assert.strictEqual(headings(page.doc)[0].textContent, 'Smaller batches...');

  page.doc.getElementById('pivit-changes-toggle').click();
  findButton(page.doc.body, 'Edit').click();
  await flush();
  findTextarea(page.doc.body).value = '<h2>One line only</h2>';
  findButton(page.doc.body, 'Save change').click();
  await flush();
  findButton(page.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  assert.strictEqual(headings(page.doc).length, 1);
  assert.strictEqual(headings(page.doc)[0].textContent, 'One line only');

  page.doc.getElementById('pivit-changes-toggle').click();
  findButton(page.doc.body, 'Remove').click();
  await flush();
  findButton(page.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  assert.strictEqual(headings(page.doc).length, 0);
  assert.strictEqual(page.reloads.length, 0);

  const undone = editorPage({
    changes: [
      { selector: 'p.blurb', type: 'delete', label: 'Subtle, annoying apparel' },
      above,
    ],
  });
  vm.runInNewContext(editorSrc, undone.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(headings(undone.doc).length, 1);
  undone.doc.getElementById('pivit-changes-toggle').click();
  findButton(undone.doc.body, 'Undo').click();
  await flush();
  assert.strictEqual(headings(undone.doc).length, 1);
  assert.strictEqual(headings(undone.doc)[0].textContent, 'Small batches...');
  assert.strictEqual(undone.blurb.isConnected, true);
  assert.notStrictEqual(undone.blurb.style.display, 'none');

  const banner = editorPage({
    changes: [{
      type: 'banner',
      text: 'Sale ends in',
      countdown: 'none',
      background: '#131723',
      color: '#ffffff',
      position: 'top',
      sticky: true,
    }],
  });
  vm.runInNewContext(editorSrc, banner.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(banner.doc.querySelectorAll('#pivit-banner').length, 1);
  banner.doc.getElementById('pivit-changes-toggle').click();
  findButton(banner.doc.body, 'Edit').click();
  await flush();
  const text = banner.doc.getElementById('pivit-banner-text');
  assert.strictEqual(text.value, 'Sale ends in');
  text.value = 'One weekend only';
  findButton(banner.doc.getElementById('pivit-banner-panel'), 'Save change').click();
  await flush();
  findButton(banner.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  const bars = banner.doc.querySelectorAll('#pivit-banner');
  assert.strictEqual(bars.length, 1);
  let bannerText = '';
  walkAll(bars[0], (node) => { bannerText += node.textContent || ''; });
  assert.ok(bannerText.indexOf('One weekend only') !== -1);

  const wording = editorPage({
    changes: [{ selector: selector, type: 'insert_before', value: 'Small batches...' }],
  });
  vm.runInNewContext(editorSrc, wording.sandbox, { filename: 'editor.js' });
  await flush();
  const wordingNotes = textBefore(wording.target).filter((node) => node.textContent.indexOf('Small batches') !== -1);
  assert.strictEqual(wordingNotes.length, 1);
  wording.doc.getElementById('pivit-changes-toggle').click();
  findButton(wording.doc.body, 'Edit').click();
  await flush();
  findTextarea(wording.doc.body).value = 'One line only';
  findButton(wording.doc.body, 'Save change').click();
  await flush();
  findButton(wording.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  const rewritten = textBefore(wording.target).filter((node) => String(node.textContent || '').trim());
  assert.strictEqual(rewritten.length, 1);
  assert.strictEqual(rewritten[0].textContent, 'One line only');

  const plain = editorPage({ runtime: false });
  vm.runInNewContext(editorSrc, plain.sandbox, { filename: 'editor.js' });
  await flush();
  assert.strictEqual(headings(plain.doc).length, 1);
  plain.doc.getElementById('pivit-changes-toggle').click();
  findButton(plain.doc.body, 'Edit').click();
  await flush();
  findTextarea(plain.doc.body).value = '<h2>Without the runtime</h2>';
  findButton(plain.doc.body, 'Save change').click();
  await flush();
  findButton(plain.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  assert.strictEqual(headings(plain.doc).length, 1);
  assert.strictEqual(headings(plain.doc)[0].textContent, 'Without the runtime');
  plain.doc.getElementById('pivit-changes-toggle').click();
  findButton(plain.doc.body, 'Remove').click();
  await flush();
  findButton(plain.doc.getElementById('pivit-replay-choice'), 'Apply without reloading').click();
  await flush();
  assert.strictEqual(headings(plain.doc).length, 0);

  console.log('insert-html.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
