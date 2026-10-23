// Single-page address changes: enrol a newly matching test once, convert a
// URL goal once, and do not send a second view or a second GA4 impression
// for the same address. data-spa="off" leaves that re-check off.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');

const ORIGIN = 'https://site2-spa.netlify.app';

function memoryStore() {
  const data = Object.create(null);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) { data[key] = String(value); },
    data,
  };
}

function assignmentsFrom(storage) {
  const out = Object.create(null);
  Object.keys(storage.data).forEach((key) => {
    if (key.indexOf('_ab_assign_') === 0) out[key.slice('_ab_assign_'.length)] = storage.data[key];
  });
  return out;
}

function fakeTimers() {
  let next = 1;
  const queue = [];
  return {
    set(fn, ms) {
      const id = next++;
      queue.push({ id, fn, ms });
      return id;
    },
    clear(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    flush(ms) {
      const due = queue.filter((item) => item.ms <= ms);
      due.forEach((item) => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
      });
      due.forEach((item) => item.fn());
    },
    pending() { return queue.length; },
  };
}

function fakeBrowser(start) {
  const listeners = {};
  const win = {
    location: { href: start },
    history: {
      pushState(_state, _title, url) {
        win.location.href = new URL(url, win.location.href).toString();
      },
      replaceState(_state, _title, url) {
        win.location.href = new URL(url, win.location.href).toString();
      },
    },
    addEventListener(name, fn) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(fn);
    },
  };
  win.emit = (name) => (listeners[name] || []).forEach((fn) => fn());
  return win;
}

function scriptAttr(value) {
  return {
    getAttribute(name) {
      if (name === 'data-spa') return value;
      return null;
    },
  };
}

function createDocument() {
  function createEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      children: [],
      attributes: {},
      style: {},
      textContent: '',
    };
    el.setAttribute = (name, value) => {
      el.attributes[name] = String(value);
      if (name === 'id') el.id = String(value);
    };
    el.getAttribute = (name) => (
      Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null
    );
    el.removeAttribute = (name) => { delete el.attributes[name]; };
    el.appendChild = (child) => { el.children.push(child); return child; };
    el.matches = () => false;
    el.querySelectorAll = () => [];
    return el;
  }
  const title = createEl('h1');
  title.id = 'product-title';
  title.attributes.id = 'product-title';
  title.textContent = 'Oak Leaf T-shirt';
  title.matches = (selector) => selector === '#product-title' || selector === 'h1';
  const doc = {
    nodeType: 9,
    __runs: 0,
    __other: 0,
    createElement: createEl,
    getElementById(id) { return id === title.id ? title : null; },
    querySelector(selector) { return title.matches(selector) ? title : null; },
    querySelectorAll(selector) { return title.matches(selector) ? [title] : []; },
  };
  doc.documentElement = createEl('html');
  doc.head = createEl('head');
  doc.body = createEl('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.body.appendChild(title);
  return { doc, title };
}

function productExperiment() {
  return {
    id: 'exp-products',
    name: 'Product headline',
    goals: [
      { type: 'url', url_match: '/thank-you', id: 'thanks' },
      { type: 'click', selector: '#add-to-basket', id: 'add' },
    ],
    variants: [{
      id: 'var-b',
      name: 'B',
      traffic_split: 100,
      changes: [
        { selector: '#product-title', type: 'text', value: 'Sale oak' },
        { type: 'page_js', value: 'document.__runs = (document.__runs || 0) + 1' },
      ],
    }],
  };
}

function experimentsFor(href) {
  const key = runtime.pageViewKey(href);
  if (key.indexOf('/products') === 0) return [productExperiment()];
  return [];
}

assert.strictEqual(runtime.SPA_DEBOUNCE_MS, 100);
assert.strictEqual(runtime.spaNavigationEnabled(null), true);
assert.strictEqual(runtime.spaNavigationEnabled(scriptAttr(null)), true);
assert.strictEqual(runtime.spaNavigationEnabled(scriptAttr('')), true);
assert.strictEqual(runtime.spaNavigationEnabled(scriptAttr('on')), true);
assert.strictEqual(runtime.spaNavigationEnabled(scriptAttr('off')), false);
assert.strictEqual(runtime.spaNavigationEnabled(scriptAttr(' OFF ')), false);
assert.strictEqual(runtime.spaRecheckAllowed({ type: null }, null), true);
assert.strictEqual(runtime.spaRecheckAllowed({ type: 'edit', variantId: 'var-b' }, null), false);
assert.strictEqual(runtime.spaRecheckAllowed({ type: 'preview', variantId: 'var-b' }, null), false);
assert.strictEqual(runtime.spaRecheckAllowed({ type: null }, scriptAttr('off')), false);

const edited = runtime.modeFromHref(`${ORIGIN}/products/oak?ab_edit=old&token=t1&ab_edit=new&token=t2`);
assert.strictEqual(edited.type, 'edit');
assert.strictEqual(edited.variantId, 'new');
assert.strictEqual(edited.token, 't2');
const previewed = runtime.modeFromHref(`${ORIGIN}/products/oak?ab_edit=old&token=t1&ab_preview=var-b&ab_preview_token=preview-token`);
assert.strictEqual(previewed.type, 'preview');
assert.strictEqual(previewed.variantId, 'var-b');
assert.strictEqual(previewed.token, 'preview-token');
assert.strictEqual(runtime.modeFromHref(`${ORIGIN}/shop`).type, null);

const siteKey = 'site_3d0cac8eb8af8111a82b97012b9b50c8b3ac';
const tagged = runtime.publicExperimentsUrl(`${ORIGIN}/thank-you`, true, 'https://pivitlab.com', siteKey);
assert.ok(tagged.indexOf('https://pivitlab.com/api/experiments?url=') === 0);
assert.ok(tagged.indexOf(encodeURIComponent(`${ORIGIN}/thank-you`)) !== -1);
assert.ok(tagged.indexOf('pivit_qa=1') !== -1);
assert.ok(tagged.indexOf('site=' + siteKey) !== -1);
const untagged = runtime.publicExperimentsUrl(`${ORIGIN}/shop`, false, 'https://pivitlab.com', '');
assert.ok(untagged.indexOf('pivit_qa') === -1);
assert.ok(untagged.indexOf('site=') === -1);

const gate = runtime.createNavigationGate();
const firstToken = gate.start();
const secondToken = gate.start();
assert.strictEqual(gate.current(firstToken, `${ORIGIN}/products/oak`, `${ORIGIN}/products/oak`), false);
assert.strictEqual(gate.current(secondToken, `${ORIGIN}/thank-you`, `${ORIGIN}/products/oak`), false);
assert.strictEqual(gate.current(secondToken, `${ORIGIN}/thank-you`, `${ORIGIN}/thank-you`), true);

const { doc, title } = createDocument();
const storage = memoryStore();
const applied = Object.create(null);
const events = [];
const fetches = [];
const wired = [];
const impressions = [];
const sentBook = Object.create(null);
let applies = 0;
const ga4Win = {
  gtag(_kind, name, params) { impressions.push({ name, page: params && params.page_key, id: params && params.experiment_id }); },
};
const applier = runtime.createApplier(doc, {
  schedule: (fn) => fn(),
  MutationObserver: function Observer() {
    return { observe() {}, disconnect() {}, takeRecords() { return []; } };
  },
});

function reportList(experiments, href) {
  const planned = runtime.planExperienceImpressions({
    experiments,
    assignments: assignmentsFrom(storage),
    pageKey: runtime.pageViewKey(href),
    sent: sentBook,
    ga4: { measurement_id: 'G-TEST1234' },
    consentAllows: true,
    transport: 'gtag',
    preview: false,
    testTraffic: false,
  });
  return runtime.sendPlannedImpressions(ga4Win, planned, sentBook, {});
}

function deliver(href, experiments, enrolledThisView) {
  return runtime.deliverNavigation({
    experiments: experiments || [],
    href,
    document: doc,
    storage,
    visitorId: 'visitor-spa',
    qaOn: true,
    applied,
    enrolledThisView,
    apply(variant) {
      applies += 1;
      return applier.applyAll(variant.changes || [], variant.id || 'variant');
    },
    send(experimentId, variantId, visitorId, eventType, goalId, changeApplied) {
      events.push({ experimentId, variantId, visitorId, eventType, goalId, changeApplied });
    },
    wire(experimentId, variantId, visitorId, goals) {
      wired.push({ experimentId, variantId, visitorId, goals });
    },
    reportOne(experiment, pageHref) { reportList([experiment], pageHref); },
    reportAll(experimentsOnPage, pageHref) { reportList(experimentsOnPage, pageHref); },
  });
}

function convertFor(href, enrolledThisView) {
  const goalExperiments = assignmentsFrom(storage)['exp-products'] ? [productExperiment()] : [];
  const planned = runtime.planUrlConversions(goalExperiments, assignmentsFrom(storage), href, enrolledThisView);
  planned.forEach((item) => {
    if (storage.getItem(item.key)) return;
    storage.setItem(item.key, '1');
    events.push({
      experimentId: item.experimentId,
      variantId: item.variantId,
      eventType: 'convert',
      goalId: item.goalId,
    });
  });
}

const win = fakeBrowser(`${ORIGIN}/shop`);
const timers = fakeTimers();
const installed = runtime.startSpaRecheck(win, {
  initialHref: win.location.href,
  debounceMs: runtime.SPA_DEBOUNCE_MS,
  setTimer: timers.set,
  clearTimer: timers.clear,
  applied,
  onNavigate(href) {
    const mode = runtime.modeFromHref(href);
    if (mode.type === 'edit' || mode.type === 'preview') return;
    fetches.push(href);
    const delivered = deliver(href, experimentsFor(href));
    convertFor(href, delivered.enrolledThisView);
  },
});
assert.strictEqual(installed.enabled, true);

function views() { return events.filter((event) => event.eventType === 'view'); }
function converts() { return events.filter((event) => event.eventType === 'convert'); }

// The address did not change. Nothing is fetched.
win.history.pushState({}, '', '/shop');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.deepStrictEqual(fetches, []);
assert.strictEqual(timers.pending(), 0);

// Five address writes in one turn collapse to the last one.
win.history.pushState({}, '', '/a');
win.history.pushState({}, '', '/b');
win.history.pushState({}, '', '/c');
win.history.pushState({}, '', '/products/oak-leaf-t-shirt-blue');
win.history.pushState({}, '', '/products/oak-leaf-t-shirt-blue?size=m');
assert.deepStrictEqual(fetches, []);
assert.strictEqual(timers.pending(), 1);
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(fetches.length, 1);
assert.ok(fetches[0].endsWith('/products/oak-leaf-t-shirt-blue?size=m'));
assert.strictEqual(title.textContent, 'Sale oak');
assert.strictEqual(doc.__runs, 1);
assert.strictEqual(applies, 1);
assert.strictEqual(views().length, 1);
assert.strictEqual(views()[0].experimentId, 'exp-products');
assert.strictEqual(views()[0].variantId, 'var-b');
assert.strictEqual(views()[0].changeApplied, true);
assert.strictEqual(impressions.length, 1);
assert.strictEqual(impressions[0].name, 'experience_impression');
assert.strictEqual(impressions[0].id, 'exp-products');
assert.strictEqual(wired.length, 1);
assert.ok(wired[0].goals.some((goal) => goal.selector === '#add-to-basket'));
assert.strictEqual(converts().length, 0);
assert.strictEqual(storage.getItem('_ab_assign_exp-products'), 'var-b');

// The same address again is not a change, so nothing is sent again.
win.history.pushState({}, '', '/products/oak-leaf-t-shirt-blue?size=m');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(fetches.length, 1);
assert.strictEqual(views().length, 1);
assert.strictEqual(impressions.length, 1);
assert.strictEqual(doc.__runs, 1);
assert.strictEqual(applies, 1);

// A second delivery of the same payload, as a late response might attempt,
// still does not view, apply, or tell GA4 again.
deliver(fetches[0], experimentsFor(fetches[0]));
assert.strictEqual(views().length, 1);
assert.strictEqual(impressions.length, 1);
assert.strictEqual(wired.length, 1);
assert.strictEqual(doc.__runs, 1);
assert.strictEqual(applies, 1);
applier.applyAll(productExperiment().variants[0].changes, 'var-b');
assert.strictEqual(doc.__runs, 1);

// replaceState to another matching address keeps the test applied.
win.history.replaceState({}, '', '/products/oak-leaf-t-shirt-blue?size=l');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(fetches.length, 2);
assert.ok(fetches[1].endsWith('/products/oak-leaf-t-shirt-blue?size=l'));
assert.strictEqual(views().length, 1);
assert.strictEqual(applies, 1);
assert.strictEqual(doc.__runs, 1);
assert.strictEqual(impressions.length, 2);

// pushState onto the goal page converts once. The test stays applied.
win.history.pushState({}, '', '/thank-you');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(converts().length, 1);
assert.strictEqual(converts()[0].goalId, 'thanks');
assert.strictEqual(converts()[0].experimentId, 'exp-products');
assert.strictEqual(views().length, 1);
assert.strictEqual(title.textContent, 'Sale oak');

win.history.pushState({}, '', '/basket');
timers.flush(runtime.SPA_DEBOUNCE_MS);
win.history.pushState({}, '', '/thank-you');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(converts().length, 1);

// Back to the goal page, and a hash change, still convert once.
win.location.href = `${ORIGIN}/thank-you`;
win.emit('popstate');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(converts().length, 1);
win.location.href = `${ORIGIN}/thank-you#order`;
win.emit('hashchange');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.ok(fetches[fetches.length - 1].endsWith('/thank-you#order'));
assert.strictEqual(converts().length, 1);
assert.strictEqual(views().length, 1);
assert.strictEqual(doc.__runs, 1);

// A client-side move onto an edit link is not tracked.
const beforeEdit = fetches.length;
win.history.pushState({}, '', '/products/oak?ab_edit=var-b&token=edit-token');
timers.flush(runtime.SPA_DEBOUNCE_MS);
assert.strictEqual(fetches.length, beforeEdit);
assert.strictEqual(views().length, 1);

// Landing on the goal URL and being enrolled there does not convert.
const thanksExperiment = {
  id: 'exp-thanks',
  name: 'Thanks',
  goals: [{ type: 'url', url_match: '/thank-you', id: 'landed' }],
  variants: [{ id: 'var-c', name: 'C', traffic_split: 100, changes: [] }],
};
const thanksStore = memoryStore();
const thanksApplied = Object.create(null);
const thanksEvents = [];
const thanksDelivery = runtime.deliverNavigation({
  experiments: [thanksExperiment],
  href: `${ORIGIN}/thank-you`,
  document: doc,
  storage: thanksStore,
  visitorId: 'visitor-spa',
  qaOn: false,
  applied: thanksApplied,
  apply() { return { ok: null }; },
  send() { thanksEvents.push('view'); },
  wire() {},
  reportOne() {},
  reportAll() {},
});
const thanksAssigned = assignmentsFrom(thanksStore);
assert.strictEqual(thanksAssigned['exp-thanks'], 'var-c');
assert.strictEqual(thanksEvents.length, 1);
assert.strictEqual(
  runtime.planUrlConversions([thanksExperiment], thanksAssigned, `${ORIGIN}/thank-you`, thanksDelivery.enrolledThisView).length,
  0
);
assert.strictEqual(
  runtime.planUrlConversions([thanksExperiment], thanksAssigned, `${ORIGIN}/thank-you`, {}).length,
  1
);
const later = runtime.planUrlConversions([thanksExperiment], thanksAssigned, `${ORIGIN}/thank-you`, {});
assert.strictEqual(later.length, 1);
thanksStore.setItem(later[0].key, '1');
const again = runtime.planUrlConversions([thanksExperiment], thanksAssigned, `${ORIGIN}/thank-you`, {});
assert.strictEqual(again.length, 1);
assert.strictEqual(thanksStore.getItem(again[0].key), '1');

// A demo test is still test traffic only. pivit_qa enrols it. A real visitor does not.
const demo = {
  id: 'exp-demo',
  name: 'Demo',
  test_type: 'demo',
  variants: [{ id: 'var-d', name: 'D', traffic_split: 100, changes: [] }],
};
function tryDemo(visitorId, qaOn) {
  const demoEvents = [];
  const demoApplied = Object.create(null);
  runtime.applyMatchingExperiments({
    experiments: [demo],
    href: `${ORIGIN}/products/oak`,
    document: doc,
    storage: memoryStore(),
    visitorId,
    qaOn,
    applied: demoApplied,
    apply() { return { ok: null }; },
    send() { demoEvents.push('view'); },
    wire() {},
    report() {},
  });
  return demoEvents.length;
}
assert.strictEqual(tryDemo('visitor-real', false), 0);
assert.strictEqual(tryDemo('visitor-real', true), 1);
assert.strictEqual(tryDemo('v_pt_spa', false), 1);

// An element that is not on the page yet is not viewed or applied.
const waitingDoc = { querySelector() { return null; } };
const waitingEvents = [];
const waiting = runtime.applyMatchingExperiments({
  experiments: [{
    id: 'exp-wait',
    name: 'Wait',
    element_selector: '#pay-now',
    variants: [{ id: 'var-w', name: 'W', traffic_split: 100, changes: [{ selector: '#pay-now', type: 'text', value: 'Pay' }] }],
  }],
  href: `${ORIGIN}/basket`,
  document: waitingDoc,
  storage: memoryStore(),
  visitorId: 'visitor-spa',
  applied: Object.create(null),
  apply() { throw new Error('applied too early'); },
  send() { waitingEvents.push('view'); },
  wire() {},
  report() {},
});
assert.strictEqual(waiting.waiting.length, 1);
assert.strictEqual(waiting.views.length, 0);
assert.strictEqual(waitingEvents.length, 0);

// A second experiment on the same document runs its own page JavaScript once.
runtime.applyMatchingExperiments({
  experiments: [{
    id: 'exp-other',
    name: 'Other',
    variants: [{
      id: 'var-o',
      name: 'O',
      traffic_split: 100,
      changes: [{ type: 'page_js', value: 'document.__other = (document.__other || 0) + 1' }],
    }],
  }],
  href: `${ORIGIN}/shop`,
  document: doc,
  storage,
  visitorId: 'visitor-spa',
  qaOn: true,
  applied,
  apply(variant) { return applier.applyAll(variant.changes || [], variant.id || 'variant'); },
  send() {},
  wire() {},
  report() {},
});
assert.strictEqual(doc.__other, 1);
assert.strictEqual(doc.__runs, 1);
runtime.applyMatchingExperiments({
  experiments: [{
    id: 'exp-other',
    name: 'Other',
    variants: [{
      id: 'var-o',
      name: 'O',
      traffic_split: 100,
      changes: [{ type: 'page_js', value: 'document.__other = (document.__other || 0) + 1' }],
    }],
  }],
  href: `${ORIGIN}/shop`,
  document: doc,
  storage,
  visitorId: 'visitor-spa',
  qaOn: true,
  applied,
  apply() { throw new Error('applied twice'); },
  send() { throw new Error('viewed twice'); },
  wire() {},
  report() {},
});
assert.strictEqual(doc.__other, 1);

// Opt-out does not enrol. The GA4 address listener can still be attached.
const offWin = fakeBrowser(`${ORIGIN}/shop`);
const offTimers = fakeTimers();
const offNavs = [];
const off = runtime.startSpaRecheck(offWin, {
  script: scriptAttr('off'),
  initialHref: offWin.location.href,
  debounceMs: runtime.SPA_DEBOUNCE_MS,
  setTimer: offTimers.set,
  clearTimer: offTimers.clear,
  onNavigate() { offNavs.push(offWin.location.href); },
});
assert.strictEqual(off.enabled, false);
assert.strictEqual(off.session, null);
offWin.history.pushState({}, '', '/products/oak-leaf-t-shirt-blue');
offTimers.flush(runtime.SPA_DEBOUNCE_MS);
assert.deepStrictEqual(offNavs, []);
const ga4Keys = [];
assert.strictEqual(runtime.bindSpaRouteChanges(offWin, (key) => ga4Keys.push(key)), true);
offWin.history.pushState({}, '', '/thank-you');
offWin.history.replaceState({}, '', '/thank-you?placed=1');
offWin.location.href = `${ORIGIN}/thank-you?placed=1#done`;
offWin.emit('hashchange');
assert.deepStrictEqual(ga4Keys, ['/thank-you', '/thank-you?placed=1', '/thank-you?placed=1#done']);

const editWin = fakeBrowser(`${ORIGIN}/shop?ab_edit=var-b&token=edit-token`);
const editNavs = [];
const edit = runtime.startSpaRecheck(editWin, {
  mode: runtime.modeFromHref(editWin.location.href),
  initialHref: editWin.location.href,
  setTimer: offTimers.set,
  clearTimer: offTimers.clear,
  onNavigate() { editNavs.push('tracked'); },
});
assert.strictEqual(edit.enabled, false);
editWin.history.pushState({}, '', '/products/oak');
assert.deepStrictEqual(editNavs, []);

const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const refreshAt = snippetSrc.indexOf('function refreshAfterNavigation');
const recheckAt = snippetSrc.indexOf('if (spaRecheckAllowed(mode, scriptTag))', refreshAt);
const refreshBody = snippetSrc.slice(refreshAt, recheckAt);
assert.ok(refreshBody.includes('modeFromHref(href)'));
assert.ok(refreshBody.includes("nextMode.type === 'edit'"));
assert.ok(refreshBody.includes("nextMode.type === 'preview'"));
assert.ok(refreshBody.includes('deliverNavigation'));
assert.ok(refreshBody.includes('checkUrlGoals'));
assert.ok(refreshBody.includes('publicExperimentsUrl(href, fetchAsTest)'));
assert.ok(snippetSrc.includes('data-spa="off"'));

const helpPage = fs.readFileSync(path.join(__dirname, '../public/help.html'), 'utf8');
const helpDoc = fs.readFileSync(path.join(__dirname, '../docs/help.md'), 'utf8');
for (const text of [helpPage, helpDoc]) {
  assert.ok(text.includes('A test that was already applied stays applied until the next full load.'), text.slice(0, 40));
  assert.ok(text.includes('data-spa="off"'));
  assert.ok(text.includes('pivitlab'));
  assert.ok(!text.includes('Pivitlab'));
  assert.ok(!text.includes('PivitLab'));
  assert.ok(!/\benroll\b/i.test(text));
  assert.ok(!/\bbehavior\b/i.test(text));
}

console.log('spa-route.test.js ok');
