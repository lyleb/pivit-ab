const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    data,
  };
}

function matchCompound(node, compound) {
  const match = String(compound).match(/^([a-zA-Z0-9-]*)?(#[A-Za-z0-9_-]+)?((?:\.[A-Za-z0-9_-]+)*)$/);
  if (!match || compound === '' || (!match[1] && !match[2] && !match[3])) {
    throw new Error('invalid selector');
  }
  const tag = match[1];
  const id = match[2];
  const classes = match[3];
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  if (id && node.id !== id.slice(1)) return false;
  if (classes) {
    const want = classes.slice(1).split('.');
    const have = String(node.className || '').split(/\s+/);
    if (!want.every((cls) => have.indexOf(cls) !== -1)) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  const parts = String(selector).trim().split(/\s+/);
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (ancestor && ancestor.nodeType === 1 && !matchCompound(ancestor, parts[i])) {
      ancestor = ancestor.parentElement;
    }
    if (!ancestor || ancestor.nodeType !== 1) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function createPage() {
  const docListeners = [];
  function createEl(tag, props) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: (props && props.id) || '',
      className: (props && props.className) || '',
      children: [],
      parentElement: null,
      listeners: [],
    };
    el.matches = (selector) => matchesSelector(el, selector);
    el.addEventListener = (type, fn, capture) => {
      el.listeners.push({ type: type, fn: fn, capture: capture === true });
    };
    el.appendChild = (child) => {
      if (child.parentElement) child.remove();
      child.parentElement = el;
      el.children.push(child);
      return child;
    };
    el.remove = () => {
      const parent = el.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(el);
      if (index >= 0) parent.children.splice(index, 1);
      el.parentElement = null;
    };
    return el;
  }
  const body = createEl('body');
  const doc = {
    nodeType: 9,
    body: body,
    addEventListener(type, fn, capture) {
      docListeners.push({ type: type, fn: fn, capture: capture === true });
    },
  };
  body.parentElement = doc;
  function dispatch(target) {
    const event = {
      type: 'click',
      target: target,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    const capture = docListeners.filter((listener) => listener.type === 'click' && listener.capture);
    capture.forEach((listener) => listener.fn(event));
    if (!event.propagationStopped) {
      let node = target;
      while (node && node.nodeType === 1) {
        const bubble = node.listeners.filter((listener) => listener.type === 'click' && !listener.capture);
        bubble.forEach((listener) => listener.fn(event));
        if (event.propagationStopped) break;
        node = node.parentElement;
      }
    }
    return event;
  }
  return { doc: doc, body: body, el: createEl, dispatch: dispatch, docListeners: docListeners };
}

function trackerFor(doc, store, mem, sent, order) {
  return runtime.createClickTracker(doc, {
    claim(goal, event) {
      if (event) {
        assert.strictEqual(event.defaultPrevented, false);
        assert.strictEqual(event.propagationStopped, false);
      }
      return runtime.claimClick(store, goal.visitorId, goal.experimentId, goal.goalId, mem);
    },
    send(goal) {
      sent.push({ goalId: goal.goalId, experimentId: goal.experimentId, variantId: goal.variantId });
      if (order) order.push('beacon');
    },
  });
}

// --- Which goals are click goals ---

const picked = runtime.clickGoalsFrom([
  { type: 'click', selector: '#pay-now', id: 'pay', name: 'Pay now' },
  { type: 'url', url_match: '/thanks', id: 'thanks' },
  { selector: '.buy', id: 'legacy' },
  { type: 'click', selector: '', id: 'blank' },
  { type: 'click', id: 'missing' },
], { experimentId: 'exp', variantId: 'var', visitorId: 'v1' });
assert.deepStrictEqual(picked.map((goal) => goal.goalId), ['pay', 'legacy']);
assert.strictEqual(picked[0].selector, '#pay-now');
assert.strictEqual(picked[0].visitorId, 'v1');
assert.deepStrictEqual(runtime.clickGoalsFrom(null, {}), []);
const unnamed = runtime.clickGoalsFrom(
  [{ type: 'click', selector: '.hero' }],
  { experimentId: 'exp', variantId: 'var', visitorId: 'v1' }
);
assert.strictEqual(unnamed[0].goalId, '.hero');

// --- A button that is already on the page still converts, once ---

{
  const page = createPage();
  const store = memoryStore();
  const sent = [];
  const button = page.el('button', { id: 'buy', className: 'button' });
  page.body.appendChild(button);
  const tracker = trackerFor(page.doc, store, {}, sent);
  tracker.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: '#buy', id: 'buy' }],
    { experimentId: 'exp', variantId: 'var-b', visitorId: 'v1' }
  ));
  assert.strictEqual(button.listeners.length, 0);
  const event = page.dispatch(button);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].goalId, 'buy');
  assert.strictEqual(sent[0].variantId, 'var-b');
  assert.strictEqual(event.defaultPrevented, false);
  page.dispatch(button);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(store.data[runtime.clickStorageKey('v1', 'exp', 'buy')], '1');
}

// --- Pay now, added at a later checkout step. The address never changes ---

{
  const page = createPage();
  const store = memoryStore();
  const sent = [];
  const order = [];
  const tracker = trackerFor(page.doc, store, {}, sent, order);
  tracker.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: '#pay-now', id: 'pay' }],
    { experimentId: 'checkout', variantId: 'var-b', visitorId: 'v1' }
  ));
  const pay = page.el('button', { id: 'pay-now', className: 'button' });
  page.body.appendChild(pay);
  assert.strictEqual(pay.listeners.length, 0);
  pay.addEventListener('click', () => {
    order.push('step');
    pay.remove();
  });
  const event = page.dispatch(pay);
  assert.deepStrictEqual(order, ['beacon', 'step']);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].goalId, 'pay');
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(pay.parentElement, null);
  const again = page.el('button', { id: 'pay-now', className: 'button' });
  page.body.appendChild(again);
  page.dispatch(again);
  assert.strictEqual(sent.length, 1);
}

// --- A React render replaces the button. The new node still converts ---

{
  const page = createPage();
  const store = memoryStore();
  const sent = [];
  const tracker = trackerFor(page.doc, store, {}, sent);
  const first = page.el('button', { id: 'add-to-basket', className: 'button add-to-basket' });
  page.body.appendChild(first);
  tracker.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: '#add-to-basket', id: 'add' }],
    { experimentId: 'shop', variantId: 'var-b', visitorId: 'v1' }
  ));
  assert.strictEqual(first.listeners.length, 0);
  first.remove();
  const second = page.el('button', { id: 'add-to-basket', className: 'button add-to-basket' });
  page.body.appendChild(second);
  assert.strictEqual(second.listeners.length, 0);
  page.dispatch(second);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].goalId, 'add');
  second.remove();
  const third = page.el('button', { id: 'add-to-basket', className: 'button add-to-basket' });
  page.body.appendChild(third);
  page.dispatch(third);
  assert.strictEqual(sent.length, 1);
}

// --- A click on a child of the goal element converts. A click outside does not ---

{
  const page = createPage();
  const store = memoryStore();
  const sent = [];
  const tracker = trackerFor(page.doc, store, {}, sent);
  const button = page.el('button', { id: 'pay-now', className: 'button' });
  const label = page.el('span', { className: 'label' });
  const icon = page.el('span', { className: 'icon' });
  button.appendChild(label);
  label.appendChild(icon);
  page.body.appendChild(button);
  const other = page.el('button', { id: 'back-to-details', className: 'button button-quiet' });
  page.body.appendChild(other);
  tracker.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: '#pay-now', id: 'pay' }],
    { experimentId: 'checkout', variantId: 'var-b', visitorId: 'v1' }
  ));
  const text = { nodeType: 3, parentElement: icon };
  page.dispatch(text);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].goalId, 'pay');
  assert.strictEqual(runtime.clickGoalElement({ target: icon }, '#pay-now').id, 'pay-now');
  page.dispatch(other);
  assert.strictEqual(sent.length, 1);
}

// A goal on the inner icon does not convert when the click is the button around it.
{
  const page = createPage();
  const sent = [];
  const button = page.el('button', { id: 'pay-now', className: 'button' });
  const icon = page.el('span', { className: 'icon' });
  button.appendChild(icon);
  page.body.appendChild(button);
  const store = memoryStore();
  const mem = {};
  const tracker = runtime.createClickTracker(page.doc, {
    claim(goal) { return runtime.claimClick(store, goal.visitorId, goal.experimentId, goal.goalId, mem); },
    send(goal) { sent.push(goal.goalId); },
  });
  tracker.track([{ selector: 'span.icon', goalId: 'icon', experimentId: 'checkout', variantId: 'var-b', visitorId: 'v9' }]);
  page.dispatch(button);
  assert.deepStrictEqual(sent, []);
  page.dispatch(icon);
  assert.deepStrictEqual(sent, ['icon']);
  page.dispatch(icon);
  assert.deepStrictEqual(sent, ['icon']);
}

// --- One beacon per visitor per goal, including when the goal is registered twice ---

{
  const page = createPage();
  const store = memoryStore();
  const mem = {};
  const sent = [];
  const button = page.el('button', { id: 'pay-now', className: 'button' });
  const icon = page.el('span', { className: 'icon' });
  button.appendChild(icon);
  page.body.appendChild(button);
  const goals = runtime.clickGoalsFrom(
    [
      { type: 'click', selector: '#pay-now', id: 'pay' },
      { type: 'click', selector: '.quiet', id: 'other' },
    ],
    { experimentId: 'checkout', variantId: 'var-b', visitorId: 'v1' }
  );
  const tracker = trackerFor(page.doc, store, mem, sent);
  tracker.track(goals);
  tracker.track(goals);
  page.dispatch(icon);
  page.dispatch(button);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].goalId, 'pay');
  const otherVisitor = [];
  const other = runtime.createClickTracker(page.doc, {
    claim(goal) { return runtime.claimClick(store, goal.visitorId, goal.experimentId, goal.goalId, mem); },
    send(goal) { otherVisitor.push(goal.goalId); },
  });
  other.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: '#pay-now', id: 'pay' }],
    { experimentId: 'checkout', variantId: 'var-b', visitorId: 'v2' }
  ));
  page.dispatch(button);
  assert.deepStrictEqual(otherVisitor, ['pay']);
  assert.strictEqual(sent.length, 1);
}

// --- A link still navigates. The beacon is sent with the click, before the page handler ---

{
  const page = createPage();
  const store = memoryStore();
  const sent = [];
  const order = [];
  const tracker = trackerFor(page.doc, store, {}, sent, order);
  const link = page.el('a', { className: 'button', id: 'leave' });
  const label = page.el('span', { className: 'label' });
  link.appendChild(label);
  page.body.appendChild(link);
  let navigated = false;
  link.addEventListener('click', (event) => {
    order.push('navigate');
    assert.strictEqual(event.defaultPrevented, false);
    navigated = true;
  });
  tracker.track(runtime.clickGoalsFrom(
    [{ type: 'click', selector: 'a.button', id: 'leave' }],
    { experimentId: 'exp', variantId: 'var-b', visitorId: 'v1' }
  ));
  const event = page.dispatch(label);
  assert.deepStrictEqual(order, ['beacon', 'navigate']);
  assert.strictEqual(navigated, true);
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(event.propagationStopped, false);
  assert.strictEqual(sent.length, 1);
}

// A client-side route cancels the browser's navigation after the beacon has gone.
{
  const page = createPage();
  const sent = [];
  const order = [];
  const tracker = trackerFor(page.doc, memoryStore(), {}, sent, order);
  const link = page.el('a', { className: 'button', id: 'shop' });
  page.body.appendChild(link);
  link.addEventListener('click', (event) => {
    order.push('route');
    event.preventDefault();
  });
  tracker.track([{ selector: 'a.button', goalId: 'shop', experimentId: 'exp', variantId: 'var-b', visitorId: 'v1' }]);
  const event = page.dispatch(link);
  assert.deepStrictEqual(order, ['beacon', 'route']);
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(sent.length, 1);
}

// --- A bad selector does not swallow a click on another goal ---

{
  const page = createPage();
  const sent = [];
  const button = page.el('button', { id: 'pay-now' });
  page.body.appendChild(button);
  const tracker = runtime.createClickTracker(page.doc, {
    claim() { return true; },
    send(goal) { sent.push(goal.goalId); },
  });
  tracker.track([
    { selector: '[', goalId: 'broken', experimentId: 'exp', variantId: 'var-b', visitorId: 'v1' },
    { selector: '#pay-now', goalId: 'pay', experimentId: 'exp', variantId: 'var-b', visitorId: 'v1' },
  ]);
  assert.strictEqual(runtime.clickGoalElement({ target: button }, '['), null);
  page.dispatch(button);
  assert.deepStrictEqual(sent, ['pay']);
}

// --- One capture listener for every goal enrolled on the page ---

{
  const page = createPage();
  const sent = [];
  const store = memoryStore();
  const mem = {};
  const tracker = runtime.createClickTracker(page.doc, {
    claim(goal, event) {
      assert.strictEqual(event.defaultPrevented, false);
      return runtime.claimClick(store, goal.visitorId, goal.experimentId, goal.goalId, mem);
    },
    send(goal) { sent.push(goal.experimentId + ':' + goal.goalId); },
  });
  tracker.track([]);
  assert.strictEqual(page.docListeners.length, 0);
  const button = page.el('button', { className: 'button', id: 'pay-now' });
  page.body.appendChild(button);
  tracker.track([
    { selector: '#pay-now', goalId: 'pay', experimentId: 'one', variantId: 'a', visitorId: 'v1' },
  ]);
  tracker.track([
    { selector: '#pay-now', goalId: 'pay', experimentId: 'two', variantId: 'b', visitorId: 'v1' },
  ]);
  assert.strictEqual(page.docListeners.length, 1);
  assert.strictEqual(page.docListeners[0].capture, true);
  assert.strictEqual(page.docListeners[0].type, 'click');
  page.dispatch(button);
  assert.deepStrictEqual(sent, ['one:pay', 'two:pay']);
  page.dispatch(button);
  assert.deepStrictEqual(sent, ['one:pay', 'two:pay']);
}

// A retargeted shadow click still finds the button inside the root.
{
  const host = { nodeType: 1, id: 'host', className: '', parentElement: null, matches() { return false; } };
  const button = { nodeType: 1, id: 'pay-now', className: 'button', parentElement: null, matches(selector) { return selector === '#pay-now'; } };
  const icon = { nodeType: 1, id: '', className: 'icon', parentElement: null, matches() { return false; } };
  const found = runtime.clickGoalElement({
    target: host,
    composedPath() { return [icon, button, host]; },
  }, '#pay-now');
  assert.strictEqual(found, button);
  assert.strictEqual(runtime.clickGoalElement({ target: host }, '#pay-now'), null);
}

// --- The editor and preview never reach the listener ---

const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const init = snippet.slice(snippet.indexOf('async function init'));
const wireAt = init.indexOf('wireConversionTracking(');
assert.ok(wireAt > 0);
assert.ok(init.indexOf("mode.type === 'edit'") < wireAt);
assert.ok(init.indexOf('if (wantsPreview)') < wireAt);
assert.ok(init.indexOf('if (devicePreview)') < wireAt);
assert.strictEqual(init.split('wireConversionTracking(').length - 1, 1);

const wireSrc = snippet.slice(
  snippet.indexOf('function wireConversionTracking'),
  snippet.indexOf('function shouldCountUrlGoal')
);
assert.ok(wireSrc.includes('clickGoalsFrom('));
assert.ok(wireSrc.includes('createClickTracker('));
assert.ok(wireSrc.includes('claimClick('));
assert.ok(wireSrc.includes("'convert'"));
assert.ok(!wireSrc.includes('querySelectorAll'));

const trackerSrc = snippet.slice(
  snippet.indexOf('function createClickTracker'),
  snippet.indexOf('function stripEdge')
);
assert.ok(trackerSrc.includes("doc.addEventListener('click', onClick, true)"));
assert.ok(!trackerSrc.includes('preventDefault('));
assert.ok(!trackerSrc.includes('stopPropagation('));

const editor = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
assert.ok(!editor.includes('wireConversionTracking'));
assert.ok(!editor.includes('createClickTracker'));
assert.ok(editor.includes('e.preventDefault()'));
assert.ok(editor.includes('e.stopPropagation()'));

console.log('click goal tests passed');
