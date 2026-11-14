// The original page stays usable when the config request fails, hangs, or the
// snippet throws. The anti-flicker class is always cleared within 3 seconds.
// Consent denied writes nothing. Withdrawing consent stops later tracking.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const snippetSrc = fs.readFileSync(path.join(__dirname, '../snippet/ab.js'), 'utf8');
const runtime = require('../snippet/ab.js');
const ui = require('../public/admin-ui');

assert.strictEqual(runtime.ANTI_FLICKER_MAX_MS, 3000);
assert.ok(runtime.ANTI_FLICKER_MAX_MS <= 3000);
assert.strictEqual(runtime.CONFIG_CACHE_MS, 0);
assert.ok(snippetSrc.includes('finally'));
assert.ok(snippetSrc.includes('armAntiFlickerRelease'));
assert.ok(snippetSrc.includes("{ cache: 'no-store' }"));
assert.ok(!snippetSrc.includes("console.warn('[ab] failed to load experiments:'"));
assert.ok(!snippetSrc.includes("console.warn('[ab] failed to check URL goals:'"));

const note = ui.liveTimingNote(runtime.CONFIG_CACHE_MS);
assert.ok(note.includes('on the next page load'));
assert.ok(note.includes('Pausing stops the variant for every new page load'));
assert.ok(note.includes('until that person reloads'));
assert.ok(ui.liveTimingNote(180000).includes('within 3 minutes'));
assert.ok(ui.liveTimingNote(3000).includes('within 3 seconds'));

const experimentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const variantId = '11111111-1111-4111-8111-111111111111';

function harness(options) {
  const opts = options || {};
  const removed = [];
  const warnings = [];
  const writes = [];
  const beacons = [];
  const listeners = [];
  const timers = [];
  let hideClass = 'ab-hide';
  const buttonClicks = [];
  const button = {
    nodeType: 1,
    tagName: 'BUTTON',
    className: 'buy',
    id: 'buy',
    children: [],
    style: {},
    attributes: { class: 'buy', id: 'buy' },
    matches(selector) { return selector === 'button.buy'; },
    getAttribute(name) { return this.attributes[name] || null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, fn) {
      if (type === 'click') button.clicks = button.clicks || [];
      button.clicks.push(fn);
    },
    click() {
      buttonClicks.push('page');
      (button.clicks || []).forEach((fn) => fn());
      const event = { target: button, nodeType: null };
      listeners.filter((row) => row.type === 'click').forEach((row) => row.fn(event));
    },
  };
  const store = new Map();
  const localStorage = {
    get length() { return store.size; },
    key(index) { return Array.from(store.keys())[index] || null; },
    getItem(key) {
      if (opts.storageThrows) throw new Error('storage blocked');
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (opts.storageThrows) throw new Error('storage blocked');
      writes.push(String(key));
      store.set(String(key), String(value));
    },
    removeItem(key) { store.delete(key); },
  };
  const document = {
    readyState: 'complete',
    get cookie() {
      if (opts.cookieThrows) throw new Error('cookie threw');
      return '';
    },
    set cookie(value) { document._cookie = value; },
    currentScript: {
      src: 'https://pivitlab.com/snippet/ab.js',
      getAttribute(name) { return name === 'data-api' ? 'https://pivitlab.com' : null; },
    },
    documentElement: {
      classList: {
        add() {},
        remove(name) {
          removed.push(name);
          if (name === 'ab-hide') hideClass = '';
        },
      },
    },
    head: { children: [], appendChild(child) { this.children.push(child); return child; } },
    body: {
      children: [button],
      appendChild(child) { this.children.push(child); return child; },
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    createElement() {
      return { style: {}, setAttribute() {}, textContent: '', appendChild() {} };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === 'button.buy') return [button];
      return [];
    },
  };
  let fetchImpl = opts.fetch;
  if (!fetchImpl) {
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ experiments: [] }) });
  }
  const sandbox = {
    document,
    window: {
      location: { href: 'https://demo.pivitlab.com/', search: '' },
      document,
      addEventListener() {},
      Cookiebot: opts.cookiebot,
      pivitConsent: opts.pivitConsent,
    },
    localStorage,
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {
      sendBeacon(url, body) {
        if (opts.beaconThrows) throw new Error('beacon down');
        beacons.push({ url: String(url), body });
        return opts.beaconOk !== false;
      },
    },
    fetch: fetchImpl,
    console: {
      warn(...args) { warnings.push(args.map(String).join(' ')); },
      info() {},
      log() {},
      error(...args) { warnings.push(args.map(String).join(' ')); },
    },
    URL,
    URLSearchParams,
    encodeURIComponent,
    Blob,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return timers.length;
    },
    clearTimeout(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  };
  sandbox.window.document = document;
  return { sandbox, removed, warnings, writes, beacons, timers, button, buttonClicks, hideClass: () => hideClass };
}

function experimentsPayload() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      experiments: [{
        id: experimentId,
        name: 'Button',
        goals: [{ type: 'click', selector: 'button.buy', id: 'buy-click' }],
        variants: [{ id: variantId, name: 'B', traffic_split: 100, changes: [], goals: [] }],
      }],
    }),
  };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function boot(env) {
  vm.runInNewContext(snippetSrc, env.sandbox, { filename: 'ab.js' });
}

(async () => {
  const failed = harness({
    fetch: async () => { throw new Error('network down'); },
  });
  boot(failed);
  await flush();
  assert.ok(failed.removed.includes('ab-hide'), 'API failure must reveal the page');
  assert.strictEqual(failed.hideClass(), '');
  assert.deepStrictEqual(failed.warnings, []);
  assert.deepStrictEqual(failed.writes, []);
  failed.button.click();
  assert.deepStrictEqual(failed.buttonClicks, ['page']);
  const anti = failed.timers.filter((timer) => timer.ms === 3000);
  assert.strictEqual(anti.length, 1);
  assert.strictEqual(anti[0].cleared, true);

  const httpError = harness({
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal error' }) }),
  });
  boot(httpError);
  await flush();
  assert.ok(httpError.removed.includes('ab-hide'));
  assert.deepStrictEqual(httpError.warnings, []);
  httpError.button.click();
  assert.deepStrictEqual(httpError.buttonClicks, ['page']);

  const slow = harness({
    fetch: () => new Promise(() => {}),
  });
  boot(slow);
  await flush();
  assert.ok(!slow.removed.includes('ab-hide'), 'a hanging request must not reveal before the timeout');
  const waiting = slow.timers.filter((timer) => timer.ms === 3000 && !timer.cleared);
  assert.strictEqual(waiting.length, 1);
  assert.ok(waiting[0].ms <= 3000);
  waiting[0].fn();
  assert.ok(slow.removed.includes('ab-hide'), 'the 3 second timeout must reveal the page');
  slow.button.click();
  assert.deepStrictEqual(slow.buttonClicks, ['page']);
  assert.deepStrictEqual(slow.warnings, []);

  const thrown = harness({ cookieThrows: true });
  boot(thrown);
  await flush();
  assert.ok(thrown.removed.includes('ab-hide'), 'a thrown snippet must still reveal the page');
  assert.deepStrictEqual(thrown.warnings, []);
  assert.deepStrictEqual(thrown.writes, []);
  thrown.button.click();
  assert.deepStrictEqual(thrown.buttonClicks, ['page']);

  const denied = harness({
    cookiebot: { consent: { statistics: false } },
    fetch: async () => { throw new Error('should not fetch'); },
  });
  boot(denied);
  await flush();
  assert.deepStrictEqual(denied.writes, [], 'consent denied must not write tracking storage');
  assert.ok(denied.removed.includes('ab-hide'));
  denied.button.click();
  assert.deepStrictEqual(denied.buttonClicks, ['page']);

  const withdrawn = harness({
    pivitConsent: true,
    fetch: async () => experimentsPayload(),
  });
  boot(withdrawn);
  await flush();
  assert.ok(withdrawn.writes.some((key) => key === '_ab_visitor_id'));
  assert.ok(withdrawn.writes.some((key) => key.indexOf('_ab_assign_') === 0));
  assert.ok(withdrawn.beacons.length >= 1);
  const writesBefore = withdrawn.writes.length;
  const beaconsBefore = withdrawn.beacons.length;
  withdrawn.sandbox.window.pivitConsent = false;
  withdrawn.button.click();
  await flush();
  assert.strictEqual(withdrawn.writes.length, writesBefore, 'withdrawn consent must not store more');
  assert.strictEqual(withdrawn.beacons.length, beaconsBefore, 'withdrawn consent must not send more');
  assert.deepStrictEqual(withdrawn.buttonClicks, ['page']);

  const open = harness({
    fetch: async () => experimentsPayload(),
  });
  boot(open);
  await flush();
  assert.ok(open.writes.some((key) => key === '_ab_visitor_id'), 'no CMP keeps the current storage behaviour');

  const quiet = harness({
    pivitConsent: true,
    beaconThrows: true,
    fetch: async () => experimentsPayload(),
  });
  boot(quiet);
  await flush();
  const retry = quiet.timers.filter((timer) => timer.ms === 1000 && !timer.cleared);
  assert.ok(retry.length >= 1, 'a failed event is queued for one quiet retry');
  retry[0].fn();
  assert.deepStrictEqual(quiet.warnings, []);

  console.log('safe failure tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
