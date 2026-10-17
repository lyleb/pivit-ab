// Public-page cookie consent. Tag Manager stays off the dashboard and the snippet.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const CONSENT_DEFAULT = [
  '<script>',
  'window.dataLayer=window.dataLayer||[];',
  'function gtag(){dataLayer.push(arguments);}',
  "gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});",
  '</script>',
].join('\n');

const PUBLIC_PAGES = [
  'src/pages/landing.html',
  'public/privacy.html',
  'public/legal.html',
];

const APP_PAGES = [
  'public/index.html',
  'public/login.html',
  'public/signup.html',
  'public/check-email.html',
  'public/client.html',
  'public/sign-in.html',
  'src/pages/owner.html',
];

function pageChecks() {
  for (const rel of PUBLIC_PAGES) {
    const html = read(rel);
    assert.ok(html.includes(CONSENT_DEFAULT), rel + ' missing the consent default');
    const firstScript = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    assert.ok(firstScript.includes("gtag('consent','default'"), rel + ' default is not the first script');
    assert.ok(firstScript.includes("analytics_storage:'denied'"), rel);
    assert.ok(firstScript.includes("ad_storage:'denied'"), rel);
    assert.ok(firstScript.includes("ad_user_data:'denied'"), rel);
    assert.ok(firstScript.includes("ad_personalization:'denied'"), rel);
    const defaultAt = html.indexOf("gtag('consent','default'");
    const scriptAt = html.indexOf('src="/consent.js?v=1"');
    assert.ok(defaultAt !== -1 && scriptAt > defaultAt, rel + ' loads consent.js before the default');
    assert.ok(html.includes('href="/consent.css?v=2"'), rel);
    assert.ok(html.includes('data-cookie-settings'), rel);
    assert.ok(html.includes('>Cookie settings</button>'), rel);
    assert.ok(!html.includes('googletagmanager'), rel);
    assert.ok(!html.includes('clarity.ms'), rel);
    assert.ok(!html.includes('gtm.js'), rel);
    assert.ok(!html.includes('Pivitlab'), rel);
    assert.ok(!html.includes('PivitLab'), rel);
  }

  for (const rel of APP_PAGES) {
    const html = read(rel);
    assert.ok(!html.includes('/consent.js'), rel);
    assert.ok(!html.includes('/consent.css'), rel);
    assert.ok(!html.includes('pivitlab_analytics_consent'), rel);
    assert.ok(!html.includes('GTM-KZCDC3HJ'), rel);
    assert.ok(!html.includes('googletagmanager'), rel);
    assert.ok(!html.includes("gtag('consent'"), rel);
  }

  const snippets = fs.readdirSync(path.join(root, 'snippet')).filter((name) => name.endsWith('.js'));
  assert.ok(snippets.includes('ab.js'));
  for (const name of snippets) {
    const src = read(path.join('snippet', name));
    assert.ok(!src.includes('GTM-KZCDC3HJ'), name);
    assert.ok(!src.includes('googletagmanager'), name);
    assert.ok(!src.includes('pivitlab_analytics_consent'), name);
    assert.ok(!src.includes("gtag('consent'"), name);
    assert.ok(!src.includes('G-NT78JHVHGY'), name);
  }

  assert.ok(!read('src/pages/landing.html').includes('GTM-KZCDC3HJ'));

  const consentJs = read('public/consent.js');
  const consentCss = read('public/consent.css');
  assert.ok(consentJs.includes("STORAGE_KEY = 'pivitlab_analytics_consent'"));
  assert.ok(consentJs.includes("GTM_ID = 'GTM-KZCDC3HJ'"));
  assert.ok(consentJs.includes('https://www.googletagmanager.com/gtm.js?id='));
  assert.ok(!consentJs.includes('clarity.ms'));
  assert.ok(!consentJs.includes('G-NT78JHVHGY'));
  assert.ok(consentJs.includes("We use cookies to see how the site's used. Is that OK?"));
  assert.ok(consentJs.includes("textContent = 'Reject'"));
  assert.ok(consentJs.includes("textContent = 'Accept'"));

  const acceptBody = consentJs.slice(consentJs.indexOf('function accept()'), consentJs.indexOf('function reject()'));
  assert.ok(acceptBody.indexOf('updateConsent(ANALYTICS_GRANTED)') < acceptBody.indexOf('loadGtm()'));
  assert.ok(!acceptBody.includes('googletagmanager'));
  const rejectBody = consentJs.slice(consentJs.indexOf('function reject()'), consentJs.indexOf('function openBanner()'));
  assert.ok(!rejectBody.includes('loadGtm'));
  assert.ok(!rejectBody.includes('googletagmanager'));
  assert.ok(rejectBody.includes('clearAnalyticsCookies()'));

  assert.ok(consentCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
  assert.ok(consentCss.includes('.pivit-consent button.pivit-consent-accept,\n.pivit-consent button.pivit-consent-reject'));
  assert.ok(consentCss.includes('min-height: 40px'));
  assert.ok(consentCss.includes('width: 100%'));
  assert.ok(consentCss.includes('position: fixed'));
  assert.ok(consentCss.includes('right:'));
  assert.ok(consentCss.includes('bottom:'));
  assert.ok(!consentCss.includes('inset:'));
  assert.ok(consentCss.includes('.pivit-consent[hidden]'));

  const privacy = read('public/privacy.html');
  assert.ok(privacy.includes('id="cookies"'));
  assert.ok(privacy.includes('Placeholder for Lyle to write'));
  assert.ok(privacy.includes("Lyle's wording"));
  for (const phrase of [
    'GTM-KZCDC3HJ',
    'G-NT78JHVHGY',
    'pivitlab_analytics_consent',
    '<code>_ga</code>',
    '<code>_ga_*</code>',
    '<code>_clck</code>',
    '<code>_clsk</code>',
    '<code>CLID</code>',
    '<code>MUID</code>',
    '<code>ANONCHK</code>',
    '<code>MR</code>',
    '<code>SM</code>',
    'Google is the processor',
    'Microsoft is the processor',
    'After Accept only.',
    'TODO',
  ]) {
    assert.ok(privacy.includes(phrase), 'privacy missing ' + phrase);
  }
}

function createHarness(options) {
  const store = Object.assign({}, options.storage || {});
  const scripts = [];
  const bodyChildren = [];
  const settings = options.settings || [];
  let cookie = options.cookie || '';
  const doc = {
    body: { appendChild(node) { bodyChildren.push(node); return node; } },
    head: {
      appendChild(node) {
        node.dataLayerAtAppend = global.dataLayer.slice();
        scripts.push(node);
        return node;
      },
    },
    addEventListener() {},
    createElement() {
      return {
        className: '',
        textContent: '',
        hidden: false,
        async: false,
        src: '',
        tabIndex: 0,
        type: '',
        id: '',
        children: [],
        attrs: {},
        listeners: {},
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return this.attrs[name] == null ? null : this.attrs[name]; },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        focus() { this.focused = true; },
      };
    },
    querySelector(sel) {
      if (sel === 'script[data-pivitlab-gtm]') {
        return scripts.find((script) => script.attrs['data-pivitlab-gtm']) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-cookie-settings]') return settings;
      return [];
    },
  };
  Object.defineProperty(doc, 'cookie', {
    configurable: true,
    get() { return cookie; },
    set(value) {
      const name = String(value).split('=')[0].trim();
      const parts = cookie.split(';').map((part) => part.trim()).filter(Boolean);
      const kept = parts.filter((part) => part.split('=')[0].trim() !== name);
      if (!/expires=Thu, 01 Jan 1970/i.test(value)) kept.push(String(value));
      cookie = kept.join('; ');
    },
  });
  settings.forEach((button) => {
    button.attrs = button.attrs || {};
    button.listeners = {};
    button.getAttribute = function (name) { return button.attrs[name] == null ? null : button.attrs[name]; };
    button.setAttribute = function (name, value) { button.attrs[name] = String(value); };
    button.addEventListener = function (type, fn) { button.listeners[type] = fn; };
  });

  const timers = [];
  const previous = {
    document: global.document,
    localStorage: global.localStorage,
    location: global.location,
    dataLayer: global.dataLayer,
    gtag: global.gtag,
    clarity: global.clarity,
    setTimeout: global.setTimeout,
  };
  global.document = doc;
  global.localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  };
  global.location = { hostname: options.hostname || 'pivitlab.com' };
  global.dataLayer = [];
  delete global.gtag;
  if (options.clarity) global.clarity = options.clarity;
  else delete global.clarity;
  global.setTimeout = function (fn, delay) {
    timers.push({ fn, delay });
    return timers.length;
  };

  function restore() {
    global.document = previous.document;
    global.localStorage = previous.localStorage;
    global.location = previous.location;
    global.dataLayer = previous.dataLayer;
    if (previous.gtag === undefined) delete global.gtag;
    else global.gtag = previous.gtag;
    if (previous.clarity === undefined) delete global.clarity;
    else global.clarity = previous.clarity;
    global.setTimeout = previous.setTimeout;
  }

  return {
    store,
    scripts,
    bodyChildren,
    settings,
    timers,
    restore,
    getCookie() { return cookie; },
    setCookie(value) { cookie = value; },
  };
}

function loadConsent(options) {
  const harness = createHarness(options || {});
  const resolved = require.resolve('../public/consent');
  delete require.cache[resolved];
  const api = require('../public/consent');
  return { api, harness };
}

function consentEntries(dataLayer) {
  return dataLayer.filter((entry) => entry && entry[0] === 'consent');
}

function behaviourChecks() {
  const names = require('../public/consent');
  // The require above boots against whatever document is installed. Reload per case.
  assert.strictEqual(names.isAnalyticsCookie('_ga'), true);
  assert.strictEqual(names.isAnalyticsCookie('_ga_NT78JHVHGY'), true);
  assert.strictEqual(names.isAnalyticsCookie('_gaextra'), false);
  assert.strictEqual(names.isAnalyticsCookie('_gid'), false);
  assert.strictEqual(names.isAnalyticsCookie('_clck'), true);
  assert.strictEqual(names.isAnalyticsCookie('_clsk'), true);
  assert.strictEqual(names.isAnalyticsCookie('CLID'), false);
  assert.strictEqual(names.isAnalyticsCookie('MUID'), false);
  assert.strictEqual(names.isAnalyticsCookie('pivit.sid'), false);

  let loaded = loadConsent({});
  try {
    const banner = loaded.harness.bodyChildren[0];
    assert.strictEqual(banner.hidden, false);
    assert.strictEqual(banner.focused, true);
    assert.strictEqual(loaded.harness.scripts.length, 0);
    assert.strictEqual(loaded.api.readChoice(), null);
    assert.deepStrictEqual(loaded.api.ANALYTICS_GRANTED, { analytics_storage: 'granted' });
  } finally {
    loaded.harness.restore();
  }

  loaded = loadConsent({ storage: { pivitlab_analytics_consent: 'maybe' } });
  try {
    assert.strictEqual(loaded.harness.bodyChildren[0].hidden, false);
    assert.strictEqual(loaded.harness.scripts.length, 0);
  } finally {
    loaded.harness.restore();
  }

  loaded = loadConsent({ storage: { pivitlab_analytics_consent: 'denied' } });
  try {
    assert.strictEqual(loaded.harness.bodyChildren[0].hidden, true);
    assert.strictEqual(loaded.harness.scripts.length, 0);
    assert.strictEqual(loaded.harness.timers.length, 0);
  } finally {
    loaded.harness.restore();
  }

  loaded = loadConsent({ storage: { pivitlab_analytics_consent: 'granted' } });
  try {
    const script = loaded.harness.scripts[0];
    assert.ok(script);
    assert.strictEqual(script.src, 'https://www.googletagmanager.com/gtm.js?id=GTM-KZCDC3HJ');
    assert.strictEqual(script.attrs['data-pivitlab-gtm'], 'GTM-KZCDC3HJ');
    const at = script.dataLayerAtAppend;
    const consentAt = at.findIndex((entry) => entry && entry[0] === 'consent' && entry[1] === 'update');
    const gtmAt = at.findIndex((entry) => entry && entry.event === 'gtm.js');
    assert.ok(consentAt !== -1 && gtmAt !== -1 && consentAt < gtmAt);
    assert.deepStrictEqual(at[consentAt][2], { analytics_storage: 'granted' });
    assert.strictEqual(loaded.harness.bodyChildren[0].hidden, true);
    loaded.api.accept();
    assert.strictEqual(loaded.harness.scripts.length, 1);
  } finally {
    loaded.harness.restore();
  }

  const calls = [];
  loaded = loadConsent({
    clarity(command, payload) { calls.push([command, payload]); },
    cookie: '_ga=1; _ga_NT78JHVHGY=2; _gaextra=keep; _gid=keep; _clck=3; _clsk=4; CLID=keep; MUID=keep; pivit.sid=keep',
  });
  try {
    assert.strictEqual(loaded.api.accept(), true);
    assert.strictEqual(loaded.harness.store.pivitlab_analytics_consent, 'granted');
    assert.deepStrictEqual(calls[0], ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }]);
    const granted = consentEntries(global.dataLayer).pop();
    assert.strictEqual(granted[1], 'update');
    assert.deepStrictEqual(granted[2], { analytics_storage: 'granted' });
    assert.strictEqual(loaded.harness.scripts.length, 1);

    loaded.harness.setCookie('_ga=1; _ga_NT78JHVHGY=2; _clck=3; _clsk=4; CLID=keep; MUID=keep; pivit.sid=keep; _gaextra=keep');
    assert.strictEqual(loaded.api.reject(), true);
    assert.strictEqual(loaded.harness.store.pivitlab_analytics_consent, 'denied');
    assert.strictEqual(loaded.harness.scripts.length, 1);
    const denied = consentEntries(global.dataLayer).pop();
    assert.deepStrictEqual(denied[2], {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    assert.deepStrictEqual(calls[1], ['consent', false]);
    const cleared = loaded.harness.getCookie();
    assert.ok(!/(^|; )_ga=/.test(cleared), cleared);
    assert.ok(!cleared.includes('_ga_NT78JHVHGY'), cleared);
    assert.ok(!cleared.includes('_clck'), cleared);
    assert.ok(!cleared.includes('_clsk'), cleared);
    assert.ok(cleared.includes('CLID=keep'), cleared);
    assert.ok(cleared.includes('MUID=keep'), cleared);
    assert.ok(cleared.includes('pivit.sid=keep'), cleared);
    assert.ok(cleared.includes('_gaextra=keep'), cleared);
    assert.deepStrictEqual(loaded.harness.timers.map((timer) => timer.delay), [500, 2000]);

    loaded.harness.setCookie('_ga=late; _clsk=late; pivit.sid=keep; CLID=keep');
    assert.strictEqual(loaded.api.accept(), true);
    loaded.harness.timers.forEach((timer) => timer.fn());
    const kept = loaded.harness.getCookie();
    assert.ok(kept.includes('_ga=late'), kept);
    assert.ok(kept.includes('_clsk=late'), kept);
    assert.ok(kept.includes('pivit.sid=keep'), kept);
  } finally {
    loaded.harness.restore();
  }

  loaded = loadConsent({});
  try {
    assert.strictEqual(loaded.api.reject(), true);
    assert.strictEqual(loaded.harness.scripts.length, 0);
    assert.ok(!global.dataLayer.some((entry) => entry && entry.event === 'gtm.js'));
    loaded.harness.setCookie('_ga=late; _clck=late; pivit.sid=keep; CLID=keep');
    loaded.harness.timers.forEach((timer) => timer.fn());
    const left = loaded.harness.getCookie();
    assert.ok(!/(^|; )_ga=/.test(left), left);
    assert.ok(!left.includes('_clck'), left);
    assert.ok(left.includes('pivit.sid=keep'), left);
    assert.ok(left.includes('CLID=keep'), left);
  } finally {
    loaded.harness.restore();
  }

  const button = { attrs: {} };
  loaded = loadConsent({
    storage: { pivitlab_analytics_consent: 'denied' },
    settings: [button],
  });
  try {
    assert.strictEqual(loaded.harness.bodyChildren[0].hidden, true);
    let prevented = false;
    button.listeners.click({ preventDefault() { prevented = true; } });
    assert.strictEqual(prevented, true);
    assert.strictEqual(loaded.harness.bodyChildren[0].hidden, false);
    assert.strictEqual(loaded.harness.scripts.length, 0);
  } finally {
    loaded.harness.restore();
  }

  loaded = loadConsent({
    hostname: 'www.pivitlab.com',
    cookie: '_ga=1; _clsk=2',
  });
  try {
    const writes = [];
    const doc = global.document;
    const descriptor = Object.getOwnPropertyDescriptor(doc, 'cookie');
    const originalSet = descriptor.set;
    Object.defineProperty(doc, 'cookie', {
      configurable: true,
      get: descriptor.get,
      set(value) {
        writes.push(value);
        originalSet.call(doc, value);
      },
    });
    loaded.api.clearAnalyticsCookies();
    assert.ok(writes.some((value) => value.includes('domain=www.pivitlab.com')));
    assert.ok(writes.some((value) => value.includes('domain=.pivitlab.com')));
    assert.ok(writes.some((value) => value.startsWith('_ga=')));
    assert.ok(writes.some((value) => value.startsWith('_clsk=')));
  } finally {
    loaded.harness.restore();
  }
}

pageChecks();
behaviourChecks();
console.log('consent tests passed');
