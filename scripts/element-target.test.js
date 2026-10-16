// Element targeting. The URL rule still has to match. The snippet buckets a
// visitor, applies the variant, and sends a view only once the CSS selector
// is on the page. Present, late, and never are the three outcomes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');
const urlMatch = require('../public/url-match');
const selectors = require('../src/element-selector');
const preview = require('../src/preview-access');

assert.strictEqual(runtime.ELEMENT_WAIT_MS >= 3000 && runtime.ELEMENT_WAIT_MS <= 5000, true);
assert.strictEqual(runtime.ELEMENT_WAIT_MS, 4000);

assert.strictEqual(selectors.normaliseElementSelector(null).selector, null);
assert.strictEqual(selectors.normaliseElementSelector('').selector, null);
assert.strictEqual(selectors.normaliseElementSelector('  button[name="add"]  ').selector, 'button[name="add"]');
assert.strictEqual(selectors.normaliseElementSelector('.product-form__submit').selector, '.product-form__submit');
assert.strictEqual(selectors.normaliseElementSelector('button[name="add"], .product-form__submit').ok, true);
assert.strictEqual(selectors.normaliseElementSelector(12).ok, false);
assert.strictEqual(selectors.normaliseElementSelector('a'.repeat(501)).ok, false);
assert.strictEqual(selectors.normaliseElementSelector('div { color: red }').ok, false);
assert.strictEqual(selectors.normaliseElementSelector('<button>').ok, false);

assert.strictEqual(runtime.elementSelectorOf({}), '');
assert.strictEqual(runtime.elementSelectorOf({ element_selector: '  .product-form__submit  ' }), '.product-form__submit');
assert.strictEqual(runtime.elementIsPresent({ querySelector: () => null }, ''), true);
assert.strictEqual(runtime.elementIsPresent({ querySelector: () => null }, 'button[name="add"]'), false);
assert.strictEqual(runtime.elementIsPresent({ querySelector: () => ({ nodeType: 1 }) }, 'button[name="add"]'), true);
assert.strictEqual(runtime.elementQuery({ querySelector: () => { throw new Error('bad'); } }, '::bad').state, 'invalid');

function harness() {
  let node = null;
  const observers = [];
  let timer = null;
  let cleared = 0;
  function MutationObserver(cb) {
    this.cb = cb;
    this.dead = false;
    this.options = null;
  }
  MutationObserver.prototype.observe = function observe(target, options) {
    this.options = options;
    observers.push(this);
  };
  MutationObserver.prototype.disconnect = function disconnect() {
    this.dead = true;
  };
  const doc = {
    documentElement: { nodeType: 1 },
    querySelector() { return node; },
  };
  return {
    doc,
    MutationObserver,
    observers,
    setNode(value) { node = value; },
    notify() {
      observers.forEach((observer) => {
        if (!observer.dead) observer.cb([{ type: 'childList', addedNodes: node ? [node] : [] }]);
      });
    },
    setTimer(fn) { timer = fn; return 7; },
    clearTimer() { cleared += 1; },
    fireTimer() {
      const fn = timer;
      timer = null;
      fn();
    },
    cleared() { return cleared; },
  };
}

function exposure(experiment, h) {
  const calls = [];
  const pending = runtime.exposeWhenReady(experiment, {
    document: h.doc,
    MutationObserver: h.MutationObserver,
    setTimer: (fn) => h.setTimer(fn),
    clearTimer: () => h.clearTimer(),
    timeoutMs: runtime.ELEMENT_WAIT_MS,
    onExpose() {
      // This is the bucket: assignment, the variant, and the view.
      calls.push({ assigned: experiment.id, event: 'view' });
    },
  });
  return { calls, pending };
}

async function main() {
  const present = harness();
  present.setNode({ nodeType: 1, name: 'add' });
  const already = exposure({ id: 'tee', element_selector: 'button[name="add"]' }, present);
  const alreadyResult = await already.pending;
  assert.strictEqual(alreadyResult.exposed, true);
  assert.strictEqual(alreadyResult.reason, 'present');
  assert.strictEqual(alreadyResult.selector, 'button[name="add"]');
  assert.deepStrictEqual(already.calls, [{ assigned: 'tee', event: 'view' }]);
  assert.strictEqual(present.observers.length, 0);

  const late = harness();
  const lateRun = exposure({ id: 'tee', element_selector: '.product-form__submit' }, late);
  assert.deepStrictEqual(lateRun.calls, []);
  assert.strictEqual(late.observers.length, 1);
  assert.deepStrictEqual(late.observers[0].options, { childList: true, subtree: true });
  late.setNode({ nodeType: 1, name: 'submit' });
  late.notify();
  const lateResult = await lateRun.pending;
  assert.strictEqual(lateResult.exposed, true);
  assert.strictEqual(lateResult.reason, 'appeared');
  assert.deepStrictEqual(lateRun.calls, [{ assigned: 'tee', event: 'view' }]);
  assert.strictEqual(late.observers[0].dead, true);
  assert.ok(late.cleared() >= 1);

  const never = harness();
  const neverRun = exposure({ id: 'tee', element_selector: 'button[name="add"]' }, never);
  assert.deepStrictEqual(neverRun.calls, []);
  never.fireTimer();
  const neverResult = await neverRun.pending;
  assert.strictEqual(neverResult.exposed, false);
  assert.strictEqual(neverResult.reason, 'timeout');
  assert.deepStrictEqual(neverRun.calls, []);
  assert.strictEqual(never.observers[0].dead, true);

  const open = harness();
  let waited = false;
  const openResult = await runtime.exposeWhenReady({ id: 'home', element_selector: '' }, {
    document: open.doc,
    setTimer() { waited = true; return 1; },
    onExpose() { waited = 'exposed'; },
  });
  assert.strictEqual(openResult.exposed, true);
  assert.strictEqual(openResult.reason, 'none');
  assert.strictEqual(waited, 'exposed');

  const invalid = harness();
  invalid.doc.querySelector = () => { throw new Error('bad selector'); };
  let invalidExposed = false;
  const invalidResult = await runtime.exposeWhenReady({ id: 'tee', element_selector: '::bad' }, {
    document: invalid.doc,
    MutationObserver: invalid.MutationObserver,
    setTimer() { throw new Error('invalid selectors must not wait'); },
    onExpose() { invalidExposed = true; },
  });
  assert.strictEqual(invalidResult.exposed, false);
  assert.strictEqual(invalidResult.reason, 'invalid');
  assert.strictEqual(invalidExposed, false);

  const shown = runtime.previewInfo(
    { name: 'T-shirt social proof', element_selector: 'button[name="add"]' },
    { name: 'Social proof' },
    { found: true, reason: 'present' }
  );
  assert.ok(shown.includes('button[name="add"]'));
  assert.ok(shown.includes('Social proof'));
  assert.ok(shown.includes('T-shirt social proof'));
  assert.ok(shown.includes('No events are being logged.'));
  const missed = runtime.previewInfo(
    { name: 'T-shirt social proof', element_selector: 'button[name="add"]' },
    { name: 'Social proof' },
    { found: false, reason: 'timeout' }
  );
  assert.ok(missed.includes('no element matching'));
  assert.ok(missed.includes('nothing is applied'));
  assert.ok(missed.includes('button[name="add"]'));
  const plain = runtime.previewInfo({ name: 'Headline' }, { name: 'Control' }, { found: true });
  assert.strictEqual(
    plain,
    '[ab] preview mode — showing variant "Control" for experiment "Headline". No events are being logged.'
  );

  const note = urlMatch.previewElementNote('button[name="add"]');
  assert.ok(note.includes("button[name=\"add\"]"));
  assert.ok(note.includes('only runs when'));
  assert.ok(note.includes('never appears'));
  assert.strictEqual(urlMatch.previewElementNote('  '), '');
  assert.strictEqual(
    urlMatch.previewUrlWarning('/pricing', 'https://example.com/about', 'contains'),
    "This page doesn't match the test's URL rule (contains '/pricing'), so visitors here won't see the test."
  );

  const listed = preview.buildPublicExperimentList({
    running: [{
      id: 'exp-tee',
      name: 'T-shirt social proof',
      url_match: 'https://cantsaythat.co.uk',
      element_selector: ' button[name="add"] ',
      goals: [],
    }],
    variants: [{
      id: 'on',
      experiment_id: 'exp-tee',
      name: 'Social proof',
      traffic_split: 50,
      changes: [],
      goals: [],
      enabled: true,
    }],
  });
  assert.strictEqual(listed.experiments[0].element_selector, 'button[name="add"]');
  const bare = preview.buildPublicExperimentList({
    running: [{ id: 'exp-home', name: 'Home', url_match: '/', goals: [] }],
    variants: [],
  });
  assert.strictEqual(bare.experiments[0].element_selector, '');

  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/element-selector.js'), 'utf8');
  const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(!schema.includes('element_selector'), 'element_selector must not be added in schema.sql');
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS element_selector TEXT'));
  assert.ok(!/NOT NULL/.test(migration.split('ADD COLUMN')[1] || ''));
  assert.ok(migrateSrc.includes("{ version: '012', name: 'element-selector', run: applyElementSelector }"));

  const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(admin.includes('id="wizard-element"'));
  assert.ok(admin.includes('id="settings-element"'));
  assert.ok(admin.includes('Only run when this element is on the page'));
  assert.ok(admin.includes('button[name="add"]'));
  assert.ok(admin.includes('.product-form__submit'));
  assert.ok(admin.includes('The URL rule still applies.'));
  assert.ok(admin.includes('id="wizard-element-note"'));
  assert.ok(admin.includes('id="manage-element-note"'));
  assert.ok(admin.includes('id="detail-element-note"'));
  assert.ok(admin.includes('previewElementNote'));

  const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
  const init = snippet.slice(snippet.indexOf('async function init'));
  const gate = init.indexOf('api.elementQuery(document, selector)');
  const enroll = init.indexOf('function enroll(experiment)');
  const send = init.indexOf('sendEvent(', enroll);
  const wait = init.indexOf('api.exposeWhenReady(experiment');
  assert.ok(gate !== -1 && enroll !== -1 && send !== -1 && wait !== -1);
  assert.ok(gate < send);
  assert.ok(wait > enroll);

  console.log('element-target tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
