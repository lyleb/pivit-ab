// Start the test when an element appears. The visitor is assigned, the
// variant is applied, and the view is sent only once that element is in the
// document. The watch has no four-second limit. A visitor who never sees the
// element is not counted. page_load, including the older element_selector
// wait, stays as it was.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');
const activation = require('../src/activation');
const preview = require('../src/preview-access');
const urlMatch = require('../public/url-match');

const PAY = 'https://site3-checkout.netlify.app/play';

assert.strictEqual(activation.normaliseActivation(undefined, undefined).type, 'page_load');
assert.strictEqual(activation.normaliseActivation(undefined, '#step-payment').value, null);
assert.strictEqual(activation.normaliseActivation('page_load', '#step-payment').value, null);
assert.strictEqual(activation.normaliseActivation('element', '  #step-payment  ').value, '#step-payment');
assert.strictEqual(activation.normaliseActivation('element', '').ok, false);
assert.ok(activation.normaliseActivation('element', '').error.includes('CSS selector'));
assert.strictEqual(activation.normaliseActivation('element', '   ').ok, false);
assert.strictEqual(activation.normaliseActivation('later', '#step-payment').ok, false);
assert.strictEqual(activation.normaliseActivation('element', 'div { color: red }').ok, false);
assert.ok(activation.normaliseActivation('element', 'div { color: red }').error.includes('#step-payment'));
assert.strictEqual(activation.normaliseActivation('element', '<section>').ok, false);
assert.strictEqual(activation.normaliseActivation('element', 'a'.repeat(501)).ok, false);
assert.ok(activation.normaliseActivation('element', 'a'.repeat(501)).error.includes('too long'));

assert.deepStrictEqual(runtime.activationOf({}), { type: 'page_load', selector: '' });
assert.deepStrictEqual(runtime.activationOf({ activation_type: 'element', activation_value: ' #step-payment ' }), {
  type: 'element',
  selector: '#step-payment',
});
assert.strictEqual(runtime.activationOf({ activation_type: 'element', activation_value: '' }).selector, '');
assert.strictEqual(runtime.activationQuery({ querySelector: () => null }, {
  activation_type: 'element',
  activation_value: '#step-payment',
}).state, 'missing');
assert.strictEqual(runtime.activationQuery({ querySelector: () => ({ nodeType: 1 }) }, {
  activation_type: 'element',
  activation_value: '#step-payment',
}).state, 'present');
assert.strictEqual(runtime.activationQuery({ querySelector: () => { throw new Error('bad'); } }, {
  activation_type: 'element',
  activation_value: '::bad',
}).state, 'invalid');

const shown = runtime.previewInfo(
  { name: 'Checkout', activation_type: 'element', activation_value: '#step-payment' },
  { name: 'Offer' },
  { found: true }
);
assert.ok(shown.includes('#step-payment'));
assert.ok(shown.includes('without waiting'));
assert.ok(shown.includes('No events are being logged.'));
assert.strictEqual(runtime.previewWaits({
  activation_type: 'element',
  activation_value: '#step-payment',
}).waitForElementRule, false);
assert.strictEqual(runtime.previewWaits({
  activation_type: 'element',
  activation_value: '#step-payment',
  element_selector: '#pay-now',
}).waitForElementRule, true);
const plain = runtime.previewInfo({ name: 'Headline' }, { name: 'Control' }, { found: true });
assert.strictEqual(
  plain,
  '[ab] preview mode — showing variant "Control" for experiment "Headline". No events are being logged.'
);

const note = urlMatch.previewActivationNote('element', '#step-payment');
assert.ok(note.includes('#step-payment'));
assert.ok(note.includes('straight away'));
assert.strictEqual(urlMatch.previewActivationNote('page_load', '#step-payment'), '');

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    data,
  };
}

function harness() {
  let node = null;
  const observers = [];
  let timers = 0;
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
    querySelector(selector) {
      if (selector === '::bad') throw new Error('bad selector');
      return node && node.selectors && node.selectors[selector] ? node.selectors[selector] : null;
    },
  };
  return {
    doc,
    MutationObserver,
    observers,
    setSelectors(map) { node = { selectors: map }; },
    clear() { node = null; },
    notify() {
      observers.forEach((observer) => {
        if (!observer.dead) observer.cb([]);
      });
    },
    setTimer() { timers += 1; return timers; },
    timers() { return timers; },
  };
}

function experiment(extra) {
  return Object.assign({
    id: 'exp-pay',
    name: 'Payment step',
    activation_type: 'element',
    activation_value: '#step-payment',
    variants: [
      { id: 'control', name: 'Control', traffic_split: 50, changes: [] },
      { id: 'variant-b', name: 'Offer', traffic_split: 50, changes: [{ type: 'banner', text: 'In the draw' }] },
    ],
    goals: [{ id: 'pay', type: 'click', selector: '#pay-now' }],
  }, extra || {});
}

function memoryClickPage() {
  const docListeners = [];
  function createEl(tag, fields) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      id: (fields && fields.id) || '',
      className: (fields && fields.className) || '',
      nodeType: 1,
      parentElement: null,
      listeners: [],
      matches(selector) {
        if (selector === '#' + node.id) return true;
        return false;
      },
    };
    return node;
  }
  const body = createEl('body');
  const doc = {
    nodeType: 9,
    body,
    addEventListener(type, fn, capture) {
      docListeners.push({ type, fn, capture: capture === true });
    },
  };
  body.parentElement = doc;
  function dispatch(target) {
    const event = { type: 'click', target, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
    docListeners.filter((listener) => listener.type === 'click' && listener.capture)
      .forEach((listener) => listener.fn(event));
    return event;
  }
  return { doc, el: createEl, dispatch };
}

async function main() {
  const late = harness();
  const lateCalls = [];
  let lateSettled = false;
  const latePending = runtime.exposeWhenReady(experiment(), {
    document: late.doc,
    MutationObserver: late.MutationObserver,
    setTimer() { throw new Error('an element start must not use the four-second timer'); },
    onExpose() { lateCalls.push('expose'); },
  }).then((result) => {
    lateSettled = true;
    return result;
  });
  assert.strictEqual(late.observers.length, 1);
  assert.deepStrictEqual(late.observers[0].options, { childList: true, subtree: true });
  late.notify();
  await Promise.resolve();
  assert.strictEqual(lateSettled, false);
  assert.deepStrictEqual(lateCalls, []);
  late.setSelectors({ '#step-payment': { nodeType: 1 } });
  late.notify();
  const lateResult = await latePending;
  assert.strictEqual(lateResult.exposed, true);
  assert.strictEqual(lateResult.reason, 'appeared');
  assert.deepStrictEqual(lateCalls, ['expose']);
  assert.strictEqual(late.observers[0].dead, true);
  late.notify();
  assert.deepStrictEqual(lateCalls, ['expose']);

  const never = harness();
  const neverCalls = [];
  let neverSettled = false;
  runtime.exposeWhenReady(experiment(), {
    document: never.doc,
    MutationObserver: never.MutationObserver,
    setTimer() { throw new Error('an element start must not time out'); },
    onExpose() { neverCalls.push('expose'); },
  }).then(() => { neverSettled = true; });
  never.notify();
  await Promise.resolve();
  assert.strictEqual(neverSettled, false);
  assert.deepStrictEqual(neverCalls, []);

  const both = harness();
  const bothCalls = [];
  const bothPending = runtime.exposeWhenReady(experiment({ element_selector: '#pay-now' }), {
    document: both.doc,
    MutationObserver: both.MutationObserver,
    setTimer() { throw new Error('both rules wait for the visit, not four seconds'); },
    onExpose() { bothCalls.push('expose'); },
  });
  both.setSelectors({ '#step-payment': { nodeType: 1 } });
  both.notify();
  await Promise.resolve();
  assert.deepStrictEqual(bothCalls, []);
  both.setSelectors({ '#step-payment': { nodeType: 1 }, '#pay-now': { nodeType: 1 } });
  both.notify();
  const bothResult = await bothPending;
  assert.strictEqual(bothResult.exposed, true);
  assert.deepStrictEqual(bothCalls, ['expose']);

  const invalidCalls = [];
  const invalid = await runtime.exposeWhenReady(experiment({ activation_value: '::bad' }), {
    document: harness().doc,
    MutationObserver: harness().MutationObserver,
    setTimer() { throw new Error('an invalid selector must not wait'); },
    onExpose() { invalidCalls.push('expose'); },
  });
  assert.strictEqual(invalid.exposed, false);
  assert.strictEqual(invalid.reason, 'invalid');
  assert.deepStrictEqual(invalidCalls, []);

  const storage = memoryStore();
  const views = [];
  const wires = [];
  const reports = [];
  const applies = [];
  const ga4Sent = Object.create(null);
  const missingDoc = { querySelector() { return null; } };
  const presentDoc = {
    querySelector(selector) {
      return selector === '#step-payment' || selector === '#pay-now' ? { nodeType: 1 } : null;
    },
  };
  function enrol(doc, href, applied, qaOn) {
    return runtime.applyMatchingExperiments({
      experiments: [experiment()],
      href,
      document: doc,
      storage,
      visitorId: 'v_pt_checkout',
      qaOn: !!qaOn,
      applied: applied || Object.create(null),
      apply(variant) {
        applies.push(variant.id);
        return { ok: true };
      },
      send(experimentId, variantId, visitorId, eventType) {
        views.push(runtime.eventBody({
          experiment_id: experimentId,
          variant_id: variantId,
          visitor_id: visitorId,
          event_type: eventType,
        }, !!qaOn));
      },
      wire(experimentId, variantId, visitorId, goals) {
        wires.push({ experimentId, variantId, visitorId, goals });
      },
      report(exp, href) {
        const planned = runtime.planExperienceImpressions({
          experiments: [exp],
          assignments: { [exp.id]: storage.getItem('_ab_assign_' + exp.id) },
          pageKey: runtime.pageViewKey(href),
          sent: ga4Sent,
          ga4: { measurement_id: 'G-CHECKOUT1' },
          consentAllows: true,
          transport: 'gtag',
          preview: false,
          testTraffic: !!qaOn,
        });
        runtime.markImpressionsSent(ga4Sent, planned.events);
        reports.push(planned.events.length);
      },
    });
  }

  const applied = Object.create(null);
  const hidden = enrol(missingDoc, PAY, applied, true);
  assert.strictEqual(hidden.waiting.length, 1);
  assert.strictEqual(hidden.views.length, 0);
  assert.deepStrictEqual(views, []);
  assert.deepStrictEqual(applies, []);
  assert.deepStrictEqual(wires, []);
  assert.strictEqual(storage.getItem('_ab_assign_exp-pay'), null);

  const seen = enrol(presentDoc, PAY, applied, true);
  assert.strictEqual(seen.views.length, 1);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].is_test, true);
  assert.strictEqual(views[0].event_type, 'view');
  assert.strictEqual(applies.length, 1);
  assert.strictEqual(wires.length, 1);
  assert.strictEqual(wires[0].goals[0].selector, '#pay-now');
  assert.deepStrictEqual(reports, [0]);
  const assigned = storage.getItem('_ab_assign_exp-pay');
  assert.ok(assigned === 'control' || assigned === 'variant-b');
  assert.strictEqual(runtime.assignVariant(experiment(), 'v_pt_checkout').id, assigned);

  const again = enrol(presentDoc, PAY, applied, true);
  assert.strictEqual(again.views.length, 0);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(applies.length, 1);
  assert.strictEqual(wires.length, 1);

  const liveStorage = memoryStore();
  const liveReports = [];
  const liveSent = Object.create(null);
  const liveApplied = Object.create(null);
  function reportLive(exp, href) {
    const planned = runtime.planExperienceImpressions({
      experiments: [exp],
      assignments: { [exp.id]: liveStorage.getItem('_ab_assign_' + exp.id) },
      pageKey: runtime.pageViewKey(href),
      sent: liveSent,
      ga4: { measurement_id: 'G-CHECKOUT1' },
      consentAllows: true,
      transport: 'dataLayer',
      preview: false,
      testTraffic: false,
    });
    runtime.sendPlannedImpressions({ dataLayer: liveReports, gtag() {} }, planned, liveSent, {});
  }
  runtime.applyMatchingExperiments({
    experiments: [experiment()],
    href: PAY,
    document: presentDoc,
    storage: liveStorage,
    visitorId: 'visitor-live',
    qaOn: false,
    applied: liveApplied,
    apply() { return { ok: true }; },
    send() {},
    wire() {},
    report: reportLive,
  });
  runtime.applyMatchingExperiments({
    experiments: [experiment()],
    href: PAY,
    document: presentDoc,
    storage: liveStorage,
    visitorId: 'visitor-live',
    applied: liveApplied,
    apply() { throw new Error('applied twice'); },
    send() { throw new Error('viewed twice'); },
    wire() { throw new Error('wired twice'); },
    report() { throw new Error('reported twice'); },
  });
  reportLive(experiment(), PAY);
  assert.strictEqual(liveReports.length, 1);
  assert.strictEqual(liveReports[0].event, 'experience_impression');
  assert.ok(liveReports[0].exp_variant_string.includes('Payment step'));

  const page = memoryClickPage();
  const button = page.el('button', { id: 'pay-now' });
  const clickStore = memoryStore();
  const clicked = [];
  const tracker = runtime.createClickTracker(page.doc, {
    claim(goal) {
      return runtime.claimClick(clickStore, goal.visitorId, goal.experimentId, goal.goalId);
    },
    send(goal) { clicked.push(goal.goalId); },
  });
  page.dispatch(button);
  assert.deepStrictEqual(clicked, []);
  tracker.track(runtime.clickGoalsFrom(wires[0].goals, {
    experimentId: wires[0].experimentId,
    variantId: wires[0].variantId,
    visitorId: wires[0].visitorId,
  }));
  page.dispatch(button);
  page.dispatch(button);
  assert.deepStrictEqual(clicked, ['pay']);

  const session = runtime.createActivationSession();
  const route = harness();
  let href = PAY + '#step-basket';
  const routeViews = [];
  const routeApplied = Object.create(null);
  session.arm(experiment(), {
    document: route.doc,
    href,
    MutationObserver: route.MutationObserver,
    currentHref() { return href; },
    onExpose() {
      runtime.applyMatchingExperiments({
        experiments: [experiment()],
        href,
        document: route.doc,
        storage: memoryStore(),
        visitorId: 'visitor-spa',
        applied: routeApplied,
        apply() { return { ok: true }; },
        send() { routeViews.push(href); },
        wire() {},
        report() {},
      });
    },
  });
  href = PAY + '#step-details';
  route.setSelectors({ '#step-payment': { nodeType: 1 } });
  route.notify();
  await Promise.resolve();
  assert.deepStrictEqual(routeViews, []);

  const payment = harness();
  href = PAY + '#step-payment';
  session.retain({});
  session.arm(experiment(), {
    document: payment.doc,
    href,
    MutationObserver: payment.MutationObserver,
    currentHref() { return href; },
    onExpose() {
      runtime.applyMatchingExperiments({
        experiments: [experiment()],
        href,
        document: payment.doc,
        storage: memoryStore(),
        visitorId: 'visitor-spa',
        applied: routeApplied,
        apply() { return { ok: true }; },
        send() { routeViews.push('payment'); },
        wire() {},
        report() {},
      });
    },
  });
  const delivered = runtime.deliverNavigation({
    experiments: [experiment()],
    href,
    document: { querySelector() { return null; } },
    storage: memoryStore(),
    visitorId: 'visitor-spa',
    applied: Object.create(null),
    apply() { throw new Error('applied before the element'); },
    send() { throw new Error('viewed before the element'); },
    wire() {},
    reportOne() {},
    reportAll() {},
  });
  assert.strictEqual(delivered.waiting.length, 1);
  assert.strictEqual(delivered.views.length, 0);
  payment.setSelectors({ '#step-payment': { nodeType: 1 } });
  payment.notify();
  await Promise.resolve();
  assert.deepStrictEqual(routeViews, ['payment']);
  payment.notify();
  await Promise.resolve();
  assert.deepStrictEqual(routeViews, ['payment']);

  let control = 0;
  let challenger = 0;
  let skipped = 0;
  for (let i = 0; i < 2000; i += 1) {
    const visitorId = 'visitor-' + i;
    if (i % 5 === 0) {
      skipped += 1;
      const quiet = memoryStore();
      const missed = runtime.applyMatchingExperiments({
        experiments: [experiment()],
        href: PAY,
        document: missingDoc,
        storage: quiet,
        visitorId,
        applied: Object.create(null),
        apply() { throw new Error('skipped visitor was applied'); },
        send() { throw new Error('skipped visitor was viewed'); },
        wire() {},
        report() {},
      });
      assert.strictEqual(missed.views.length, 0);
      assert.strictEqual(quiet.getItem('_ab_assign_exp-pay'), null);
      continue;
    }
    const store = memoryStore();
    runtime.applyMatchingExperiments({
      experiments: [experiment()],
      href: PAY,
      document: presentDoc,
      storage: store,
      visitorId,
      applied: Object.create(null),
      apply() { return { ok: true }; },
      send() {},
      wire() {},
      report() {},
    });
    const variantId = store.getItem('_ab_assign_exp-pay');
    assert.strictEqual(variantId, runtime.assignVariant(experiment(), visitorId).id);
    if (variantId === 'control') control += 1;
    else if (variantId === 'variant-b') challenger += 1;
    else throw new Error('unexpected variant ' + variantId);
  }
  assert.strictEqual(skipped, 400);
  assert.strictEqual(control + challenger, 1600);
  assert.ok(Math.abs(control - 800) < 120, 'control ' + control);
  assert.ok(Math.abs(challenger - 800) < 120, 'challenger ' + challenger);

  const ids = {};
  function makeEl(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      style: {},
      parentElement: null,
      textContent: '',
      attributes: {},
      setAttribute(name, value) {
        node.attributes[name] = String(value);
        if (name === 'id') node.id = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
      },
      appendChild(child) {
        child.parentElement = node;
        node.children.push(child);
        return child;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    let id = '';
    Object.defineProperty(node, 'id', {
      configurable: true,
      get() { return id; },
      set(value) {
        id = value || '';
        if (id) ids[id] = node;
      },
    });
    return node;
  }
  const head = makeEl('head');
  const body = makeEl('body');
  const documentElement = makeEl('html');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const bannerDoc = {
    documentElement,
    head,
    body,
    createElement: makeEl,
    getElementById(id) { return ids[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const applier = runtime.createApplier(bannerDoc, {
    MutationObserver: null,
    schedule(fn) { fn(); },
  });
  const banner = { type: 'banner', text: 'In the draw', position: 'top', sticky: false };
  applier.applyAll([banner], 'variant-b');
  applier.applyAll([banner], 'variant-b');
  const bars = body.children.filter((node) => node.id === 'pivit-banner');
  assert.strictEqual(bars.length, 1);

  const listed = preview.buildPublicExperimentList({
    running: [{
      id: 'exp-pay',
      name: 'Payment step',
      url_match: PAY,
      element_selector: null,
      activation_type: 'element',
      activation_value: ' #step-payment ',
      goals: [],
    }],
    variants: [],
  });
  assert.strictEqual(listed.experiments[0].activation_type, 'element');
  assert.strictEqual(listed.experiments[0].activation_value, '#step-payment');
  const untouched = preview.buildPublicExperimentList({
    running: [{ id: 'exp-home', name: 'Home', url_match: '/', goals: [] }],
    variants: [],
  });
  assert.strictEqual(untouched.experiments[0].activation_type, 'page_load');
  assert.strictEqual(untouched.experiments[0].activation_value, '');

  const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const editor = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/activation.js'), 'utf8');
  assert.ok(admin.includes('id="wizard-activation"'));
  assert.ok(admin.includes('id="settings-activation"'));
  assert.ok(admin.includes('Start the test when…'));
  assert.ok(admin.includes('the page loads'));
  assert.ok(admin.includes('this element appears'));
  assert.ok(admin.includes('#step-payment'));
  assert.ok(admin.includes('Visitors who never see it are left out.'));
  assert.ok(!editor.includes('activation_type'));
  assert.ok(!schema.includes('activation_type'));
  assert.ok(migration.includes("DEFAULT 'page_load'"));
  assert.ok(migration.includes('activation_value TEXT'));
  const editAt = snippet.indexOf("mode.type === 'edit'");
  const armAt = snippet.indexOf('activationSession.arm');
  assert.ok(editAt !== -1 && armAt !== -1 && editAt < armAt);
  const watchStart = snippet.indexOf('function watchWaiting');
  const watchEnd = snippet.indexOf('const first = applyMatchingExperiments');
  const watch = snippet.slice(watchStart, watchEnd);
  assert.ok(watch.includes('qaOn: qaOn'));
  assert.ok(watch.includes('activationSession.arm'));
  assert.ok(!watch.includes('sendEvent('));
  const reportFn = snippet.slice(
    snippet.indexOf('function reportExperienceImpressions'),
    snippet.indexOf('function reportGa4FromConsent')
  );
  assert.ok(reportFn.includes('activationQuery'));
  const previewStart = snippet.indexOf('const match = data.preview');
  const previewEnd = snippet.indexOf('if (!hasTrackingConsent())', previewStart);
  const previewBlock = snippet.slice(previewStart, previewEnd);
  assert.ok(previewBlock.includes('elementSelectorOf'));
  assert.ok(previewBlock.includes('waitForElement(document, selector)'));
  assert.ok(!previewBlock.includes('forever'));

  console.log('activation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
