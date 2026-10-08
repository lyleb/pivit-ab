const assert = require('assert');
const fs = require('fs');
const path = require('path');
const goals = require('../src/goals');
const metrics = require('../src/metrics');
const health = require('../src/health');
const drops = require('../src/event-drops');
const urlMatch = require('../public/url-match');
const runtime = require('../snippet/ab.js');

function event(partial) {
  return {
    variant_id: 'control',
    variant_name: 'Control',
    visitor_id: 'a',
    event_type: 'view',
    goal_id: null,
    ...partial,
  };
}

// --- Migration keeps the ids events already use, and the numbers do not move ---

const aboutVariants = [
  { id: 'control', name: 'Control', goals: [] },
  {
    id: 'b',
    name: 'B',
    goals: [
      { type: 'click', selector: '.buy', id: 'buy', primary: true },
      { type: 'url', url_match: '/thanks?', id: 'thanks' },
    ],
  },
];
const aboutEvents = [
  event({ variant_id: 'control', variant_name: 'Control', visitor_id: 'a', event_type: 'view' }),
  event({ variant_id: 'control', variant_name: 'Control', visitor_id: 'b', event_type: 'view' }),
  event({ variant_id: 'b', variant_name: 'B', visitor_id: 'c', event_type: 'view' }),
  event({ variant_id: 'b', variant_name: 'B', visitor_id: 'c', event_type: 'convert', goal_id: 'buy' }),
  event({ variant_id: 'b', variant_name: 'B', visitor_id: 'c', event_type: 'convert', goal_id: 'buy' }),
  event({ variant_id: 'b', variant_name: 'B', visitor_id: 'c', event_type: 'convert', goal_id: 'thanks' }),
];

function snapshot(goalLists, primaryFrom) {
  const defs = metrics.defsFromGoalList(goalLists);
  const primary = (primaryFrom || defs).find((goal) => goal.primary);
  return {
    defs,
    headline: metrics.summariseConversions(aboutEvents, { primaryGoalKey: primary ? primary.key : null }),
    byGoal: metrics.summariseByGoal(aboutEvents, defs),
  };
}

const beforeLists = [];
aboutVariants.forEach((variant) => (variant.goals || []).forEach((goal) => beforeLists.push(goal)));
const before = snapshot(beforeLists);
const plan = goals.planGoalMigration(aboutVariants);
assert.strictEqual(plan.scope, 'shared');
assert.deepStrictEqual(plan.goals.map((goal) => goal.id), ['buy', 'thanks']);
assert.strictEqual(plan.goals[0].primary, true);
assert.strictEqual(plan.goals[1].match, 'contains');
assert.strictEqual(plan.goals[1].name, 'thanks');
const after = snapshot(plan.goals);
assert.deepStrictEqual(after.headline, before.headline);
assert.deepStrictEqual(after.byGoal, before.byGoal);
const control = after.headline.find((row) => row.variant_name === 'Control');
const challenger = after.headline.find((row) => row.variant_name === 'B');
assert.strictEqual(control.conversions, 0);
assert.strictEqual(control.conversion_rate, 0);
assert.strictEqual(challenger.conversions, 1);
assert.strictEqual(challenger.conversion_events, 2);

// Renaming the display name does not change the key results are counted on.
plan.goals[0].name = 'Buy button';
const renamed = metrics.defsFromGoalList(plan.goals);
assert.strictEqual(renamed[0].key, 'buy');
assert.strictEqual(renamed[0].label, 'Buy button');
const afterRename = snapshot(plan.goals, renamed);
assert.deepStrictEqual(afterRename.headline, before.headline);
assert.strictEqual(afterRename.byGoal[0].key, 'buy');
assert.deepStrictEqual(
  afterRename.byGoal.map((goal) => goal.variants),
  before.byGoal.map((goal) => goal.variants)
);

// Identical goals across variants collapse to one, keeping the event id.
const shared = goals.planGoalMigration([
  { goals: [{ type: 'url', url_match: '/checkout', id: 'checkout' }] },
  { goals: [{ type: 'url', url_match: '/checkout', id: 'checkout' }] },
]);
assert.strictEqual(shared.scope, 'shared');
assert.strictEqual(shared.goals.length, 1);
assert.strictEqual(shared.goals[0].id, 'checkout');
assert.strictEqual(shared.goals[0].match, 'contains');

// Genuinely different lists are not merged.
const divergent = goals.planGoalMigration([
  { goals: [{ type: 'click', selector: '.a', id: 'one' }] },
  { goals: [{ type: 'click', selector: '.b', id: 'two' }] },
]);
assert.strictEqual(divergent.scope, 'divergent');
assert.deepStrictEqual(divergent.goals, []);

// A goal with no label keeps the selector events already stored.
const bare = goals.planGoalMigration([
  { goals: [] },
  { goals: [{ type: 'click', selector: '.hero' }] },
]);
assert.strictEqual(bare.scope, 'shared');
assert.strictEqual(bare.goals[0].id, '.hero');
assert.strictEqual(metrics.goalKey(bare.goals[0]), '.hero');

// New goals get a stable id. A later rename keeps it.
const prepared = goals.prepareGoalsForSave([
  { name: 'Buy button', type: 'click', selector: '.buy' },
], []);
assert.ok(goals.GENERATED_ID.test(prepared[0].id));
assert.strictEqual(prepared[0].name, 'Buy button');
const renamedSave = goals.prepareGoalsForSave([
  { id: prepared[0].id, name: 'Purchase', type: 'click', selector: '.buy' },
], prepared);
assert.strictEqual(renamedSave[0].id, prepared[0].id);
assert.strictEqual(renamedSave[0].name, 'Purchase');

// A legacy save (label in id, no name) keeps that id so history does not split.
const legacy = goals.prepareGoalsForSave([
  { id: 'cta_click', type: 'click', selector: '.buy' },
], [{ id: 'cta_click', name: 'cta_click', type: 'click', selector: '.buy' }]);
assert.strictEqual(legacy[0].id, 'cta_click');
assert.strictEqual(legacy[0].name, 'cta_click');

assert.strictEqual(goals.validateGoals([{ type: 'url', url_match: '(a+)+', match: 'regex' }]), 'that regular expression is not safe to run');
assert.strictEqual(goals.validateGoals([{ type: 'url', url_match: '/thanks', match: 'contains' }]), null);
assert.strictEqual(goals.variantAdditionAllowed(2), true);
assert.strictEqual(goals.variantAdditionAllowed(3), false);
assert.strictEqual(goals.variantAdditionAllowed(5), false);
assert.strictEqual(goals.variantCapError(), 'A test can have at most 3 variants, including Control.');

// --- URL match types. Contains stays a plain substring. ---

const page = 'https://cantsaythat.co.uk/checkout?plan=1';
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout-complete', 'contains'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/thank-you?', 'https://cantsaythat.co.uk/thank-you', 'contains'), false);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout-complete', 'exact'), false);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout', 'exact'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout/', 'https://cantsaythat.co.uk/checkout', 'exact'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout?', 'https://cantsaythat.co.uk/checkout', 'exact'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout?', 'https://cantsaythat.co.uk/checkout/', 'exact'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', page, 'exact'), false);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout?', page, 'exact'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout/extra', 'exact'), false);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout', 'https://cantsaythat.co.uk/checkout/extra', 'starts_with'), true);
assert.strictEqual(urlMatch.matchUrlGoal('/checkout/', 'https://cantsaythat.co.uk/checkout', 'starts_with'), true);
assert.strictEqual(urlMatch.matchUrlGoal('https://cantsaythat.co.uk/checkout?', 'https://cantsaythat.co.uk/checkout?plan=1', 'starts_with'), true);
assert.strictEqual(urlMatch.matchUrlGoal('^https://cantsaythat\\.co\\.uk/checkout/?$', 'https://cantsaythat.co.uk/checkout', 'regex'), true);
assert.strictEqual(urlMatch.matchUrlGoal('(a+)+', 'aaaa', 'regex'), false);
assert.strictEqual(urlMatch.isSafeRegex('(a+)+'), false);
assert.strictEqual(urlMatch.isSafeRegex('(a|aa)+'), false);
assert.strictEqual(urlMatch.isSafeRegex('^/thank-you/?$'), true);
assert.strictEqual(urlMatch.isSafeRegex('(a)\\1'), false);
assert.strictEqual(urlMatch.isSafeRegex('('), false);
assert.strictEqual(urlMatch.isSafeRegex(''), false);

const tested = urlMatch.testUrlGoal('exact', '/checkout/', 'https://cantsaythat.co.uk/checkout');
assert.deepStrictEqual(tested, { ok: true, matches: true, message: 'This URL matches.' });
const missed = urlMatch.testUrlGoal('exact', '/checkout', 'https://cantsaythat.co.uk/checkout-complete');
assert.strictEqual(missed.matches, false);
assert.strictEqual(missed.message, 'This URL does not match.');
const unsafe = urlMatch.testUrlGoal('regex', '(a+)+', 'aaaa');
assert.strictEqual(unsafe.ok, false);
assert.strictEqual(unsafe.message, 'This regular expression is not safe to run.');

// The snippet copy agrees with the dashboard copy on every case above.
const fixtures = [
  ['/checkout', 'https://cantsaythat.co.uk/checkout-complete', 'contains'],
  ['/thank-you?', 'https://cantsaythat.co.uk/thank-you', 'contains'],
  ['/checkout', 'https://cantsaythat.co.uk/checkout-complete', 'exact'],
  ['/checkout', 'https://cantsaythat.co.uk/checkout', 'exact'],
  ['/checkout/', 'https://cantsaythat.co.uk/checkout', 'exact'],
  ['/checkout?', 'https://cantsaythat.co.uk/checkout', 'exact'],
  ['/checkout?', 'https://cantsaythat.co.uk/checkout/', 'exact'],
  ['/checkout', page, 'exact'],
  ['/checkout?', page, 'exact'],
  ['/checkout', 'https://cantsaythat.co.uk/checkout/extra', 'exact'],
  ['/checkout', 'https://cantsaythat.co.uk/checkout/extra', 'starts_with'],
  ['/checkout/', 'https://cantsaythat.co.uk/checkout', 'starts_with'],
  ['https://cantsaythat.co.uk/checkout?', page, 'starts_with'],
  ['^https://cantsaythat\\.co\\.uk/checkout/?$', 'https://cantsaythat.co.uk/checkout', 'regex'],
  ['(a+)+', 'aaaa', 'regex'],
];
fixtures.forEach((fixture) => {
  assert.strictEqual(runtime.matchUrlGoal(fixture[0], fixture[1], fixture[2]), urlMatch.matchUrlGoal(fixture[0], fixture[1], fixture[2]), fixture.join(' '));
});
assert.strictEqual(runtime.isSafeRegex('(a+)+'), urlMatch.isSafeRegex('(a+)+'));
assert.strictEqual(runtime.isSafeRegex('^/thank-you/?$'), true);

// --- Click goals: one beacon per visitor + experiment + goal ---

function memoryStore(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = value; },
    data,
  };
}

const store = memoryStore();
const mem = {};
assert.strictEqual(runtime.claimClick(store, 'v1', 'exp', 'buy', mem), true);
assert.strictEqual(runtime.claimClick(store, 'v1', 'exp', 'buy', mem), false);
assert.strictEqual(store.data[runtime.clickStorageKey('v1', 'exp', 'buy')], '1');
assert.strictEqual(runtime.claimClick(store, 'v1', 'exp', 'other', mem), true);
assert.strictEqual(runtime.claimClick(store, 'v2', 'exp', 'buy', mem), true);
assert.strictEqual(runtime.claimClick(store, 'v1', 'other-exp', 'buy', mem), true);
const fresh = {};
assert.strictEqual(runtime.claimClick(store, 'v1', 'exp', 'buy', fresh), false);

const throwing = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};
const fallback = {};
assert.strictEqual(runtime.claimClick(throwing, 'v9', 'exp', 'buy', fallback), true);
assert.strictEqual(runtime.claimClick(throwing, 'v9', 'exp', 'buy', fallback), false);

// --- Health wording ---

const quiet = health.buildHealth({
  status: 'running',
  srm: { applicable: true, srm_detected: false },
  totalVisitors: 200,
  scope: 'shared',
  goalCount: 1,
  drops: [],
  today: '2026-10-08',
  syntheticVisitors: 0,
});
assert.strictEqual(quiet.show, true);
assert.deepStrictEqual(quiet.checks.map((check) => check.state), ['green', 'green', 'green', 'green']);

const early = health.buildHealth({
  status: 'running',
  srm: { applicable: true, srm_detected: false },
  totalVisitors: 4,
  scope: 'shared',
  goalCount: 0,
  drops: [{ day: '2026-10-08', reason: 'bot', drop_count: 3 }],
  today: '2026-10-08',
  syntheticVisitors: 12,
});
assert.strictEqual(early.checks[0].state, 'amber');
assert.strictEqual(early.checks[1].state, 'amber');
assert.strictEqual(early.checks[2].state, 'amber');
assert.ok(early.checks[2].detail.includes('3 filtered as bots'));
assert.strictEqual(early.checks[3].state, 'amber');
assert.ok(early.checks[3].detail.includes('still included'));

const broken = health.buildHealth({
  status: 'running',
  srm: { applicable: true, srm_detected: true },
  totalVisitors: 400,
  scope: 'divergent',
  goalCount: 0,
  drops: [{ day: '2026-10-08', reason: 'rate_limited', drop_count: 20 }],
  today: '2026-10-08',
  syntheticVisitors: 0,
});
assert.deepStrictEqual(broken.checks.map((check) => check.state), ['red', 'red', 'red', 'green']);
assert.strictEqual(health.buildHealth({ status: 'paused' }).show, false);

// Drop counter fails open.
assert.strictEqual(drops.scheduleEventDrop('not-a-uuid', 'bot', () => { throw new Error('no'); }) instanceof Promise, true);
const logged = [];
const original = console.error;
console.error = (...args) => logged.push(args.map(String).join(' '));
drops.scheduleEventDrop('11111111-1111-1111-1111-111111111111', 'rate_limited', () => { throw new Error('sync down'); });
drops.scheduleEventDrop('11111111-1111-1111-1111-111111111111', 'bot', () => Promise.reject(new Error('db down')))
  .then(() => {
    console.error = original;
    assert.ok(logged.some((line) => line.includes('sync down')));
    assert.ok(logged.some((line) => line.includes('db down')));
    finish();
  })
  .catch((err) => {
    console.error = original;
    console.error(err);
    process.exit(1);
  });

function finish() {

const clientHtml = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(!clientHtml.includes('health-panel'));
assert.ok(!clientHtml.includes('/health'));

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(adminHtml.includes('Test this URL'));
assert.ok(adminHtml.includes('id="health-panel"'));
assert.ok(adminHtml.includes('canAddVariant'));

  console.log('goals tests passed');
}
