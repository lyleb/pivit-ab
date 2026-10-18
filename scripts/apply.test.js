const assert = require('assert');
const runtime = require('../snippet/ab.js');

function matchCompound(node, compound) {
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
  if (match[1] && node.tagName.toLowerCase() !== match[1]) return false;
  if (match[2]) {
    const want = match[2].slice(1).split('.');
    const have = (node.className || '').split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function matchSelector(node, selector) {
  if (selector.indexOf('>') !== -1) {
    const parts = selector.split(/\s*>\s*/);
    let current = node;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!current || !matchCompound(current, parts[i])) return false;
      current = current.parentElement;
    }
    return true;
  }
  const parts = selector.trim().split(/\s+/);
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (ancestor && !matchCompound(ancestor, parts[i])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function walk(root, includeSelf) {
  const out = [];
  function rec(node) {
    (node.children || []).forEach((child) => { out.push(child); rec(child); });
  }
  if (includeSelf) out.push(root);
  if (root && root.children) rec(root);
  return out;
}

function createDocument() {
  const registry = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.dead = false; }
    observe() { registry.push(this); }
    disconnect() { this.dead = true; }
    takeRecords() { return []; }
  }
  function notify(nodes) {
    if (!nodes || !nodes.length) return;
    const record = { addedNodes: nodes, type: 'childList' };
    registry.slice().forEach((observer) => { if (!observer.dead) observer.cb([record]); });
  }
  function parseHTML(html) {
    const nodes = [];
    const re = /<([a-z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let found;
    while ((found = re.exec(html))) {
      const node = createEl(found[1]);
      const cls = /class="([^"]*)"/.exec(found[2]);
      if (cls) { node.className = cls[1]; node.attributes.class = cls[1]; }
      node.textContent = found[3].replace(/<[^>]+>/g, '').trim();
      node.innerHTML = found[3];
      nodes.push(node);
    }
    return nodes;
  }
  function createEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      children: [],
      parentElement: null,
      attributes: {},
      style: {},
      textContent: '',
      innerHTML: '',
      isConnected: true,
    };
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
    el.setAttribute = (name, value) => {
      el.attributes[name] = String(value);
      if (name === 'id') el.id = String(value);
      if (name === 'class') el.className = String(value);
    };
    el.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null);
    el.removeAttribute = (name) => {
      delete el.attributes[name];
      if (name === 'id') el.id = '';
    };
    el.matches = (selector) => matchSelector(el, selector);
    el.querySelectorAll = (selector) => walk(el, false).filter((node) => matchSelector(node, selector));
    el.cloneNode = function clone(deep) {
      const copy = createEl(el.tagName);
      copy.id = el.id;
      copy.className = el.className;
      copy.textContent = el.textContent;
      copy.innerHTML = el.innerHTML;
      Object.keys(el.attributes).forEach((name) => { copy.attributes[name] = el.attributes[name]; });
      Object.assign(copy.style, el.style);
      if (deep) {
        el.children.forEach((child) => {
          const cloned = child.cloneNode(true);
          cloned.parentElement = copy;
          copy.children.push(cloned);
        });
      }
      return copy;
    };
    el.remove = () => {
      if (!el.parentElement) return;
      const index = el.parentElement.children.indexOf(el);
      if (index >= 0) el.parentElement.children.splice(index, 1);
      el.parentElement = null;
      el.isConnected = false;
    };
    el.appendChild = (child) => {
      if (child.parentElement) child.remove();
      child.parentElement = el;
      child.isConnected = true;
      el.children.push(child);
      notify([child]);
      return child;
    };
    el.insertAdjacentElement = (position, child) => {
      if (position !== 'afterend') throw new Error('unsupported position ' + position);
      const parent = el.parentElement;
      if (child.parentElement) child.remove();
      child.parentElement = parent;
      child.isConnected = true;
      parent.children.splice(parent.children.indexOf(el) + 1, 0, child);
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
        node.isConnected = true;
        parent.children.splice(index + offset, 0, node);
      });
      notify(nodes);
    };
    return el;
  }

  const doc = {
    nodeType: 9,
    createElement(tag) { return createEl(tag); },
    getElementById(id) {
      return walk(doc.documentElement, true).find((node) => node.id === id) || null;
    },
    querySelectorAll(selector) {
      return walk(doc.documentElement, true).filter((node) => matchSelector(node, selector));
    },
  };
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.MutationObserver = MutationObserver;
  doc.notify = notify;
  doc.insertFirst = (child) => {
    if (child.parentElement) child.remove();
    child.parentElement = doc.body;
    child.isConnected = true;
    doc.body.children.unshift(child);
    notify([child]);
    return child;
  };
  return doc;
}

function addBadge(doc, text) {
  const el = doc.createElement('span');
  el.className = 'badge';
  el.attributes.class = 'badge';
  el.textContent = text;
  doc.body.appendChild(el);
  return el;
}

function applierFor(doc) {
  return runtime.createApplier(doc, {
    schedule: (fn) => fn(),
    MutationObserver: doc.MutationObserver,
  });
}

function styleTags(doc) {
  return doc.head.children.filter((node) => node.tagName === 'STYLE');
}

// Several matches, then an element inserted later.
{
  const doc = createDocument();
  const first = addBadge(doc, 'NEW');
  const second = addBadge(doc, 'NEW');
  const third = addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  applier.applyAll([{ selector: 'span.badge', type: 'text', value: 'Sale' }], 'text');
  assert.strictEqual(first.textContent, 'Sale');
  assert.strictEqual(second.textContent, 'Sale');
  assert.strictEqual(third.textContent, 'Sale');
  const late = addBadge(doc, 'NEW');
  assert.strictEqual(late.textContent, 'Sale');
}

// Style goes through one <style> rule, including for a badge that appears later.
// Applying the same change again does not add a second rule.
{
  const doc = createDocument();
  const first = addBadge(doc, 'NEW');
  addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  const change = { selector: 'span.badge', type: 'style', value: { backgroundColor: '#ff00aa', color: 'white' } };
  applier.applyAll([change], 'style');
  applier.applyAll([change], 'style');
  const tags = styleTags(doc);
  assert.strictEqual(tags.length, 1);
  assert.ok(tags[0].textContent.indexOf('background-color:#ff00aa !important') !== -1);
  assert.ok(tags[0].textContent.indexOf('color:white !important') !== -1);
  assert.strictEqual(first.style.backgroundColor, undefined);
  const late = addBadge(doc, 'NEW');
  assert.strictEqual(late.style.backgroundColor, undefined);
  assert.strictEqual(styleTags(doc).length, 1);
}

// JS runs once per element. A second pass, and a mutation of an element
// already handled, does not run it again. A new element runs once.
{
  const doc = createDocument();
  const first = addBadge(doc, 'NEW');
  const second = addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  const change = {
    selector: 'span.badge',
    type: 'js',
    value: 'el.setAttribute("data-n", String(Number(el.getAttribute("data-n") || 0) + 1))',
  };
  applier.applyAll([change], 'js');
  applier.applyAll([change], 'js');
  doc.notify([first]);
  assert.strictEqual(first.getAttribute('data-n'), '1');
  assert.strictEqual(second.getAttribute('data-n'), '1');
  const late = addBadge(doc, 'NEW');
  assert.strictEqual(late.getAttribute('data-n'), '1');
  doc.notify([late]);
  assert.strictEqual(late.getAttribute('data-n'), '1');
}

// Duplicate once per match, including a badge added later, and not again.
{
  const doc = createDocument();
  addBadge(doc, 'NEW');
  addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  applier.applyAll([{ selector: 'span.badge', type: 'duplicate' }], 'dup');
  assert.strictEqual(doc.querySelectorAll('span.badge').length, 4);
  doc.notify(doc.querySelectorAll('span.badge'));
  assert.strictEqual(doc.querySelectorAll('span.badge').length, 4);
  addBadge(doc, 'NEW');
  assert.strictEqual(doc.querySelectorAll('span.badge').length, 6);
}

// Replace does not keep replacing the node it just inserted.
{
  const doc = createDocument();
  const first = addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  applier.applyAll([{
    selector: 'span.badge',
    type: 'replace',
    value: '<span class="badge">Done</span>',
  }], 'rep');
  const left = doc.querySelectorAll('span.badge');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].textContent, 'Done');
  assert.strictEqual(first.isConnected, false);
}

// A positional selector still changes only the element it matched at apply
// time. Inserting a badge in front does not move the change.
{
  const doc = createDocument();
  const first = addBadge(doc, 'A');
  const second = addBadge(doc, 'B');
  const applier = applierFor(doc);
  applier.applyAll([{
    selector: 'span.badge:nth-of-type(1)',
    type: 'text',
    value: 'Z',
  }], 'pos');
  assert.strictEqual(first.textContent, 'Z');
  assert.strictEqual(second.textContent, 'B');
  const inserted = doc.createElement('span');
  inserted.className = 'badge';
  inserted.attributes.class = 'badge';
  inserted.textContent = 'N';
  doc.insertFirst(inserted);
  assert.strictEqual(inserted.textContent, 'N');
  assert.strictEqual(first.textContent, 'Z');
  assert.strictEqual(first.getAttribute('data-pivit-applied'), null);
}

// Positional style stays an inline style. A class selector becomes CSS.
// An existing stylesheet change is injected unchanged.
{
  const doc = createDocument();
  const first = addBadge(doc, 'A');
  const second = addBadge(doc, 'B');
  const applier = applierFor(doc);
  applier.applyAll([
    { selector: 'span.badge:nth-of-type(2)', type: 'style', value: { color: 'red' } },
    { selector: 'span.badge', type: 'hide' },
    { type: 'stylesheet', selector: 'span.badge:nth-of-type(1)', value: 'span.badge:nth-of-type(1){color:red}' },
  ], 'mix');
  assert.strictEqual(second.style.color, 'red');
  assert.strictEqual(first.style.color, undefined);
  assert.strictEqual(first.style.display, undefined);
  const tags = styleTags(doc);
  assert.strictEqual(tags.length, 2);
  const css = tags.map((tag) => tag.textContent).join('\n');
  assert.ok(css.indexOf('span.badge{display:none !important}') !== -1);
  assert.ok(css.indexOf('span.badge:nth-of-type(1){color:red}') !== -1);
  assert.ok(css.indexOf('color:red !important') === -1);
}

// A view is applied only when every element selector is on the page.
// Stylesheet-only changes do not count. A miss on one change fails the set.
{
  const doc = createDocument();
  addBadge(doc, 'NEW');
  const applier = applierFor(doc);
  const hit = applier.applyAll([{ selector: 'span.badge', type: 'text', value: 'Sale' }], 'hit');
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.checked, 1);
  const miss = applier.applyAll([{ selector: 'span.missing', type: 'text', value: 'Sale' }], 'miss');
  assert.strictEqual(miss.ok, false);
  const none = applier.applyAll([], 'none');
  assert.strictEqual(none.ok, null);
  const cssOnly = applier.applyAll([{ type: 'stylesheet', selector: '', value: '.x{color:red}' }], 'css');
  assert.strictEqual(cssOnly.ok, null);
  const styled = applier.applyAll([{ selector: 'span.badge', type: 'hide' }], 'hide');
  assert.strictEqual(styled.ok, true);
  const hiddenMiss = applier.applyAll([{ selector: 'span.missing', type: 'hide' }], 'hidemiss');
  assert.strictEqual(hiddenMiss.ok, false);
  const mixed = applier.applyAll([
    { selector: 'span.badge', type: 'text', value: 'A' },
    { selector: 'span.missing', type: 'text', value: 'B' },
  ], 'mix2');
  assert.strictEqual(mixed.ok, false);
  assert.strictEqual(mixed.checked, 2);
  assert.strictEqual(mixed.applied, 1);
}

// A JS-tab change runs once on a load, including beside a stylesheet.
// The same applier does not run it again. A new applier is a fresh load
// (switching device or refreshing the frame) and runs it again.
{
  const doc = createDocument();
  const applier = applierFor(doc);
  const js = {
    selector: 'body',
    type: 'js',
    value: 'el.setAttribute("data-offer", String(Number(el.getAttribute("data-offer") || 0) + 1))',
  };
  const css = { type: 'stylesheet', selector: '', value: '#offer-banner{background:#5635FB;color:#fff}' };
  applier.applyAll([css, js], 'banner');
  applier.applyAll([css, js], 'banner');
  assert.strictEqual(doc.body.getAttribute('data-offer'), '1');
  const cssText = styleTags(doc).map((tag) => tag.textContent).join('\n');
  assert.ok(cssText.indexOf('#offer-banner{background:#5635FB;color:#fff}') !== -1);
  assert.strictEqual(styleTags(doc).length, 1);
  // A replaced frame is a new document, so the once-per-load mark is gone.
  const next = createDocument();
  applierFor(next).applyAll([css, js], 'banner');
  assert.strictEqual(next.body.getAttribute('data-offer'), '1');
}

// page_css is one style tag. A second apply, a mutation, and a new applier
// on the same document do not add another. A removed tag is put back once.
// A new document (a device frame loading again) gets its own tag.
{
  const doc = createDocument();
  addBadge(doc, 'A');
  const applier = applierFor(doc);
  const css = { type: 'page_css', value: 'body{background:#fff}' };
  applier.applyAll([css], 'page');
  applier.applyAll([css], 'page');
  doc.notify([doc.body]);
  addBadge(doc, 'B');
  const pageStyles = () => styleTags(doc).filter((tag) => tag.getAttribute('data-pivit-page-css') != null);
  assert.strictEqual(pageStyles().length, 1);
  assert.strictEqual(pageStyles()[0].textContent, 'body{background:#fff}');
  applier.applyAll([{ type: 'page_css', value: 'body{background:#111}' }], 'page');
  assert.strictEqual(pageStyles().length, 1);
  assert.strictEqual(pageStyles()[0].textContent, 'body{background:#111}');
  pageStyles()[0].remove();
  applier.applyAll([css], 'page');
  assert.strictEqual(pageStyles().length, 1);
  assert.strictEqual(pageStyles()[0].textContent, 'body{background:#fff}');
  applierFor(doc).applyAll([css], 'page');
  assert.strictEqual(pageStyles().length, 1);
  const fresh = createDocument();
  applierFor(fresh).applyAll([css], 'page');
  assert.strictEqual(styleTags(fresh).filter((tag) => tag.getAttribute('data-pivit-page-css') != null).length, 1);
}

// page_js runs once per page view, not once per matching element. A second
// apply, the mutation observer, and a new applier on the same document (an
// SPA re-render) do not run it again. A new document does.
{
  const doc = createDocument();
  addBadge(doc, 'A');
  addBadge(doc, 'B');
  const source = 'document.documentElement.setAttribute("data-runs", String(Number(document.documentElement.getAttribute("data-runs") || 0) + 1))';
  const change = { type: 'page_js', selector: 'span.badge', value: source };
  const applier = applierFor(doc);
  applier.applyAll([change], 'page');
  applier.applyAll([change], 'page');
  doc.notify(doc.querySelectorAll('span.badge'));
  addBadge(doc, 'C');
  assert.strictEqual(doc.documentElement.getAttribute('data-runs'), '1');
  assert.strictEqual(doc.querySelectorAll('span.badge').length, 3);
  applierFor(doc).applyAll([change], 'page');
  assert.strictEqual(doc.documentElement.getAttribute('data-runs'), '1');
  const fresh = createDocument();
  addBadge(fresh, 'A');
  applierFor(fresh).applyAll([change], 'page');
  assert.strictEqual(fresh.documentElement.getAttribute('data-runs'), '1');
}

// A thrown page_js is caught. Later page CSS and element changes still apply,
// and a second pass does not throw or run the script again.
{
  const doc = createDocument();
  const badge = addBadge(doc, 'A');
  const applier = applierFor(doc);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  let threw = false;
  try {
    applier.applyAll([
      { type: 'page_js', value: 'throw new Error("boom")' },
      { type: 'page_css', value: '.ok{color:red}' },
      { selector: 'span.badge', type: 'text', value: 'Sale' },
      { selector: 'span.badge', type: 'html', value: '<b>Sale</b>' },
      { selector: 'span.badge', type: 'js', value: 'el.setAttribute("data-el", "1")' },
    ], 'safe');
    applier.applyAll([{ type: 'page_js', value: 'throw new Error("boom")' }], 'safe');
  } catch (err) {
    threw = true;
  } finally {
    console.warn = original;
  }
  assert.strictEqual(threw, false);
  assert.ok(warnings.some((line) => line.indexOf('page JS change failed') !== -1));
  assert.strictEqual(badge.textContent, 'Sale');
  assert.strictEqual(badge.getAttribute('data-el'), '1');
  assert.ok(styleTags(doc).some((tag) => tag.textContent.indexOf('.ok{color:red}') !== -1));
  assert.strictEqual(styleTags(doc).filter((tag) => tag.getAttribute('data-pivit-page-css') != null).length, 1);
}

// Page CSS and page JS are not element checks. An element change beside them
// is still checked on its own. A stylesheet change is still injected as before.
{
  const doc = createDocument();
  addBadge(doc, 'A');
  const applier = applierFor(doc);
  const mixed = applier.applyAll([
    { type: 'page_css', value: '.page{color:blue}' },
    { type: 'page_js', value: 'document.documentElement.setAttribute("data-page", "1")' },
    { type: 'stylesheet', selector: 'span.badge', value: 'span.badge{color:red}' },
    { selector: 'span.badge', type: 'text', value: 'Kept' },
  ], 'mixpage');
  assert.strictEqual(mixed.checked, 1);
  assert.strictEqual(mixed.ok, true);
  assert.strictEqual(doc.documentElement.getAttribute('data-page'), '1');
  assert.strictEqual(doc.querySelectorAll('span.badge')[0].textContent, 'Kept');
  const css = styleTags(doc).map((tag) => tag.textContent).join('\n');
  assert.ok(css.indexOf('.page{color:blue}') !== -1);
  assert.ok(css.indexOf('span.badge{color:red}') !== -1);
  const pageOnly = applier.applyAll([
    { type: 'page_css', value: '.only{color:red}' },
    { type: 'page_js', value: 'document.documentElement.setAttribute("data-only", "1")' },
  ], 'only');
  assert.strictEqual(pageOnly.ok, null);
  assert.strictEqual(pageOnly.checked, 0);
}

console.log('apply.test.js ok');
