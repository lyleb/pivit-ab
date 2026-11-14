// Text edits keep child elements, handlers, labels and focus. A style change
// does not strip attributes. Inserted HTML sits beside the element. Replacing
// HTML on a form or a button shows a plain warning.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

const editorSrc = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const WARNING = 'This element has a form or buttons. Replacing its HTML may stop them working. Edit the text instead?';
const NAME_WARNING = 'This button or link would have no name that a screen reader can read. Add some words, or keep a label on it.';

assert.strictEqual(runtime.REPLACE_HTML_WARNING, WARNING);
assert.strictEqual(runtime.ACCESSIBLE_NAME_WARNING, NAME_WARNING);
assert.ok(editorSrc.includes(WARNING));
assert.ok(editorSrc.includes(NAME_WARNING));
assert.ok(editorSrc.includes('onEditText'));
assert.ok(editorSrc.includes('accessibleNameWarning(el, value)'));
assert.ok(editorSrc.includes("case 'text': writeText(el, change.value)"));
assert.ok(!editorSrc.includes("case 'text': el.textContent"));

function textNode(value) {
  const node = { nodeType: 3, nodeValue: value, parentElement: null };
  return node;
}

function element(tag, attrs) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    children: [],
    attributes: Object.assign({}, attrs || {}),
    style: {},
    removed: [],
    listeners: { click: [] },
  };
  node.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null);
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.removeAttribute = (name) => { node.removed.push(name); delete node.attributes[name]; };
  node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
  node.querySelector = () => null;
  node.querySelectorAll = () => [];
  node.appendChild = (child) => {
    child.parentElement = node;
    node.childNodes.push(child);
    if (child.nodeType === 1) node.children.push(child);
    return child;
  };
  return node;
}

// A button with an icon and a handler keeps both when the words change.
{
  const clicks = [];
  const icon = element('svg');
  icon.addEventListener('click', () => clicks.push('icon'));
  const words = textNode(' Buy now');
  const button = element('button', { 'aria-label': 'Buy now', id: 'buy' });
  button.appendChild(icon);
  button.appendChild(words);
  button.onclick = () => clicks.push('button');
  const image = element('img', { alt: 'Basket' });
  button.appendChild(image);
  const doc = { activeElement: button, createTextNode(value) { return textNode(value); } };
  button.ownerDocument = doc;

  runtime.writeElementText(button, 'Add to bag');

  assert.strictEqual(words.nodeValue, 'Add to bag');
  assert.strictEqual(button.childNodes[0], icon);
  assert.strictEqual(button.childNodes[2], image);
  assert.strictEqual(button.getAttribute('aria-label'), 'Buy now');
  assert.strictEqual(image.getAttribute('alt'), 'Basket');
  assert.strictEqual(button.getAttribute('id'), 'buy');
  assert.deepStrictEqual(button.removed, []);
  assert.strictEqual(doc.activeElement, button);
  button.onclick();
  icon.listeners.click[0]();
  assert.deepStrictEqual(clicks, ['button', 'icon']);
}

// A link whose only words are in a child keeps that child and its handler.
{
  const clicks = [];
  const label = element('span');
  const words = textNode('Shop');
  label.appendChild(words);
  label.addEventListener('click', () => clicks.push('label'));
  const link = element('a', { href: '/shop', 'aria-label': 'Browse the shop' });
  link.appendChild(label);
  link.onclick = () => clicks.push('link');
  runtime.writeElementText(link, 'Browse');
  assert.strictEqual(words.nodeValue, 'Browse');
  assert.strictEqual(link.childNodes[0], label);
  assert.strictEqual(link.getAttribute('aria-label'), 'Browse the shop');
  assert.strictEqual(link.getAttribute('href'), '/shop');
  link.onclick();
  label.listeners.click[0]();
  assert.deepStrictEqual(clicks, ['link', 'label']);
  assert.strictEqual(runtime.accessibleNameWarning(link, ''), '');
  const bare = element('button');
  bare.appendChild(textNode('Go'));
  assert.strictEqual(runtime.accessibleNameWarning(bare, ''), NAME_WARNING);
  assert.strictEqual(runtime.accessibleNameWarning(bare, 'Go'), '');
}

function matchBuy(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  if (selector === 'button.buy') return node.tagName === 'BUTTON' && node.className === 'buy';
  if (selector === 'button:nth-of-type(1)') return node.tagName === 'BUTTON';
  return false;
}

function miniDocument() {
  const removed = [];
  function el(tag) {
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      children: [],
      childNodes: [],
      attributes: {},
      textContent: '',
      isConnected: false,
      parentElement: null,
      parentNode: null,
      style: {},
      listeners: {},
    };
    node.style.setProperty = (prop, value) => { node.style[prop] = value; };
    node.setAttribute = (name, value) => {
      node.attributes[name] = String(value);
      if (name === 'id') node.id = String(value);
      if (name === 'class') node.className = String(value);
    };
    node.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null);
    node.removeAttribute = (name) => { removed.push(name); delete node.attributes[name]; };
    node.matches = (selector) => matchBuy(node, selector);
    node.querySelectorAll = () => [];
    node.querySelector = () => null;
    node.contains = (other) => {
      let cursor = other;
      while (cursor) {
        if (cursor === node) return true;
        cursor = cursor.parentElement;
      }
      return false;
    };
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.appendChild = (child) => {
      if (child.parentElement && child.remove) child.remove();
      child.parentElement = node;
      child.parentNode = node;
      child.isConnected = true;
      node.children.push(child);
      node.childNodes.push(child);
      return child;
    };
    node.remove = () => {
      const parent = node.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
      const nodes = parent.childNodes.indexOf(node);
      if (nodes >= 0) parent.childNodes.splice(nodes, 1);
      node.parentElement = null;
      node.parentNode = null;
      node.isConnected = false;
    };
    node.insertAdjacentHTML = (where, html) => {
      assert.ok(where === 'beforebegin' || where === 'afterend');
      assert.ok(!html.includes(node.id));
      const block = el('p');
      block.className = 'note';
      block.textContent = 'Hello';
      block.setAttribute('class', 'note');
      const parent = node.parentElement;
      const index = parent.children.indexOf(node);
      const at = where === 'beforebegin' ? index : index + 1;
      parent.children.splice(at, 0, block);
      parent.childNodes.splice(at, 0, block);
      block.parentElement = parent;
      block.parentNode = parent;
      block.isConnected = true;
    };
    Object.defineProperty(node, 'innerHTML', {
      set() { throw new Error('insert must not replace innerHTML'); },
      get() { return ''; },
    });
    return node;
  }
  const doc = {
    nodeType: 9,
    createElement: el,
    createTextNode: (value) => ({ nodeType: 3, nodeValue: String(value), textContent: String(value) }),
    getElementById: () => null,
    querySelector: () => null,
  };
  const html = el('html');
  const head = el('head');
  const body = el('body');
  html.appendChild(head);
  html.appendChild(body);
  doc.documentElement = html;
  doc.head = head;
  doc.body = body;
  doc.querySelectorAll = (selector) => {
    const found = [];
    function walk(node) {
      if (node.nodeType === 1 && node.matches(selector)) found.push(node);
      (node.children || []).forEach(walk);
    }
    walk(body);
    return found;
  };
  const button = el('button');
  button.className = 'buy';
  button.setAttribute('class', 'buy');
  button.setAttribute('id', 'buy-now');
  button.setAttribute('aria-label', 'Buy now');
  button.style.fontSize = '16px';
  let clicks = 0;
  button.onclick = () => { clicks += 1; };
  const field = el('input');
  field.value = '2';
  field.setAttribute('name', 'qty');
  let inputs = 0;
  field.addEventListener('input', () => { inputs += 1; });
  button.appendChild(field);
  body.appendChild(button);
  return {
    doc,
    button,
    field,
    removed,
    clicks: () => clicks,
    inputs: () => inputs,
  };
}

{
  const page = miniDocument();
  const applier = runtime.createApplier(page.doc, { setTimeout() { return 0; }, clearTimeout() {} });
  applier.applyOne({ selector: 'button.buy', type: 'style', value: { color: 'red', cssText: 'color:blue' } }, 'style');
  assert.strictEqual(page.button.style.color, undefined);
  assert.strictEqual(page.button.style.fontSize, '16px');
  assert.strictEqual(page.button.getAttribute('id'), 'buy-now');
  assert.strictEqual(page.button.getAttribute('aria-label'), 'Buy now');
  assert.strictEqual(page.button.getAttribute('class'), 'buy');
  assert.ok(page.doc.head.children.some((node) => node.tagName === 'STYLE'));
  assert.deepStrictEqual(page.removed, []);
  page.button.onclick();
  assert.strictEqual(page.clicks(), 1);
}

{
  const page = miniDocument();
  const applier = runtime.createApplier(page.doc, { setTimeout() { return 0; }, clearTimeout() {} });
  applier.applyOne({ selector: 'button:nth-of-type(1)', type: 'style', value: { color: 'red', cssText: 'display:none' } }, 'inline');
  assert.strictEqual(page.button.style.color, 'red');
  assert.strictEqual(page.button.style.fontSize, '16px');
  assert.strictEqual(page.button.style.cssText, undefined);
  assert.strictEqual(page.button.getAttribute('aria-label'), 'Buy now');
  assert.strictEqual(page.button.getAttribute('id'), 'buy-now');
  assert.ok(!page.removed.includes('aria-label'));
  assert.ok(!page.removed.includes('id'));
  assert.ok(!page.removed.includes('class'));
}

{
  const page = miniDocument();
  const applier = runtime.createApplier(page.doc, { setTimeout() { return 0; }, clearTimeout() {} });
  const before = page.button;
  const field = page.field;
  applier.applyOne({ selector: 'button.buy', type: 'insert_before', value: '<p class="note">Hello</p>' }, 'insert');
  assert.strictEqual(page.doc.body.children[1], before);
  assert.strictEqual(page.doc.body.children[0].textContent, 'Hello');
  assert.strictEqual(before.childNodes[0], field);
  assert.strictEqual(field.value, '2');
  assert.strictEqual(before.getAttribute('aria-label'), 'Buy now');
  field.listeners.input[0]();
  before.onclick();
  assert.strictEqual(page.inputs(), 1);
  assert.strictEqual(page.clicks(), 1);
  applier.disconnect();
}

{
  const form = element('form');
  const input = element('input');
  form.appendChild(input);
  form.querySelector = (selector) => (selector.includes('input') ? input : null);
  assert.strictEqual(runtime.replaceHtmlWarning(form), WARNING);
  const card = element('div');
  const button = element('button');
  button.onclick = function () {};
  card.children = [button];
  card.querySelector = () => button;
  assert.strictEqual(runtime.replaceHtmlWarning(card), WARNING);
  const link = element('a', { href: '/cart' });
  assert.strictEqual(runtime.replaceHtmlWarning(link), WARNING);
  const heading = element('h1');
  heading.querySelector = () => null;
  assert.strictEqual(runtime.replaceHtmlWarning(heading), '');
  assert.strictEqual(runtime.accessibleNameWarningForHtml('<button class="buy"></button>'), NAME_WARNING);
  assert.strictEqual(runtime.accessibleNameWarningForHtml('<a href="/cart"></a>'), NAME_WARNING);
  assert.strictEqual(runtime.accessibleNameWarningForHtml('<button aria-label="Buy now"></button>'), '');
  assert.strictEqual(runtime.accessibleNameWarningForHtml('<h1>Hello</h1>'), '');
}

console.log('safe edit tests passed');
