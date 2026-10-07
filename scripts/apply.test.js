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

console.log('apply.test.js ok');
