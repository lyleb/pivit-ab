// An element goal converts when its CSS selector appears. The visitor is
// already in the test. The first check and a later DOM change both count,
// including a checkout that swaps the step and leaves the address alone.
// One conversion per visitor per goal, then the observer disconnects.
// Preview and the editor never start the watch. pivit_qa still uses the
// same conversion beacon, so the visit stays test traffic.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

const CONFIRM = '#step-confirmation';
const PAGE = 'https://site3-checkout.netlify.app/play';

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    data,
  };
}

function harness() {
  const observers = [];
  let selectors = {};
  function MutationObserver(cb) {
    this.cb = cb;
    this.dead = false;
    this.options = null;
    this.target = null;
  }
  MutationObserver.prototype.observe = function observe(target, options) {
    this.target = target;
    this.options = options;
    observers.push(this);
  };
  MutationObserver.prototype.disconnect = function disconnect() {
    this.dead = true;
  };
  const doc = {
    documentElement: { nodeType: 1 },
    querySelector(selector) {
      if (selector === '::bad') throw new Error('bad selector');
      return selectors[selector] || null;
    },
  };
  return {
    doc,
    MutationObserver,
    observers,
    setSelectors(map) { selectors = map || {}; },
    notify() {
      observers.forEach((observer) => {
        if (!observer.dead) observer.cb([]);
      });
    },
  };
}

function watch(page, goals, hooks) {
  const sent = [];
  const store = hooks && hooks.store ? hooks.store : memoryStore();
  const memory = hooks && hooks.memory ? hooks.memory : Object.create(null);
  const watcher = runtime.createElementWatcher(page.doc, {
    MutationObserver: page.MutationObserver,
    claim(goal) {
      return runtime.claimElement(store, goal.visitorId, goal.experimentId, goal.goalId, memory);
    },
    send(goal) { sent.push(goal.goalId); },
  });
  watcher.watch(goals);
  return { watcher, sent, store, memory };
}

const goals = [{
  experimentId: 'exp-play',
  variantId: 'variant-b',
  visitorId: 'v1',
  goalId: 'done',
  selector: CONFIRM,
}];

assert.deepStrictEqual(runtime.elementGoalsFrom([
  { type: 'element', selector: '  ' + CONFIRM + '  ', id: 'done' },
  { type: 'click', selector: '#pay-now', id: 'pay' },
  { selector: '#legacy', id: 'old' },
  { type: 'element', selector: '   ', id: 'blank' },
  { type: 'url', url_match: '/thanks', id: 'thanks' },
], { experimentId: 'exp-play', variantId: 'variant-b', visitorId: 'v1' }), [{
  experimentId: 'exp-play',
  variantId: 'variant-b',
  visitorId: 'v1',
  goalId: 'done',
  selector: CONFIRM,
}]);
assert.deepStrictEqual(runtime.clickGoalsFrom([
  { type: 'element', selector: CONFIRM, id: 'done' },
], { experimentId: 'exp-play' }), []);

// Already on the confirmation step: one conversion, and no observer is left running.
{
  const page = harness();
  page.setSelectors({ [CONFIRM]: { nodeType: 1 } });
  const result = watch(page, goals);
  assert.deepStrictEqual(result.sent, ['done']);
  assert.strictEqual(page.observers.length, 0);
  assert.strictEqual(result.store.getItem(runtime.elementStorageKey('v1', 'exp-play', 'done')), '1');
  result.watcher.watch(goals);
  assert.deepStrictEqual(result.sent, ['done']);
}

// The address stays on /play. The confirmation step is inserted later.
{
  const page = harness();
  const result = watch(page, goals);
  assert.deepStrictEqual(result.sent, []);
  assert.strictEqual(page.observers.length, 1);
  assert.deepStrictEqual(page.observers[0].options, { childList: true, subtree: true });
  assert.strictEqual(page.observers[0].target, page.doc.documentElement);
  page.notify();
  assert.deepStrictEqual(result.sent, []);
  assert.strictEqual(page.observers[0].dead, false);
  page.setSelectors({ [CONFIRM]: { nodeType: 1 } });
  page.notify();
  assert.deepStrictEqual(result.sent, ['done']);
  assert.strictEqual(page.observers[0].dead, true);
  page.notify();
  assert.deepStrictEqual(result.sent, ['done']);
}

// A later page load sees the stored claim and does not send again.
{
  const page = harness();
  page.setSelectors({ [CONFIRM]: { nodeType: 1 } });
  const store = memoryStore();
  store.setItem(runtime.elementStorageKey('v1', 'exp-play', 'done'), '1');
  const result = watch(page, goals, { store });
  assert.deepStrictEqual(result.sent, []);
  assert.strictEqual(page.observers.length, 0);
}

// A click on the same goal id does not use up the element conversion.
{
  const store = memoryStore();
  const memory = Object.create(null);
  assert.strictEqual(runtime.claimClick(store, 'v1', 'exp-play', 'done', memory), true);
  const page = harness();
  page.setSelectors({ [CONFIRM]: { nodeType: 1 } });
  const result = watch(page, goals, { store, memory });
  assert.deepStrictEqual(result.sent, ['done']);
}

// Another visitor, and another goal, each count once.
{
  const page = harness();
  page.setSelectors({ [CONFIRM]: { nodeType: 1 }, '#step-payment': { nodeType: 1 } });
  const result = watch(page, [
    goals[0],
    Object.assign({}, goals[0], { visitorId: 'v2', goalId: 'done' }),
    Object.assign({}, goals[0], { goalId: 'paid', selector: '#step-payment' }),
  ]);
  assert.deepStrictEqual(result.sent.sort(), ['done', 'done', 'paid']);
}

// One of two goals can appear first. The other keeps watching.
{
  const page = harness();
  const result = watch(page, [
    goals[0],
    Object.assign({}, goals[0], { goalId: 'paid', selector: '#step-payment' }),
  ]);
  page.setSelectors({ '#step-payment': { nodeType: 1 } });
  page.notify();
  assert.deepStrictEqual(result.sent, ['paid']);
  assert.strictEqual(page.observers[0].dead, false);
  page.setSelectors({ '#step-payment': { nodeType: 1 }, [CONFIRM]: { nodeType: 1 } });
  page.notify();
  assert.deepStrictEqual(result.sent, ['paid', 'done']);
  assert.strictEqual(page.observers[0].dead, true);
}

// A selector that cannot be queried never converts, and does not throw.
{
  const page = harness();
  const result = watch(page, [Object.assign({}, goals[0], { selector: '::bad', goalId: 'bad' })]);
  assert.deepStrictEqual(result.sent, []);
  assert.strictEqual(page.observers.length, 0);
}

// A second experiment can watch after the first one has disconnected.
{
  const page = harness();
  const result = watch(page, goals);
  page.setSelectors({ [CONFIRM]: { nodeType: 1 } });
  page.notify();
  assert.strictEqual(page.observers[0].dead, true);
  result.watcher.watch([Object.assign({}, goals[0], { experimentId: 'exp-other', goalId: 'other', selector: '#elsewhere' })]);
  assert.strictEqual(page.observers.length, 2);
  assert.strictEqual(page.observers[1].dead, false);
  page.setSelectors({ [CONFIRM]: { nodeType: 1 }, '#elsewhere': { nodeType: 1 } });
  page.notify();
  assert.deepStrictEqual(result.sent, ['done', 'other']);
  assert.strictEqual(page.observers[1].dead, true);
}

// No MutationObserver: an element that is already there still converts.
{
  const doc = {
    documentElement: { nodeType: 1 },
    querySelector(selector) { return selector === CONFIRM ? { nodeType: 1 } : null; },
  };
  const sent = [];
  const watcher = runtime.createElementWatcher(doc, {
    MutationObserver: null,
    claim() { return true; },
    send(goal) { sent.push(goal.goalId); },
  });
  watcher.watch(goals);
  assert.deepStrictEqual(sent, ['done']);
}

assert.strictEqual(runtime.claimElement(memoryStore(), 'v9', 'exp', 'done', Object.create(null)), true);
const blocked = Object.create(null);
const throwing = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};
assert.strictEqual(runtime.claimElement(throwing, 'v9', 'exp', 'done', blocked), true);
assert.strictEqual(runtime.claimElement(throwing, 'v9', 'exp', 'done', blocked), false);

const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const editor = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const help = fs.readFileSync(path.join(__dirname, '../public/help.html'), 'utf8');

assert.strictEqual(snippet.split('createElementWatcher(').length - 1, 2);
assert.strictEqual(snippet.split('wireConversionTracking(').length - 1, 2);
const wireSrc = snippet.slice(
  snippet.indexOf('function wireConversionTracking'),
  snippet.indexOf('function shouldCountUrlGoal')
);
assert.strictEqual(wireSrc.split('createElementWatcher(').length - 1, 1);
assert.ok(wireSrc.includes('elementGoalsFrom('));
assert.ok(wireSrc.includes('claimElement('));
assert.ok(wireSrc.includes("sendEvent(goal.experimentId, goal.variantId, goal.visitorId, 'convert', goal.goalId)"));
assert.ok(!wireSrc.includes('querySelectorAll'));

const init = snippet.slice(snippet.indexOf('async function init'));
const wireAt = init.indexOf('wireConversionTracking(');
assert.ok(init.indexOf("mode.type === 'edit'") < wireAt);
assert.ok(init.indexOf('if (wantsPreview)') < wireAt);
assert.strictEqual(init.split('wireConversionTracking(').length - 1, 1);
assert.ok(!editor.includes('createElementWatcher'));
assert.ok(!editor.includes('wireConversionTracking'));
assert.ok(editor.includes('When this appears'));
assert.ok(editor.includes("type: 'element'"));
assert.ok(editor.includes('The address does not have to change.'));

assert.ok(admin.includes('When this element appears'));
assert.ok(admin.includes('value="element"'));
assert.ok(admin.includes('#step-confirmation'));
assert.ok(admin.includes('wizard-goals-list'));
assert.ok(admin.includes('detail-goals-list'));
assert.ok(help.includes('id="element-goal"'));
assert.ok(help.includes('#step-confirmation'));
assert.ok(!help.includes('Pivitlab'));

assert.strictEqual(PAGE, 'https://site3-checkout.netlify.app/play');

console.log('element goal tests passed');
