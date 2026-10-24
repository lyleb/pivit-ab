// A custom goal converts from pivit.track('payment_complete'), including a
// call queued before the snippet loads. When the site has opted in, the
// same goal also converts from dataLayer.push({ event: 'payment_complete' }).
// Site 3's confirmation step pushes checkout_step with step_name
// confirmation. experience_impression is ignored. One conversion per
// visitor per goal. Preview and the editor do not send.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');
const goals = require('../src/goals');

const PAGE = 'https://site3-checkout.netlify.app/play';
const CONFIRMATION = { event: 'checkout_step', step: 4, step_name: 'confirmation' };
const BASKET = { event: 'checkout_step', step: 1, step_name: 'basket' };

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    data,
  };
}

const samples = ['payment_complete', 'checkout_step', 'a', 'A1', 'pay-now', 'step.name', 'a'.repeat(64)];
samples.forEach((name) => {
  assert.strictEqual(goals.normaliseCustomEventName(name), name, name);
  assert.strictEqual(runtime.normaliseCustomEventName(name), name, name);
});
['', ' ', 'pay now', '.hidden', '-no', 'experience_impression', 'a'.repeat(65), 'pay/now'].forEach((name) => {
  assert.strictEqual(goals.normaliseCustomEventName(name), '', JSON.stringify(name));
  assert.strictEqual(runtime.normaliseCustomEventName(name), '', JSON.stringify(name));
});

assert.strictEqual(runtime.eventNameFromQueueItem(['track', 'payment_complete']), 'payment_complete');
assert.strictEqual(runtime.eventNameFromQueueItem(['track', 'payment_complete', { value: 20 }]), 'payment_complete');
assert.strictEqual(runtime.eventNameFromQueueItem('checkout_step'), 'checkout_step');
assert.strictEqual(runtime.eventNameFromQueueItem({ event: 'payment_complete' }), 'payment_complete');
assert.strictEqual(runtime.eventNameFromQueueItem(['track']), '');
assert.strictEqual(runtime.eventNameFromQueueItem(['experience_impression']), '');
function queuedArguments() { return arguments; }
assert.strictEqual(runtime.eventNameFromQueueItem(queuedArguments('payment_complete')), 'payment_complete');
assert.strictEqual(runtime.eventNameFromQueueItem(queuedArguments('track', 'checkout_step')), 'checkout_step');

assert.strictEqual(runtime.dataLayerEntryEventName(CONFIRMATION), 'checkout_step');
assert.strictEqual(runtime.dataLayerEntryEventName(BASKET), 'checkout_step');
assert.strictEqual(runtime.dataLayerEntryEventName({ event: 'experience_impression', experiment_id: 'exp-1' }), '');
assert.strictEqual(runtime.dataLayerEntryEventName(['event', 'payment_complete']), '');
assert.strictEqual(runtime.dataLayerEntryEventName(queuedArguments('event', 'payment_complete')), '');

const listed = runtime.customGoalsFrom([
  { type: 'custom', id: 'paid', name: 'Paid', event: ' payment_complete ' },
  { type: 'custom', id: 'blank', event: '   ' },
  { type: 'custom', id: 'own', event: 'experience_impression' },
  { type: 'click', id: 'pay', selector: '#pay-now' },
  { type: 'element', id: 'done', selector: '#step-confirmation' },
], { experimentId: 'exp-play', variantId: 'variant-b', visitorId: 'v1' });
assert.strictEqual(listed.length, 1);
assert.strictEqual(listed[0].goalId, 'paid');
assert.strictEqual(listed[0].event, 'payment_complete');
assert.strictEqual(listed[0].visitorId, 'v1');

const fromAssigned = runtime.customGoalsFromExperiments([
  {
    id: 'exp-play',
    goals: [{ type: 'custom', id: 'paid', event: 'checkout_step', name: 'Paid' }],
    variants: [{ id: 'variant-b', goals: [] }],
  },
  {
    id: 'exp-other',
    goals: [],
    variants: [{ id: 'variant-c', goals: [{ type: 'custom', id: 'thanks', event: 'payment_complete' }] }],
  },
], { 'exp-play': 'variant-b', 'exp-other': 'variant-c' }, 'v9');
assert.deepStrictEqual(fromAssigned.map((goal) => goal.goalId), ['paid', 'thanks']);

const store = memoryStore();
const memory = Object.create(null);
assert.strictEqual(runtime.claimCustom(store, 'v1', 'exp-play', 'paid', memory), true);
assert.strictEqual(runtime.claimCustom(store, 'v1', 'exp-play', 'paid', memory), false);
assert.strictEqual(store.data[runtime.customStorageKey('v1', 'exp-play', 'paid')], '1');
const later = Object.create(null);
assert.strictEqual(runtime.claimCustom(store, 'v1', 'exp-play', 'paid', later), false);

const queued = { pivit: [] };
queued.pivit.push(['track', 'payment_complete']);
const seen = [];
const tracker = runtime.installPivitTracker(queued, (name) => seen.push(name));
assert.deepStrictEqual(seen, ['payment_complete']);
assert.strictEqual(typeof tracker.track, 'function');
tracker.track('checkout_step');
assert.deepStrictEqual(seen, ['payment_complete', 'checkout_step']);
assert.strictEqual(queued.pivit, tracker);
runtime.installPivitTracker(queued, () => seen.push('again'));
assert.deepStrictEqual(seen, ['payment_complete', 'checkout_step']);

const kept = { pivit: { hello: 'kept', track() { return 'page'; } } };
const keptSeen = [];
runtime.installPivitTracker(kept, (name) => keptSeen.push(name));
assert.strictEqual(kept.pivit.hello, 'kept');
assert.strictEqual(kept.pivit.track('payment_complete'), 'page');
assert.deepStrictEqual(keptSeen, ['payment_complete']);

function existingPivit() { return 'untouched'; }
const fnWin = { pivit: existingPivit };
assert.strictEqual(runtime.installPivitTracker(fnWin, () => { throw new Error('should not track'); }), existingPivit);
assert.strictEqual(fnWin.pivit, existingPivit);

assert.strictEqual(runtime.customTrackingAllowed({ type: 'preview' }), false);
assert.strictEqual(runtime.customTrackingAllowed({ type: 'edit' }), false);
assert.strictEqual(runtime.customTrackingAllowed({ type: '' }), true);
assert.strictEqual(runtime.customTrackingAllowed(null), true);

function harness(initial) {
  const names = [];
  const win = { dataLayer: initial ? initial.slice() : [] };
  const hooked = runtime.watchDataLayer(win, (name) => names.push(name));
  return { win, names, hooked };
}

const early = harness([
  { event: 'experience_impression', experiment_id: 'exp-1', exp_variant_string: 'Home(exp-1):Control(var-1)' },
  BASKET,
]);
assert.strictEqual(early.hooked.hooked, true);
assert.deepStrictEqual(early.names, ['checkout_step']);
assert.strictEqual(early.win.dataLayer[0].event, 'experience_impression');
assert.strictEqual(early.win.dataLayer[0].exp_variant_string, 'Home(exp-1):Control(var-1)');

let allows = 0;
assert.strictEqual(runtime.watchAnalyticsConsent(early.win, () => { allows += 1; }), true);
const length = early.win.dataLayer.push(CONFIRMATION);
assert.strictEqual(length, 3);
assert.deepStrictEqual(early.names, ['checkout_step', 'checkout_step']);
assert.strictEqual(allows, 1);
assert.strictEqual(early.win.dataLayer[2].step, 4);
assert.strictEqual(early.win.dataLayer[2].step_name, 'confirmation');

const delivered = runtime.deliverExperienceImpression(early.win, {
  transport: 'dataLayer',
  params: { experiment_id: 'exp-1', exp_variant_string: 'Home(exp-1):Control(var-1)', send_to: 'G-TEST1234' },
});
assert.strictEqual(delivered, true);
assert.strictEqual(early.win.dataLayer[3].event, 'experience_impression');
assert.strictEqual(early.win.dataLayer[3].send_to, 'G-TEST1234');
assert.deepStrictEqual(early.names, ['checkout_step', 'checkout_step']);
assert.strictEqual(allows, 2);

const again = runtime.watchDataLayer(early.win, () => { throw new Error('scanned twice'); });
assert.strictEqual(again.scanned, 0);
assert.deepStrictEqual(early.names, ['checkout_step', 'checkout_step']);

const late = {};
const lateNames = [];
runtime.watchDataLayer(late, (name) => lateNames.push(name));
assert.strictEqual(late.dataLayer, undefined);
late.dataLayer = [BASKET];
assert.deepStrictEqual(lateNames, ['checkout_step']);
late.dataLayer.push({ event: 'experience_impression' });
late.dataLayer.push(CONFIRMATION);
assert.deepStrictEqual(lateNames, ['checkout_step', 'checkout_step']);
assert.strictEqual(late.dataLayer.length, 3);
assert.strictEqual(late.dataLayer[1].event, 'experience_impression');

const checkoutGoal = runtime.customGoalsFrom([
  { type: 'custom', id: 'paid', event: 'checkout_step', name: 'Paid' },
], { experimentId: 'exp-play', variantId: 'variant-b', visitorId: 'v1' })[0];
const once = memoryStore();
const onceMemory = Object.create(null);
const sent = [];
function count(name) {
  if (name !== checkoutGoal.event) return;
  if (!runtime.claimCustom(once, checkoutGoal.visitorId, checkoutGoal.experimentId, checkoutGoal.goalId, onceMemory)) return;
  sent.push(checkoutGoal.goalId);
}
const live = { dataLayer: [BASKET] };
runtime.hookDataLayer(live, count);
live.dataLayer.push(CONFIRMATION);
live.dataLayer.push(CONFIRMATION);
assert.deepStrictEqual(sent, ['paid']);
assert.strictEqual(live.dataLayer.length, 3);

const snippet = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const help = fs.readFileSync(path.join(__dirname, '../public/help.html'), 'utf8');
const init = snippet.slice(snippet.indexOf('async function init'));
const previewAt = init.indexOf('if (wantsPreview)');
const trackingAt = init.indexOf('customTracking = true');
const editAt = init.indexOf("mode.type === 'edit'");
assert.ok(editAt !== -1 && editAt < trackingAt);
assert.ok(previewAt !== -1 && previewAt < trackingAt);
assert.ok(init.indexOf('datalayer_events') > trackingAt);
assert.ok(snippet.includes('addCustomGoals(customGoalsFrom('));
assert.ok(snippet.includes('installPivitTracker('));
assert.ok(snippet.includes('experience_impression'));
assert.ok(admin.includes('Count dataLayer events'));
assert.ok(admin.includes('value="custom"'));
assert.ok(admin.includes('payment_complete'));
assert.ok(help.includes('id="custom-event"'));
assert.ok(help.includes('window.pivit = window.pivit || []'));
assert.ok(help.includes("pivit.track('payment_complete')"));
assert.ok(help.includes('Count dataLayer events'));
assert.ok(!help.includes('Pivitlab'));
assert.strictEqual(PAGE, 'https://site3-checkout.netlify.app/play');

console.log('custom event tests passed');
