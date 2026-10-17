// Cookie choice for the public pivitlab pages only (home, privacy, terms).
// The dashboard, sign-in pages, and snippet/ab.js do not load this file.
// Google Tag Manager is inserted only after Accept. Reject loads nothing.
(function (window) {
  var STORAGE_KEY = 'pivitlab_analytics_consent';
  var GTM_ID = 'GTM-KZCDC3HJ';
  var GTM_SRC = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
  var ANALYTICS_GRANTED = { analytics_storage: 'granted' };
  var ALL_DENIED = {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  };

  var state = {
    started: false,
    generation: 0,
    gtmLoaded: false,
    banner: null,
  };

  function ensureGtag() {
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function gtag() {
        window.dataLayer.push(arguments);
      };
    }
  }

  function updateConsent(payload) {
    ensureGtag();
    window.gtag('consent', 'update', payload);
  }

  function readChoice() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      if (value === 'granted' || value === 'denied') return value;
    } catch (err) { /* private mode or blocked storage */ }
    return null;
  }

  function persist(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
      return readChoice() === value;
    } catch (err) {
      return false;
    }
  }

  function isAnalyticsCookie(name) {
    return name === '_ga' || name.indexOf('_ga_') === 0 || name === '_clck' || name === '_clsk';
  }

  function clearAnalyticsCookies() {
    var doc = window.document;
    if (!doc) return;
    var hostname = (window.location && window.location.hostname) || '';
    var names;
    try {
      names = String(doc.cookie || '').split(';').map(function (part) {
        return part.split('=')[0].trim();
      }).filter(function (name) {
        return name && isAnalyticsCookie(name);
      });
    } catch (err) {
      return;
    }
    var root = hostname.indexOf('.') === -1
      ? hostname
      : hostname.split('.').slice(-2).join('.');
    var expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    names.forEach(function (name) {
      var variants = [
        name + '=; ' + expires + '; path=/',
        name + '=; ' + expires + '; path=/; domain=' + hostname,
        name + '=; ' + expires + '; path=/; domain=.' + root,
      ];
      variants.forEach(function (cookie) {
        try { doc.cookie = cookie; } catch (err) { /* host rejected this domain */ }
      });
    });
  }

  function signalClarityGranted() {
    if (typeof window.clarity !== 'function') return;
    try {
      window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
    } catch (err) { /* Clarity queue rejected the call */ }
  }

  function signalClarityDenied() {
    if (typeof window.clarity !== 'function') return;
    try { window.clarity('consent', false); } catch (err) { /* already gone */ }
  }

  function loadGtm() {
    if (state.gtmLoaded) return;
    var doc = window.document;
    if (!doc || !doc.head) return;
    if (doc.querySelector('script[data-pivitlab-gtm]')) {
      state.gtmLoaded = true;
      return;
    }
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var script = doc.createElement('script');
    script.async = true;
    script.src = GTM_SRC;
    script.setAttribute('data-pivitlab-gtm', GTM_ID);
    doc.head.appendChild(script);
    state.gtmLoaded = true;
  }

  function hideBanner() {
    if (state.banner) state.banner.hidden = true;
  }

  function showBanner() {
    if (!state.banner) return;
    state.banner.hidden = false;
    if (typeof state.banner.focus === 'function') state.banner.focus();
  }

  function ensureBanner() {
    if (state.banner || !window.document || !window.document.body) return;
    var doc = window.document;
    var banner = doc.createElement('div');
    banner.className = 'pivit-consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-labelledby', 'pivit-consent-title');
    banner.tabIndex = -1;
    banner.hidden = true;

    var copy = doc.createElement('p');
    copy.id = 'pivit-consent-title';
    copy.textContent = "We use cookies to see how the site's used. Is that OK?";

    var more = doc.createElement('p');
    more.className = 'pivit-consent-more';
    var privacy = doc.createElement('a');
    privacy.href = '/privacy.html#cookies';
    privacy.textContent = 'Privacy';
    more.appendChild(privacy);

    var actions = doc.createElement('div');
    actions.className = 'pivit-consent-actions';

    var rejectBtn = doc.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'pivit-consent-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', function () { reject(); });

    var acceptBtn = doc.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'pivit-consent-accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', function () { accept(); });

    actions.appendChild(rejectBtn);
    actions.appendChild(acceptBtn);
    banner.appendChild(copy);
    banner.appendChild(more);
    banner.appendChild(actions);
    doc.body.appendChild(banner);
    state.banner = banner;
  }

  function bindSettings() {
    if (!window.document || typeof window.document.querySelectorAll !== 'function') return;
    var links = window.document.querySelectorAll('[data-cookie-settings]');
    Array.prototype.forEach.call(links, function (link) {
      if (link.getAttribute('data-cookie-bound') === '1') return;
      link.setAttribute('data-cookie-bound', '1');
      link.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        openBanner();
      });
    });
  }

  function accept() {
    if (!persist('granted')) return false;
    state.generation += 1;
    hideBanner();
    updateConsent(ANALYTICS_GRANTED);
    signalClarityGranted();
    loadGtm();
    return true;
  }

  function reject() {
    if (!persist('denied')) return false;
    var generation = ++state.generation;
    hideBanner();
    updateConsent(ALL_DENIED);
    signalClarityDenied();
    clearAnalyticsCookies();
    [500, 2000].forEach(function (delay) {
      window.setTimeout(function () {
        if (generation !== state.generation) return;
        if (readChoice() !== 'denied') return;
        clearAnalyticsCookies();
      }, delay);
    });
    return true;
  }

  function openBanner() {
    ensureBanner();
    showBanner();
  }

  function init() {
    if (state.started) return;
    state.started = true;
    ensureBanner();
    bindSettings();
    var choice = readChoice();
    if (choice === 'granted') {
      hideBanner();
      updateConsent(ANALYTICS_GRANTED);
      signalClarityGranted();
      loadGtm();
      return;
    }
    if (choice === 'denied') {
      hideBanner();
      return;
    }
    showBanner();
  }

  function boot() {
    if (window.document && window.document.body) init();
    else if (window.document && typeof window.document.addEventListener === 'function') {
      window.document.addEventListener('DOMContentLoaded', init);
    }
  }

  boot();

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    GTM_ID: GTM_ID,
    GTM_SRC: GTM_SRC,
    ANALYTICS_GRANTED: ANALYTICS_GRANTED,
    ALL_DENIED: ALL_DENIED,
    readChoice: readChoice,
    isAnalyticsCookie: isAnalyticsCookie,
    clearAnalyticsCookies: clearAnalyticsCookies,
    accept: accept,
    reject: reject,
    openBanner: openBanner,
    init: init,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
