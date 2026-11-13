// Targeting and persistence: repeated, nested and hidden elements, selector
// stability, hydration replacement, and the observer cap. The document here
// is a small stand-in for a browser page (the same shape the other snippet
// tests use), including text nodes, computed style and a mutation observer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

function el(tag, className, children, id) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: id || '',
    className: className || '',
    children: children || [],
    parentElement: null,
    style: {},
  };
  node.children.forEach((child) => { child.parentElement = node; });
  return node;
}

function walk(node, out) {
  out.push(node);
  (node.children || []).forEach((child) => walk(child, out));
  return out;
}

function matchesCompound(node, compound) {
  const nth = compound.match(/:nth-of-type\((\d+)\)/);
  const base = compound.replace(/:nth-of-type\(\d+\)/g, '');
  if (nth) {
    const parent = node.parentElement;
    if (!parent) return false;
    const same = parent.children.filter((child) => child.tagName === node.tagName);
    if (same.indexOf(node) + 1 !== Number(nth[1])) return false;
  }
  if (base.charAt(0) === '#') return node.id === base.slice(1);
  const match = base.match(/^([a-zA-Z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/);
  if (!match) return false;
  if (match[1] && node.tagName.toLowerCase() !== match[1]) return false;
  if (match[2]) {
    const want = match[2].slice(1).split('.');
    const have = String(node.className || '').split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const all = walk(root, []);
  if (selector.indexOf(' ') !== -1 && selector.indexOf('>') === -1) {
    const parts = selector.trim().split(/\s+/);
    return all.filter((node) => {
      if (!matchesCompound(node, parts[parts.length - 1])) return false;
      let ancestor = node.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !matchesCompound(ancestor, parts[i])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  return all.filter((node) => matchesCompound(node, selector));
}

assert.strictEqual(runtime.isGeneratedClass('jsx-12345'), true);
assert.strictEqual(runtime.isGeneratedClass('svelte-a1b2c3'), true);
assert.strictEqual(runtime.isGeneratedClass('emotion-heading'), true);
assert.strictEqual(runtime.isGeneratedClass('go12345'), true);
assert.strictEqual(runtime.isGeneratedClass('badge--new'), false);
assert.strictEqual(runtime.isGeneratedId('radix-1'), true);
assert.strictEqual(runtime.isGeneratedId(':r1:'), true);
assert.strictEqual(runtime.isGeneratedId('a1b2c3d4e5'), true);
assert.strictEqual(runtime.isGeneratedId('pay-now'), false);
assert.strictEqual(runtime.isGeneratedId('headline'), false);

assert.deepStrictEqual(runtime.selectorStability('#pay-now'), { unstable: false, kind: '' });
assert.deepStrictEqual(runtime.selectorStability('section.hero h1'), { unstable: false, kind: '' });
assert.strictEqual(runtime.selectorStability('div.css-9abc12').kind, 'generated');
assert.strictEqual(runtime.selectorStability('#radix-1').kind, 'generated');
assert.strictEqual(runtime.selectorStability('section.hero h1:nth-of-type(1)').kind, 'positional');
assert.strictEqual(runtime.selectorStability('div > div > div > span').kind, 'long');
assert.strictEqual(runtime.selectorStability('div:nth-of-type(1) > main.wrap > section.hero > h1').kind, 'long');

// Six cards. All similar is the shared class. Just this one is unique.
{
  const cards = [];
  for (let i = 0; i < 6; i++) cards.push(el('li', 'card', [], i === 2 ? 'featured' : ''));
  const list = el('ul', 'products', cards);
  const body = el('body', '', [list]);
  const query = (selector) => queryAll(body, selector);
  const suggested = runtime.generaliseSelector(cards[0], query);
  assert.strictEqual(suggested, 'li.card');
  assert.strictEqual(query(suggested).length, 6);
  const unique = runtime.uniqueSelector(cards[0], { body, querySelectorAll: query });
  assert.notStrictEqual(unique, suggested);
  assert.strictEqual(query(unique).length, 1);
  assert.strictEqual(query(unique)[0], cards[0]);
  const featured = runtime.uniqueSelector(cards[2], { body, querySelectorAll: query });
  assert.strictEqual(featured, '#featured');
  assert.strictEqual(runtime.selectorStability(featured).unstable, false);
}

// A generated class is not the steadier choice when a parent has a real one.
{
  const box = el('div', 'css-9abc12');
  const section = el('section', 'products', [box]);
  const body = el('body', '', [section]);
  const query = (selector) => queryAll(body, selector);
  const obvious = runtime.generaliseSelector(box, query);
  assert.strictEqual(runtime.selectorStability(obvious).kind, 'generated');
  const better = runtime.steadierSelector(box, query);
  assert.strictEqual(better, 'section.products div');
  assert.strictEqual(runtime.selectorStability(better).unstable, false);
  assert.ok(query(better).indexOf(box) !== -1);
}

// Text inside a button keeps the icon.
{
  const icon = { nodeType: 1, tagName: 'SVG', childNodes: [], children: [] };
  const words = { nodeType: 3, nodeValue: ' Buy now' };
  const button = {
    nodeType: 1,
    tagName: 'BUTTON',
    childNodes: [icon, words],
    children: [icon],
    style: {},
  };
  icon.parentElement = button;
  words.parentElement = button;
  assert.strictEqual(runtime.readElementText(button), 'Buy now');
  runtime.writeElementText(button, 'Add to bag');
  assert.strictEqual(words.nodeValue, 'Add to bag');
  assert.strictEqual(button.childNodes[0], icon);
  assert.strictEqual(runtime.readElementText(button), 'Add to bag');
}

// Words split across a label, with an empty icon span left in place.
{
  const icon = { nodeType: 1, tagName: 'SPAN', className: 'icon', childNodes: [], children: [] };
  const labelText = { nodeType: 3, nodeValue: 'Shop' };
  const label = { nodeType: 1, tagName: 'SPAN', className: 'label', childNodes: [labelText], children: [] };
  labelText.parentElement = label;
  const link = {
    nodeType: 1,
    tagName: 'A',
    childNodes: [icon, label],
    children: [icon, label],
    style: {},
  };
  assert.strictEqual(runtime.readElementText(link), 'Shop');
  runtime.writeElementText(link, 'Browse');
  assert.strictEqual(labelText.nodeValue, 'Browse');
  assert.strictEqual(link.childNodes[0], icon);
}

// Hidden copies: inline style, the hidden attribute, aria-hidden, a parent,
// and a stylesheet the computed style can see.
{
  const inline = { nodeType: 1, tagName: 'H1', style: { display: 'none' }, parentElement: null };
  assert.strictEqual(runtime.isHiddenElement(inline), true);
  const shown = { nodeType: 1, tagName: 'H1', style: {}, parentElement: null };
  assert.strictEqual(runtime.isHiddenElement(shown), false);
  const attr = {
    nodeType: 1,
    tagName: 'DIV',
    style: {},
    parentElement: null,
    hasAttribute(name) { return name === 'hidden'; },
  };
  assert.strictEqual(runtime.isHiddenElement(attr), true);
  const aria = {
    nodeType: 1,
    tagName: 'DIV',
    style: {},
    parentElement: null,
    getAttribute(name) { return name === 'aria-hidden' ? 'true' : null; },
  };
  assert.strictEqual(runtime.isHiddenElement(aria), true);
  const parent = { nodeType: 1, tagName: 'DIV', style: { display: 'none' }, parentElement: null };
  const child = { nodeType: 1, tagName: 'H1', style: {}, parentElement: parent };
  assert.strictEqual(runtime.isHiddenElement(child), true);
  const view = {
    getComputedStyle(node) {
      return {
        display: node.className === 'mobile' ? 'none' : 'block',
        visibility: 'visible',
      };
    },
  };
  const doc = { defaultView: view };
  const mobile = { nodeType: 1, tagName: 'H1', className: 'mobile', style: {}, parentElement: null, ownerDocument: doc };
  const desktop = { nodeType: 1, tagName: 'H1', className: 'desktop', style: {}, parentElement: null, ownerDocument: doc };
  assert.strictEqual(runtime.isHiddenElement(mobile), true);
  assert.strictEqual(runtime.isHiddenElement(desktop), false);
}

function matchCompound(node, compound) {
  const nth = compound.match(/:nth-of-type\((\d+)\)/);
  const base = compound.replace(/:nth-of-type\(\d+\)/g, '');
  if (nth) {
    const parent = node.parentElement;
    if (!parent) return false;
    const same = (parent.children || []).filter((child) => child.tagName === node.tagName);
    if (same.indexOf(node) + 1 !== Number(nth[1])) return false;
  }
  if (!base) return true;
  if (base.charAt(0) === '#') return node.id === base.slice(1);
  const match = base.match(/^([a-zA-Z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/);
  if (!match) return false;
  if (match[1] && node.tagName.toLowerCase() !== match[1]) return false;
  if (match[2]) {
    const want = match[2].slice(1).split('.');
    const have = String(node.className || '').split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function matchSelector(node, selector) {
  if (selector.indexOf(',') !== -1) {
    return selector.split(',').some((part) => matchSelector(node, part.trim()));
  }
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
  function createEl(tag) {
    const elNode = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      children: [],
      childNodes: [],
      parentElement: null,
      attributes: {},
      style: {},
      textContent: '',
      innerHTML: '',
      isConnected: true,
    };
    elNode.setAttribute = (name, value) => {
      elNode.attributes[name] = String(value);
      if (name === 'id') elNode.id = String(value);
      if (name === 'class') elNode.className = String(value);
    };
    elNode.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(elNode.attributes, name) ? elNode.attributes[name] : null);
    elNode.removeAttribute = (name) => { delete elNode.attributes[name]; };
    elNode.matches = (selector) => matchSelector(elNode, selector);
    elNode.querySelectorAll = (selector) => {
      const out = [];
      (function rec(node) {
        (node.children || []).forEach((child) => {
          if (matchSelector(child, selector)) out.push(child);
          rec(child);
        });
      })(elNode);
      return out;
    };
    elNode.cloneNode = function clone() {
      const copy = createEl(elNode.tagName);
      copy.id = '';
      copy.className = elNode.className;
      copy.textContent = elNode.textContent;
      if (elNode.className) copy.attributes.class = elNode.className;
      return copy;
    };
    elNode.remove = () => {
      if (!elNode.parentElement) return;
      const index = elNode.parentElement.children.indexOf(elNode);
      if (index >= 0) elNode.parentElement.children.splice(index, 1);
      elNode.parentElement = null;
      elNode.isConnected = false;
    };
    elNode.appendChild = (child) => {
      if (child.parentElement) child.remove();
      child.parentElement = elNode;
      child.isConnected = true;
      elNode.children.push(child);
      notify([child]);
      return child;
    };
    elNode.insertAdjacentElement = (position, child) => {
      if (position !== 'afterend') throw new Error('unsupported position ' + position);
      const parent = elNode.parentElement;
      if (child.parentElement) child.remove();
      child.parentElement = parent;
      child.isConnected = true;
      parent.children.splice(parent.children.indexOf(elNode) + 1, 0, child);
      notify([child]);
      return child;
    };
    return elNode;
  }
  const doc = {
    nodeType: 9,
    createElement(tag) { return createEl(tag); },
    getElementById(id) {
      const all = [];
      (function rec(node) {
        all.push(node);
        (node.children || []).forEach(rec);
      })(doc.documentElement);
      return all.find((node) => node.id === id) || null;
    },
    querySelectorAll(selector) {
      const all = [];
      (function rec(node) {
        all.push(node);
        (node.children || []).forEach(rec);
      })(doc.documentElement);
      return all.filter((node) => node.nodeType === 1 && matchSelector(node, selector));
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
  const node = doc.createElement('span');
  node.className = 'badge';
  node.attributes.class = 'badge';
  node.textContent = text;
  doc.body.appendChild(node);
  return node;
}

function applierFor(doc) {
  return runtime.createApplier(doc, {
    schedule: (fn) => fn(),
    MutationObserver: doc.MutationObserver,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
}

// The same node is written once. A replacement (hydration) is written once
// more, and a second notice does not write it again.
{
  const doc = createDocument();
  const first = addBadge(doc, 'A');
  const applier = applierFor(doc);
  applier.applyAll([{ selector: 'span.badge', type: 'text', value: 'Sale' }], 'once');
  assert.strictEqual(first.textContent, 'Sale');
  first.textContent = 'Touched';
  doc.notify([first]);
  assert.strictEqual(first.textContent, 'Touched');
  first.remove();
  const replaced = addBadge(doc, 'A');
  assert.strictEqual(replaced.textContent, 'Sale');
  replaced.textContent = 'Kept';
  doc.notify([replaced]);
  assert.strictEqual(replaced.textContent, 'Kept');
}

// A positional match stays on the original when a node is inserted in front.
// Replacing the original applies the change to the new node, then stops
// after the cap. A route change starts that budget again.
{
  const doc = createDocument();
  const first = addBadge(doc, 'A');
  addBadge(doc, 'B');
  const applier = applierFor(doc);
  applier.applyAll([{ selector: 'span.badge:nth-of-type(1)', type: 'text', value: 'Z' }], 'pos');
  assert.strictEqual(first.textContent, 'Z');
  const inserted = doc.createElement('span');
  inserted.className = 'badge';
  inserted.attributes.class = 'badge';
  inserted.textContent = 'N';
  doc.insertFirst(inserted);
  assert.strictEqual(inserted.textContent, 'N');
  assert.strictEqual(first.textContent, 'Z');

  let current = first;
  for (let i = 0; i < runtime.POSITIONAL_PASS_CAP; i++) {
    current.remove();
    const neu = doc.createElement('span');
    neu.className = 'badge';
    neu.attributes.class = 'badge';
    neu.textContent = 'A';
    doc.insertFirst(neu);
    if (i < runtime.POSITIONAL_PASS_CAP - 1) assert.strictEqual(neu.textContent, 'Z', 'pass ' + i);
    else assert.strictEqual(neu.textContent, 'A', 'capped');
    current = neu;
  }
  applier.rewatchUnmatched();
  current.remove();
  const afterRoute = doc.createElement('span');
  afterRoute.className = 'badge';
  afterRoute.attributes.class = 'badge';
  afterRoute.textContent = 'A';
  doc.insertFirst(afterRoute);
  assert.strictEqual(afterRoute.textContent, 'Z');
}

// A selector that names each visible copy still changes every one of them.
// That is what "Leave the hidden copies" saves: the hidden copy is not listed.
{
  const doc = createDocument();
  const one = addBadge(doc, 'A');
  one.id = 'one';
  const two = addBadge(doc, 'B');
  two.id = 'two';
  const hidden = addBadge(doc, 'H');
  hidden.id = 'hidden-copy';
  hidden.style.display = 'none';
  const applier = applierFor(doc);
  applier.applyAll([{ selector: '#one, #two', type: 'text', value: 'Shown' }], 'visible');
  assert.strictEqual(one.textContent, 'Shown');
  assert.strictEqual(two.textContent, 'Shown');
  assert.strictEqual(hidden.textContent, 'H');
  applier.applyAll([{ selector: 'span.badge', type: 'text', value: 'All' }], 'all');
  assert.strictEqual(hidden.textContent, 'All');
}

// The snippet's own insert does not run the change again. A long run of
// later elements stops at the observer cap instead of looping.
{
  const doc = createDocument();
  addBadge(doc, 'A');
  const applier = applierFor(doc);
  applier.applyAll([{
    selector: 'span.badge',
    type: 'js',
    value: 'var n = el.cloneNode(true); n.textContent = "x"; el.parentElement.appendChild(n);',
  }], 'loop');
  assert.strictEqual(doc.querySelectorAll('span.badge').length, 2);
}

{
  const doc = createDocument();
  const applier = applierFor(doc);
  applier.applyAll([{ selector: 'span.badge', type: 'text', value: 'Sale' }], 'cap');
  let changed = 0;
  let unchanged = 0;
  for (let i = 0; i < runtime.OBSERVER_APPLY_CAP + 2; i++) {
    const node = addBadge(doc, 'NEW');
    if (node.textContent === 'Sale') changed += 1;
    else unchanged += 1;
  }
  assert.strictEqual(changed, runtime.OBSERVER_APPLY_CAP);
  assert.strictEqual(unchanged, 2);
}

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
[
  'Just this one',
  'All similar',
  'Select parent',
  'This change affects ',
  'more copies are hidden on this screen size.',
  'Include the hidden copies',
  'Leave the hidden copies',
  'Use this steadier choice',
  'paintSimilarHits(found.nodes)',
  'Icons and pictures inside this element stay as they are.',
].forEach((phrase) => {
  assert.ok(editorSrc.includes(phrase), phrase);
});
assert.ok(!editorSrc.includes('Nested markup inside it is replaced'));
assert.ok(!editorSrc.includes('Highlighting the first 200'));

console.log('targeting.test.js ok');
