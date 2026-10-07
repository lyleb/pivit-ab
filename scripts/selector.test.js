const assert = require('assert');
const runtime = require('../snippet/ab.js');

function el(tag, className, children, id) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: id || '',
    className: className || '',
    children: children || [],
    parentElement: null,
  };
  node.children.forEach((child) => { child.parentElement = node; });
  return node;
}

function walk(node, out) {
  out.push(node);
  node.children.forEach((child) => walk(child, out));
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
    const have = node.className.split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const all = walk(root, []);
  if (selector.indexOf(' ') !== -1) {
    const parts = selector.trim().split(/\s+/);
    return all.filter((node) => {
      if (!matchesCompound(node, parts[1])) return false;
      let ancestor = node.parentElement;
      while (ancestor && !matchesCompound(ancestor, parts[0])) ancestor = ancestor.parentElement;
      return !!ancestor;
    });
  }
  return all.filter((node) => matchesCompound(node, selector));
}

assert.strictEqual(runtime.isUnstableClass('is-visible'), true);
assert.strictEqual(runtime.isUnstableClass('has-error'), true);
assert.strictEqual(runtime.isUnstableClass('js-hidden'), true);
assert.strictEqual(runtime.isUnstableClass('item-content-wrapper--active'), true);
assert.strictEqual(runtime.isUnstableClass('swiper-slide-active'), true);
assert.strictEqual(runtime.isUnstableClass('active'), true);
assert.strictEqual(runtime.isGeneratedClass('css-9abc12'), true);
assert.strictEqual(runtime.isGeneratedClass('sc-bdVaJa'), true);
assert.strictEqual(runtime.isGeneratedClass('Badge_new__h3K9qa'), true);
assert.strictEqual(runtime.isGeneratedClass('shopify-section-template--1842'), true);
assert.strictEqual(runtime.isUnstableClass('ecommerce-product-ribbon'), false);
assert.strictEqual(runtime.isUnstableClass('ecommerce-product-ribbon__text'), false);
assert.strictEqual(runtime.isUnstableClass('badge--new'), false);
assert.strictEqual(runtime.isUnstableClass('product-list-item'), false);

assert.strictEqual(runtime.isPositionalSelector('div.product-list-item:nth-of-type(2) > div.ecommerce-product-ribbon'), true);
assert.strictEqual(runtime.isPositionalSelector('span.badge:nth-child(3)'), true);
assert.strictEqual(runtime.isPositionalSelector('p.badge:first-child'), true);
assert.strictEqual(runtime.isPositionalSelector('div.ecommerce-product-ribbon'), false);
assert.strictEqual(runtime.isPositionalSelector('#cta'), false);

// Shop-shaped NEW ribbons: stable class kept, state and hash dropped.
const ribbonA = el('div', 'ecommerce-product-ribbon is-visible css-9abc12');
const ribbonB = el('div', 'ecommerce-product-ribbon');
const ribbonC = el('div', 'ecommerce-product-ribbon');
const itemA = el('div', 'product-list-item', [ribbonA]);
const itemB = el('div', 'product-list-item', [ribbonB]);
const itemC = el('div', 'product-list-item', [ribbonC]);
const list = el('div', 'block-product-list', [itemA, itemB, itemC]);
const body = el('body', '', [list]);

const suggested = runtime.generaliseSelector(ribbonA, (selector) => queryAll(body, selector));
assert.strictEqual(suggested, 'div.ecommerce-product-ribbon');
assert.strictEqual(queryAll(body, suggested).length, 3);

const text = el('p', 'ecommerce-product-ribbon__text');
ribbonA.children.push(text);
text.parentElement = ribbonA;
assert.strictEqual(
  runtime.generaliseSelector(text, (selector) => queryAll(body, selector)),
  'p.ecommerce-product-ribbon__text'
);

// Just this element stays positional, including nth-of-type. Saved changes
// that already use that shape are not rewritten.
const unique = runtime.uniqueSelector(ribbonA, { body });
assert.ok(unique.indexOf(':nth-of-type(') !== -1, unique);
assert.ok(unique.indexOf('div.ecommerce-product-ribbon.is-visible') !== -1, unique);
assert.notStrictEqual(unique, suggested);

// Distinguishing class that is shared stays; a class shared with SALE badges
// does not replace it.
const news = [el('span', 'badge badge--new'), el('span', 'badge badge--new')];
const sale = el('span', 'badge badge--sale');
const group = el('div', 'grid', news.concat([sale]));
assert.strictEqual(
  runtime.generaliseSelector(news[0], (selector) => queryAll(group, selector)),
  'span.badge.badge--new'
);

// A class that matches only the picked element is dropped when another
// stable class matches several.
const lone = el('span', 'badge badge--new product-42');
const others = [el('span', 'badge'), el('span', 'badge')];
const mixed = el('div', '', [lone].concat(others));
assert.strictEqual(
  runtime.generaliseSelector(lone, (selector) => queryAll(mixed, selector)),
  'span.badge'
);

// No stable class: use the generated class rather than every div.
const hashed = [el('div', 'css-aabbcc'), el('div', 'css-aabbcc')];
const hashParent = el('section', '', hashed);
assert.strictEqual(
  runtime.generaliseSelector(hashed[0], (selector) => queryAll(hashParent, selector)),
  'div.css-aabbcc'
);

// No classes at all: tag scoped by the nearest ancestor that has a stable class.
const bareA = el('span', '');
const bareB = el('span', '');
const cardA = el('li', 'product-card is-active', [bareA]);
const cardB = el('li', 'product-card', [bareB]);
const cards = el('ul', '', [cardA, cardB]);
assert.strictEqual(
  runtime.generaliseSelector(bareA, (selector) => queryAll(cards, selector)),
  'li.product-card span'
);

// An id is a unique selector. The generalised one does not use it.
const named = el('a', 'cta', [], 'buy-now');
const namedSibling = el('a', 'cta');
const nav = el('nav', '', [named, namedSibling]);
assert.strictEqual(runtime.uniqueSelector(named, { body: el('body', '') }), '#buy-now');
assert.strictEqual(
  runtime.generaliseSelector(named, (selector) => queryAll(nav, selector)),
  'a.cta'
);

assert.strictEqual(
  runtime.cssForChange({ selector: 'span.badge', type: 'style', value: { backgroundColor: '#ff00aa', color: 'white' } }),
  'span.badge{background-color:#ff00aa !important;color:white !important}'
);
assert.strictEqual(runtime.cssForChange({ selector: 'span.badge', type: 'hide' }), 'span.badge{display:none !important}');
assert.strictEqual(runtime.cssForChange({ selector: 'span.badge:nth-of-type(2)', type: 'style', value: { color: 'red' } }), '');
assert.strictEqual(runtime.cssForChange({ selector: 'span.badge:nth-of-type(2)', type: 'hide' }), '');
assert.strictEqual(runtime.cssForChange({ type: 'stylesheet', selector: '', value: '.a{color:red}' }), '');

console.log('selector.test.js ok');
