// Send to GA4: event shape, paid-plan gating, consent, and one impression
// per assignment per page view. No database. The snippet must not load
// Google Analytics or set a Google cookie.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const snippet = require('../snippet/ab.js');
const ga4 = require('../src/ga4');
const ui = require('../public/admin-ui.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const home = {
  id: 'exp-1',
  name: 'Home hero',
  variants: [{ id: 'var-1', name: 'Control' }, { id: 'var-2', name: 'Bold' }],
};
const nav = {
  id: 'exp-2',
  name: 'Nav',
  variants: [{ id: 'var-9', name: 'Quiet' }],
};

function plan(overrides) {
  return snippet.planExperienceImpressions(Object.assign({
    experiments: [home],
    assignments: { 'exp-1': 'var-1' },
    pageKey: '/pricing',
    sent: {},
    ga4: { measurement_id: 'G-TEST1234' },
    consentAllows: true,
    transport: 'gtag',
    preview: false,
    testTraffic: false,
  }, overrides || {}));
}

function idsAgree(value) {
  assert.strictEqual(snippet.normaliseGa4MeasurementId(value), ga4.normaliseMeasurementId(value), String(value));
}

['G-TEST1234', ' g-test1234 ', 'G-ABC123', '', null, undefined, 'G-AB', 'UA-123456-1', 'GTM-ABC123', 'AW-123456', 'G-TEST1234 ', 'G-ABCDEFGHIJKLM', 'not-an-id', 'G-TEST 1234'].forEach(idsAgree);

assert.strictEqual(snippet.normaliseGa4MeasurementId('g-test1234'), 'G-TEST1234');
assert.strictEqual(ga4.normaliseMeasurementId('G-AB'), null);
assert.strictEqual(ga4.MEASUREMENT_ID.test('G-TEST1234'), true);

const sentBook = {};
const first = plan({ sent: sentBook });
assert.strictEqual(first.reason, 'ok');
assert.strictEqual(first.events.length, 1);
assert.deepStrictEqual(sentBook, {});
const event = first.events[0];
assert.strictEqual(event.name, 'experience_impression');
assert.strictEqual(event.transport, 'gtag');
assert.strictEqual(event.measurement_id, 'G-TEST1234');
assert.strictEqual(event.params.exp_variant_string, 'Home hero(exp-1):Control(var-1)');
assert.strictEqual(event.params.experiment_id, 'exp-1');
assert.strictEqual(event.params.experiment_name, 'Home hero');
assert.strictEqual(event.params.variant_id, 'var-1');
assert.strictEqual(event.params.variant_name, 'Control');
assert.strictEqual(event.params.send_to, 'G-TEST1234');
assert.strictEqual(snippet.expVariantString('Home\nhero', 'exp-1', 'Control', 'var-1'), 'Home hero(exp-1):Control(var-1)');

const long = snippet.expVariantString('N'.repeat(80), 'exp-1', 'V'.repeat(80), 'var-1');
assert.ok(long.length <= 100, long);
assert.ok(long.includes('exp-1') && long.includes('var-1'), long);

const both = plan({
  experiments: [home, home, nav],
  assignments: { 'exp-1': 'var-1', 'exp-2': 'var-9' },
});
assert.strictEqual(both.events.length, 2);
assert.deepStrictEqual(both.events.map((item) => item.params.variant_id), ['var-1', 'var-9']);

assert.strictEqual(plan({ assignments: {} }).events.length, 0);
assert.strictEqual(plan({ assignments: { 'exp-1': 'missing' } }).events.length, 0);
assert.strictEqual(plan({ ga4: null }).reason, 'disabled');
assert.strictEqual(plan({ ga4: { enabled: false, measurement_id: 'G-TEST1234' } }).reason, 'disabled');
assert.strictEqual(plan({ ga4: { measurement_id: 'UA-123' } }).reason, 'measurement-id');
assert.strictEqual(plan({ preview: true }).reason, 'not-live');
assert.strictEqual(plan({ testTraffic: true }).reason, 'not-live');
assert.strictEqual(plan({ consentAllows: false }).reason, 'consent');
assert.strictEqual(plan({ transport: null }).reason, 'no-transport');
assert.strictEqual(plan({ transport: 'pixel' }).reason, 'no-transport');

const book = {};
const pageA = plan({ pageKey: '/a', sent: book });
snippet.markImpressionsSent(book, pageA.events);
assert.strictEqual(plan({ pageKey: '/a', sent: book }).events.length, 0);
const pageB = plan({ pageKey: '/b', sent: book });
assert.strictEqual(pageB.events.length, 1);
assert.notStrictEqual(pageA.events[0].dedupeKey, pageB.events[0].dedupeKey);
snippet.markImpressionsSent(book, pageB.events);
assert.strictEqual(plan({ pageKey: '/b', sent: book, assignments: { 'exp-1': 'var-2' } }).events.length, 1);

const calls = [];
let cookieWrites = 0;
const gtagWin = {
  dataLayer: [['consent', 'default', { analytics_storage: 'granted' }]],
  gtag() { calls.push(Array.from(arguments)); },
  get cookie() { cookieWrites += 1; return ''; },
  set cookie(_value) { cookieWrites += 1; },
  document: { createElement() { throw new Error('created a tag'); } },
};
assert.strictEqual(snippet.ga4Transport(gtagWin), 'gtag');
assert.strictEqual(snippet.sendPlannedImpressions(gtagWin, pageB, {}, {}), 1);
assert.strictEqual(calls.length, 1);
assert.strictEqual(calls[0][0], 'event');
assert.strictEqual(calls[0][1], 'experience_impression');
assert.strictEqual(calls[0][2].exp_variant_string, 'Home hero(exp-1):Control(var-1)');
assert.strictEqual(calls[0][2].send_to, 'G-TEST1234');
assert.strictEqual(gtagWin.dataLayer.length, 1);
assert.strictEqual(cookieWrites, 0);
assert.strictEqual(typeof gtagWin.document.createElement, 'function');

const layerWin = { dataLayer: [] };
const layered = plan({ transport: 'dataLayer' });
assert.strictEqual(snippet.deliverExperienceImpression(layerWin, layered.events[0]), true);
assert.strictEqual(layerWin.dataLayer.length, 1);
assert.strictEqual(layerWin.dataLayer[0].event, 'experience_impression');
assert.strictEqual(layerWin.dataLayer[0].experiment_name, 'Home hero');
assert.strictEqual(typeof layerWin.gtag, 'undefined');

const bare = {};
assert.strictEqual(snippet.ga4Transport(bare), null);
assert.strictEqual(snippet.deliverExperienceImpression(bare, layered.events[0]), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bare, 'dataLayer'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bare, 'gtag'), false);

assert.strictEqual(snippet.analyticsStorageState({}), 'unknown');
assert.strictEqual(snippet.analyticsConsentAllows({}), true);
const denied = { dataLayer: [['consent', 'default', { analytics_storage: 'denied' }]] };
assert.strictEqual(snippet.analyticsConsentAllows(denied), false);
denied.dataLayer.push(['consent', 'update', { analytics_storage: 'granted' }]);
assert.strictEqual(snippet.analyticsStorageState(denied), 'granted');
const icsDenied = {
  dataLayer: [['consent', 'update', { analytics_storage: 'granted' }]],
  google_tag_data: { ics: { entries: { analytics_storage: { default: 'denied' } } } },
};
assert.strictEqual(snippet.analyticsConsentAllows(icsDenied), false);
icsDenied.google_tag_data.ics.entries.analytics_storage.update = 'granted';
assert.strictEqual(snippet.analyticsConsentAllows(icsDenied), true);

const reentrySent = {};
const reentryState = {};
let reentryCalls = 0;
const reentryWin = {
  dataLayer: [],
  gtag() {
    reentryCalls += 1;
    this.dataLayer.push({ event: 'experience_impression' });
  },
};
function reportBoth() {
  const planned = snippet.planExperienceImpressions({
    experiments: [home, nav],
    assignments: { 'exp-1': 'var-1', 'exp-2': 'var-9' },
    pageKey: '/pricing',
    sent: reentrySent,
    ga4: { measurement_id: 'G-TEST1234' },
    consentAllows: snippet.analyticsConsentAllows(reentryWin),
    transport: snippet.ga4Transport(reentryWin),
  });
  return snippet.sendPlannedImpressions(reentryWin, planned, reentrySent, reentryState);
}
reentryWin.dataLayer.push(['consent', 'default', { analytics_storage: 'denied' }]);
assert.strictEqual(reportBoth(), 0);
assert.strictEqual(reentryCalls, 0);
assert.strictEqual(snippet.watchAnalyticsConsent(reentryWin, reportBoth), true);
assert.strictEqual(snippet.watchAnalyticsConsent(reentryWin, reportBoth), true);
reentryWin.dataLayer.push(['consent', 'update', { analytics_storage: 'granted' }]);
assert.strictEqual(reentryCalls, 2);
reentryWin.dataLayer.push({ event: 'gtm.click' });
assert.strictEqual(reentryCalls, 2);

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

const spa = fakeBrowser('https://shop.example/');
const keys = [];
assert.strictEqual(snippet.bindSpaRouteChanges(spa, (key) => keys.push(key)), true);
assert.deepStrictEqual(keys, []);
spa.history.pushState({}, '', '/pricing');
spa.history.pushState({}, '', '/pricing');
spa.history.replaceState({}, '', '/pricing?x=1');
spa.location.href = 'https://shop.example/pricing?x=1#/cart';
spa.emit('popstate');
spa.emit('hashchange');
assert.deepStrictEqual(keys, ['/pricing', '/pricing?x=1', '/pricing?x=1#/cart']);
assert.strictEqual(snippet.bindSpaRouteChanges(spa, () => keys.push('again')), true);
spa.history.pushState({}, '', '/checkout');
assert.deepStrictEqual(keys, ['/pricing', '/pricing?x=1', '/pricing?x=1#/cart', '/checkout']);
assert.strictEqual(snippet.pageViewKey('https://shop.example/pricing?x=1#/cart'), '/pricing?x=1#/cart');

const unpaid = ga4.parseGa4Update(
  { measurement_id: 'g-test1234', enabled: true },
  { ga4_measurement_id: null, ga4_enabled: false },
  false
);
assert.strictEqual(unpaid.ok, false);
assert.strictEqual(unpaid.status, 403);
assert.strictEqual(unpaid.error, ga4.PAID_PLAN_ERROR);
const saved = ga4.parseGa4Update(
  { measurement_id: ' g-test1234 ', enabled: false },
  { ga4_measurement_id: null, ga4_enabled: false },
  false
);
assert.deepStrictEqual(saved, { ok: true, measurement_id: 'G-TEST1234', enabled: false });
const missingId = ga4.parseGa4Update({ enabled: true }, { ga4_enabled: false }, true);
assert.strictEqual(missingId.status, 400);
const badId = ga4.parseGa4Update({ measurement_id: 'UA-123456-1' }, {}, true);
assert.strictEqual(badId.status, 400);
const badFlag = ga4.parseGa4Update({ enabled: 'yes', measurement_id: 'G-TEST1234' }, {}, true);
assert.strictEqual(badFlag.status, 400);
const turnedOn = ga4.parseGa4Update(
  { enabled: true },
  { ga4_measurement_id: 'G-TEST1234', ga4_enabled: false },
  true
);
assert.deepStrictEqual(turnedOn, { ok: true, measurement_id: 'G-TEST1234', enabled: true });
const turnedOff = ga4.parseGa4Update(
  { enabled: false },
  { ga4_measurement_id: 'G-TEST1234', ga4_enabled: true },
  false
);
assert.strictEqual(turnedOff.ok, true);
assert.strictEqual(turnedOff.enabled, false);

assert.strictEqual(ga4.publicGa4Config(null), null);
assert.strictEqual(ga4.publicGa4Config({ paid_plan: false, ga4_enabled: true, ga4_measurement_id: 'G-TEST1234' }), null);
assert.strictEqual(ga4.publicGa4Config({ paid_plan: true, ga4_enabled: false, ga4_measurement_id: 'G-TEST1234' }), null);
assert.strictEqual(ga4.publicGa4Config({ paid_plan: true, ga4_enabled: true, ga4_measurement_id: 'UA-1' }), null);
assert.deepStrictEqual(
  ga4.publicGa4Config({ paid_plan: true, ga4_enabled: true, ga4_measurement_id: 'g-test1234' }),
  { measurement_id: 'G-TEST1234' }
);
assert.strictEqual(ga4.parsePaidPlan({ paid_plan: 'yes' }).ok, false);
assert.deepStrictEqual(ga4.parsePaidPlan({ paid_plan: true }), { ok: true, paid_plan: true });

assert.strictEqual(ui.ga4UptakeText(0), '0 sites have Send to GA4 switched on.');
assert.strictEqual(ui.ga4UptakeText(1), '1 site has Send to GA4 switched on.');
assert.strictEqual(ui.ga4UptakeText(3), '3 sites have Send to GA4 switched on.');
assert.strictEqual(ui.ga4AgencySitesText(1), '1 site switched on');
assert.strictEqual(ui.auditActionLabel('ga4_settings'), 'Updated Send to GA4');
assert.strictEqual(ui.auditActionLabel('paid_plan'), 'Changed the paid plan');
assert.strictEqual(ui.auditDetailText({ action: 'paid_plan', detail: { paid_plan: true, name: 'North' } }), 'Paid plan on');
assert.strictEqual(
  ui.auditDetailText({ action: 'ga4_settings', detail: { enabled: true, measurement_id: 'G-TEST1234' } }),
  'On. G-TEST1234'
);
for (const text of [ui.GA4_HELP, ui.GA4_UNPAID_NOTE, ui.GA4_ADMIN_HELP]) {
  assert.ok(text.includes('pivitlab'), text);
  assert.ok(!text.includes('Pivitlab'), text);
  assert.ok(!text.includes('PivitLab'), text);
  assert.ok(!/behavior|favorite|organize|\bcolor\b|customize/i.test(text), text);
}
assert.ok(ui.GA4_HELP.includes('experience_impression'));
assert.ok(ui.GA4_HELP.includes('exp_variant_string'));
assert.ok(ui.GA4_HELP.includes('does not load Google Analytics'));
assert.ok(ui.GA4_HELP.includes('does not set Google cookies'));
assert.ok(ui.GA4_ADMIN_HELP.includes('Paid plan is the switch'));
assert.ok(ui.GA4_UNPAID_NOTE.includes('paid plans'));

const snippetSrc = read('snippet/ab.js');
const deliverSrc = snippet.deliverExperienceImpression.toString();
for (const src of [snippetSrc, deliverSrc]) {
  assert.ok(!src.includes('googletagmanager'), 'loads Google');
  assert.ok(!src.includes('google-analytics.com'), 'loads Google');
  assert.ok(!src.includes('/gtag/js'), 'loads gtag.js');
  assert.ok(!src.includes("gtag('consent'"), 'sets consent');
  assert.ok(!src.includes('G-NT78JHVHGY'), 'hard-codes a measurement id');
}
assert.ok(!deliverSrc.includes('cookie'));
assert.ok(!deliverSrc.includes('createElement'));
assert.ok(snippetSrc.includes('experience_impression'));
assert.ok(snippetSrc.includes('exp_variant_string'));

const migration = read('src/db/ga4.js');
const migrateSrc = read('src/db/migrate.js');
const schema = read('src/db/schema.sql');
assert.ok(migrateSrc.includes("{ version: '018', name: 'ga4', run: applyGa4 }"));
assert.ok(migrateSrc.indexOf("version: '017'") < migrateSrc.indexOf("version: '018'"));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS paid_plan BOOLEAN NOT NULL DEFAULT false'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS ga4_enabled BOOLEAN NOT NULL DEFAULT false'));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));
assert.ok(!schema.includes('paid_plan'));
assert.ok(!schema.includes('ga4_measurement_id'));

const dashboard = read('public/index.html');
assert.ok(dashboard.includes('id="ga4-admin-card"'));
assert.ok(dashboard.includes('await loadGa4Admin();'));
assert.ok(dashboard.includes('>Send to GA4</h2>'));
assert.ok(dashboard.includes('Send to GA4</label>'));
assert.ok(dashboard.includes('UI.GA4_HELP'));
assert.ok(dashboard.includes('Paid plan'));
assert.ok(dashboard.includes('class="brand-logo"'));
assert.ok(dashboard.includes('aria-label="pivitlab"'));
assert.ok(!dashboard.includes('Pivitlab'));
assert.ok(read('public/help.html').includes('class="brand-logo"'));

const turnedDown = ga4.parseGa4Update({ enabled: false, measurement_id: '' }, { ga4_measurement_id: 'G-TEST1234', ga4_enabled: true }, true);
assert.deepStrictEqual(turnedDown, { ok: true, measurement_id: null, enabled: false });

console.log('ga4 tests passed');
