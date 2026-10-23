/**
 * pivitlab snippet — v0.8
 *
 * Usage on client site:
 *   <script src="https://your-api.example.com/snippet/ab.js"
 *           data-api="https://your-api.example.com"
 *           data-site="site_…"></script>
 *
 * data-site is the public site key. Tags that omit it (including ones that
 * still point at pivit.click) keep working for the original account only.
 *
 * Fetches active experiments for the current page, assigns the visitor
 * to a variant per experiment (sticky via localStorage), applies DOM
 * changes, and reports view/click events back to the API.
 *
 * Test traffic: ?pivit_qa=1 on the customer page is stored in localStorage and a
 * first-party cookie (pivit_qa). ?pivit_qa=0 clears both. While that flag is
 * set, event beacons include "is_test": true and API calls add pivit_qa=1.
 * No custom header is sent — sendBeacon cannot set one. Visitor ids starting
 * with v_pt are test traffic even without the flag.
 *
 * A demo test (test_type "demo") is test traffic only. A real visitor is not
 * bucketed: no assignment, no change, no view. pivit_qa and v_pt still run.
 *
 * Change applied: a view beacon may include change_applied true or false.
 * True means every element selector was on the page and the change ran.
 * The field is left off when the variant has no element change to check,
 * and it is left off clicks and conversions. It rides on the view beacon,
 * so it does not add a request. Test visits still send it; the health
 * percentage leaves those visits out.
 *
 * Element targeting: an experiment may set element_selector. The URL rule
 * still has to match. The visitor is bucketed, the variant is applied, and
 * the view is sent only once that element is on the page. A MutationObserver
 * waits up to about four seconds. If the element never appears there is no
 * assignment, no view, and nothing is applied. Pages that will never have
 * the element are not held blank for that wait. Preview uses the same gate
 * and names the selector in the preview note.
 *
 * Preview mode: the dashboard opens ?ab_preview=<variant_id>&ab_preview_token=<token>.
 * The token is signed and expires. It can show a draft, paused or disabled
 * variant and never logs a view or conversion. An archived test is not shown:
 * the page gets an expired notice and the editor is not loaded. A preview link without a valid
 * token is ignored, so drafts are not served to anyone who guesses the URL.
 * If the URL still has an older ab_edit or ab_preview (a leftover from the
 * previous test), the last one wins, and preview applies only that experiment.
 * ?pivit_device=desktop|tablet|mobile (with a preview token) opens device
 * frames. The frame reloads the page without that parameter, so the variant's
 * CSS, HTML and JavaScript run inside the frame the same way they do live,
 * including whole-page CSS (page_css), whole-page JavaScript (page_js) and
 * a banner. Switching device or refreshing loads the frame again, including
 * JavaScript that runs once on load. A normal visit ignores pivit_device.
 *
 * page_css adds one <style> in the head. Applying it again updates that tag
 * and does not add a second one. page_js runs once per page view, not once
 * per element. A second apply, a new applier on the same document (an SPA
 * re-render), and the mutation observer all leave it unrun. A thrown error
 * is caught so the rest of the page still runs. Element html, stylesheet
 * and js are unchanged.
 *
 * banner is one bar for the page, at the top or the bottom. Sticky bars use
 * position:fixed; the others use position:absolute and scroll away. Either
 * way the page gets padding equal to the bar's height so the bar does not
 * cover the content. A viewport up to 640px wide uses a smaller type size
 * and tighter padding, which is what the mobile device frame is. Applying
 * the change again, starting a new applier on the same document (an SPA
 * route change), or a mutation all keep a single bar. The countdown is a
 * fixed instant, or the next Europe/London midnight. That midnight follows
 * British Summer Time, so the short day in spring and the long day in
 * autumn are both the real gap until midnight.
 *
 * Anti-flicker: if the anti-flicker snippet (from the dashboard's "Copy
 * Snippet" popover) is also installed in <head>, it hides the page via an
 * `ab-hide` class on <html>. This file removes that class as soon as DOM
 * changes are applied, so the reveal happens as fast as possible rather than
 * waiting for anything else (e.g. goal-checking) to finish. The anti-flicker
 * snippet has its own 3-second timeout as a safety net, so this file doesn't
 * need one — if you skip installing it, this call is just a harmless no-op.
 *
 * Cookie/consent handling: this snippet writes to localStorage to recognize
 * a visitor, which generally requires consent under UK/EU rules (PECR, GDPR)
 * unless it's covered by a legitimate "strictly necessary" exemption — talk to
 * a lawyer or the client's DPO for a definitive answer on a given site. Before
 * doing anything, hasTrackingConsent() below checks, in order: (1) a manual
 * window.pivitConsent boolean, if the site owner has set one explicitly; (2)
 * Cookiebot; (3) OneTrust; (4) CookieYes. If none of those are present at all,
 * it defaults to running as before (unchanged behavior) — there's no CMP to
 * take a signal from, and whether that's fine is a call for whoever runs the
 * site. If a site uses a different CMP, wire up window.pivitConsent manually.
 *
 * Send to GA4: when the API includes a ga4 measurement id, an assignment
 * sends one experience_impression through the gtag or dataLayer already on
 * the page. The parameter exp_variant_string is the test name and id, then
 * the variant name and id, which is the shape VWO and Optimizely use. The
 * same page view is sent once. A single-page app sends it again when the
 * address changes. Preview and pivit_qa / v_pt visits are not sent. This
 * file does not load Google Analytics, does not call gtag.js, and does not
 * set Google cookies. If gtag and dataLayer are both missing, nothing is
 * sent. If Google Consent Mode has already set analytics storage to denied,
 * nothing is sent until that state is granted.
 *
 * Selectors and applying changes live on PivitRuntime (also exported for tests).
 * The visual editor uses the same helpers, so a selector saved from the editor
 * is what visitors get. Positional selectors (nth-child / nth-of-type and the
 * other structural pseudos) are applied once, inline, exactly as before.
 */
(function (root) {
  const ELEMENT_WAIT_MS = 4000;
  const api = buildPivitRuntime();
  const clickSeen = Object.create(null);
  api.matchUrlGoal = matchUrlGoal;
  api.isSafeRegex = isSafeRegex;
  api.shouldCountUrlGoal = shouldCountUrlGoal;
  api.claimClick = claimClick;
  api.clickStorageKey = clickStorageKey;
  api.qaFlagFromSearch = qaFlagFromSearch;
  api.applyQaFlag = applyQaFlag;
  api.readQaFlag = readQaFlag;
  api.eventBody = eventBody;
  api.withQaQuery = withQaQuery;
  api.withSite = withSite;
  api.ELEMENT_WAIT_MS = ELEMENT_WAIT_MS;
  api.elementSelectorOf = elementSelectorOf;
  api.elementQuery = elementQuery;
  api.elementIsPresent = elementIsPresent;
  api.waitForElement = waitForElement;
  api.exposeWhenReady = exposeWhenReady;
  api.previewInfo = previewInfo;
  api.mayBucketExperiment = mayBucketExperiment;
  api.assignVariant = assignVariant;
  api.normaliseGa4MeasurementId = normaliseGa4MeasurementId;
  api.expVariantString = expVariantString;
  api.pageViewKey = pageViewKey;
  api.analyticsStorageState = analyticsStorageState;
  api.analyticsConsentAllows = analyticsConsentAllows;
  api.ga4Transport = ga4Transport;
  api.planExperienceImpressions = planExperienceImpressions;
  api.deliverExperienceImpression = deliverExperienceImpression;
  api.markImpressionsSent = markImpressionsSent;
  api.sendPlannedImpressions = sendPlannedImpressions;
  api.watchAnalyticsConsent = watchAnalyticsConsent;
  api.bindSpaRouteChanges = bindSpaRouteChanges;
  api.TEST_VISITOR_PREFIX = 'v_pt';
  api.QA_STORAGE_KEY = 'pivit_qa';
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.PivitRuntime = api;

  // document.currentScript can be unreliable when a script is injected
  // dynamically by a tag manager (GTM, etc.) rather than parsed directly from
  // the page's HTML — fall back to finding it by its own src if needed.
  const scriptTag = document.currentScript || document.querySelector('script[src*="/snippet/ab.js"]');

  // API_BASE prefers an explicit data-api attribute, but falls back to the
  // script's own origin if that's missing — the snippet and the API are always
  // served from the same host, so this works even if data-api got dropped
  // somewhere (an easy mistake when copy-pasting into a tag manager, since
  // it's a separate attribute from src and simple to miss).
  let API_BASE = '';
  if (scriptTag) {
    const explicitApiBase = scriptTag.getAttribute('data-api');
    if (explicitApiBase) {
      API_BASE = explicitApiBase;
    } else if (scriptTag.src) {
      try {
        API_BASE = new URL(scriptTag.src, document.baseURI).origin;
      } catch (e) {
        API_BASE = '';
      }
    }
  }
  const rawSite = scriptTag && scriptTag.getAttribute('data-site');
  const SITE_KEY = withSite('http://s', rawSite) === 'http://s' ? '' : String(rawSite).trim();
  const VISITOR_KEY = '_ab_visitor_id';
  let qaOn = false;
  const ga4Sent = Object.create(null);
  const ga4Gate = {};
  let ga4Config = null;
  let ga4Experiments = [];
  let ga4Reporting = false;
  let ga4Nav = 0;
  const ASSIGNMENT_PREFIX = '_ab_assign_';
  // Bump when editor.js changes so a cached copy cannot keep the old variant.
  const EDITOR_VERSION = '20261021a';
  // Bump when device-preview.js changes so a cached shell cannot skip JavaScript.
  const DEVICE_PREVIEW_VERSION = '20261021a';

  // The first query value is the leftover. The last ab_edit or ab_preview is
  // the link the owner just opened.
  function lastQuery(params, name) {
    const values = params.getAll(name).filter((value) => value);
    return values.length ? values[values.length - 1] : null;
  }

  // Only these three open a device frame. Anything else is a normal preview.
  function previewDevice(value) {
    const name = String(value || '').toLowerCase();
    if (name === 'desktop' || name === 'tablet' || name === 'mobile') return name;
    return '';
  }

  // The shell covers this document. The framed copy of the page, without
  // pivit_device, is what applies the variant. Loaded only for a preview.
  function mountDevicePreview(device) {
    if (document.getElementById('pivit-device-shell')) return;
    const shell = document.createElement('div');
    shell.setAttribute('id', 'pivit-device-shell');
    shell.setAttribute('data-device', device);
    shell.style.position = 'fixed';
    shell.style.inset = '0';
    shell.style.zIndex = '2147483647';
    shell.style.background = '#e8eaef';
    (document.documentElement || document.body).appendChild(shell);
    const previous = document.querySelectorAll('script[data-pivit-device-preview]');
    for (let i = 0; i < previous.length; i++) previous[i].remove();
    const loader = document.createElement('script');
    loader.src = `${API_BASE}/snippet/device-preview.js?v=${DEVICE_PREVIEW_VERSION}`;
    loader.async = false;
    loader.setAttribute('data-pivit-device-preview', '1');
    loader.setAttribute('data-api', API_BASE);
    loader.setAttribute('data-device', device);
    document.head.appendChild(loader);
  }

  function pageMode() {
    const params = new URLSearchParams(window.location.search);
    let mode = null;
    for (const [key, value] of params) {
      if (!value) continue;
      if (key === 'ab_edit') mode = { type: 'edit', variantId: value };
      else if (key === 'ab_preview') mode = { type: 'preview', variantId: value };
    }
    if (!mode) return { type: null, variantId: null, token: null };
    mode.token = mode.type === 'edit' ? lastQuery(params, 'token') : lastQuery(params, 'ab_preview_token');
    return mode;
  }

  function revealPage() {
    document.documentElement.classList.remove('ab-hide');
  }

  // An archived test's edit or preview link does not open the editor and does
  // not apply the variant. The notice names the test and links to it.
  function showExpiredNotice(data) {
    if (document.getElementById('pivit-expired-link')) return;
    const payload = data || {};
    const test = payload.test || {};
    const variant = payload.variant || {};
    const banner = document.createElement('div');
    banner.id = 'pivit-expired-link';
    banner.setAttribute('role', 'status');
    banner.style.position = 'fixed';
    banner.style.top = '0';
    banner.style.left = '0';
    banner.style.right = '0';
    banner.style.zIndex = '2147483647';
    banner.style.background = '#fff8e8';
    banner.style.color = '#3f3420';
    banner.style.padding = '16px 20px';
    banner.style.fontFamily = '-apple-system, "Segoe UI", Roboto, sans-serif';
    banner.style.fontSize = '14px';
    banner.style.lineHeight = '1.45';
    banner.style.boxShadow = '0 2px 10px rgba(19,23,35,0.12)';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = payload.message || payload.error || 'This link has expired.';
    banner.appendChild(title);

    function line(label, value) {
      if (!value) return;
      const row = document.createElement('div');
      row.appendChild(document.createTextNode(label + ': '));
      const strong = document.createElement('strong');
      strong.textContent = value;
      row.appendChild(strong);
      banner.appendChild(row);
    }
    line('Test', test.name);
    line('Variant', variant.name);
    line('Status', test.status_label || 'Archived');

    const url = typeof test.url === 'string' ? test.url : '';
    if (/^https?:\/\//i.test(url)) {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = test.link_label || 'Open the test in pivitlab';
      link.style.display = 'inline-block';
      link.style.marginTop = '8px';
      link.style.color = '#4527d6';
      link.style.fontWeight = '650';
      banner.appendChild(link);
    }
    document.body.appendChild(banner);
  }

  // Checks known consent-management platforms for analytics/statistics/
  // performance consent — the category tracking tools like this fall under.
  // Returns true/false once a definite signal is found, or true if no CMP is
  // detected at all (nothing to gate on, so behavior is unchanged).
  function hasTrackingConsent() {
    // 1. Manual override always wins, if a site owner has set one explicitly —
    // e.g. for a custom banner not covered by the auto-detection below.
    if (typeof window.pivitConsent === 'boolean') return window.pivitConsent;

    // 2. Cookiebot — window.Cookiebot.consent.{necessary,preferences,statistics,marketing}
    if (window.Cookiebot && window.Cookiebot.consent) {
      return !!window.Cookiebot.consent.statistics;
    }

    // 3. OneTrust — window.OnetrustActiveGroups is a string like ",C0001,C0002,"
    // listing active category IDs. C0002 ("Performance Cookies") is OneTrust's
    // standard default template ID for analytics-type cookies; accounts on a
    // custom template may use different IDs, in which case this won't catch it
    // — use the manual override (1) instead for those.
    if (typeof window.OnetrustActiveGroups === 'string') {
      return window.OnetrustActiveGroups.indexOf('C0002') !== -1;
    }

    // 4. CookieYes — stores a `cookieyes-consent` cookie with comma-separated
    // key:value pairs, e.g. "...,analytics:yes,..." once a choice is made.
    const ckyCookie = document.cookie.split('; ').find((row) => row.indexOf('cookieyes-consent=') === 0);
    if (ckyCookie) {
      return ckyCookie.indexOf('analytics:yes') !== -1;
    }

    // No known CMP detected at all — nothing to gate on, so run as normal.
    return true;
  }

  function getVisitorId() {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  }

  // Weight as a number. A string "50" must not be concatenated onto the running
  // total, which used to push almost every visitor into the last variant.
  function variantWeight(variant) {
    const n = Number(variant && variant.traffic_split);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  // FNV-1a, then a finaliser, so ids that differ by one character (including
  // v_pt…-1 and v_pt…-2, and experiment ids that share a prefix) do not land
  // in neighbouring buckets.
  function mixHash(text) {
    let h = 2166136261;
    const str = String(text);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Bucket one visitor. The seed is the experiment id plus the visitor id.
  // The roll uses the full hash, not hash % weight, so a weight that does not
  // divide 2^32 does not favour the low buckets. Returns null when the weights
  // cannot place the visitor. It does not fall back to the first or last variant.
  function assignVariant(experiment, visitorId) {
    if (!experiment || visitorId == null || visitorId === '') return null;
    const variants = experiment.variants || [];
    const usable = [];
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      const weight = variantWeight(variant);
      if (!variant || !variant.id || !(weight > 0)) continue;
      usable.push({ variant: variant, weight: weight });
    }
    if (!usable.length) return null;
    const total = usable.reduce((sum, item) => sum + item.weight, 0);
    if (!(total > 0)) return null;
    const hash = mixHash(String(experiment.id) + '\0' + String(visitorId));
    let roll = Math.floor((hash * total) / 4294967296);
    if (roll < 0) roll = 0;
    if (roll >= total) roll = total - 1;
    let cumulative = 0;
    for (let i = 0; i < usable.length; i++) {
      cumulative += usable[i].weight;
      if (roll < cumulative) return usable[i].variant;
    }
    return null;
  }

  // Sticky via localStorage. A visitor we cannot store is not reported, so the
  // server never keeps a variant the browser did not keep.
  function pickVariant(experiment, visitorId) {
    let stored = null;
    try { stored = localStorage.getItem(ASSIGNMENT_PREFIX + experiment.id); } catch (e) { stored = null; }
    if (stored) {
      const match = (experiment.variants || []).find((v) => v.id === stored);
      if (match) return match;
    }

    const chosen = assignVariant(experiment, visitorId);
    if (!chosen || !chosen.id) return null;
    try {
      localStorage.setItem(ASSIGNMENT_PREFIX + experiment.id, chosen.id);
    } catch (e) {
      return null;
    }
    return chosen;
  }

  // One applier for the page so every variant shares a single observer.
  // Style and hide on a non-positional selector become a <style> rule (current
  // and later matches, no per-element write). Text, HTML, attributes and the
  // structural types are applied to matches now and to elements added later.
  let pageApplier = null;
  function applyVariantChanges(variant) {
    if (!variant) return null;
    if (!pageApplier) pageApplier = api.createApplier(document);
    return pageApplier.applyAll(variant.changes || [], variant.id || 'variant');
  }

  function sendEvent(experimentId, variantId, visitorId, eventType, goalId, changeApplied) {
    // is_test is a JSON field. sendBeacon cannot set X-Pivit-Test, and the
    // field is omitted for real visitors so their body stays the same.
    // change_applied is only set for a view that had element changes to check.
    const fields = {
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: visitorId,
      event_type: eventType,
      goal_id: goalId || null,
    };
    if (eventType === 'view' && (changeApplied === true || changeApplied === false)) {
      fields.change_applied = changeApplied;
    }
    if (SITE_KEY) fields.site = SITE_KEY;
    const body = JSON.stringify(api.eventBody(fields, qaOn));
    // sendBeacon is fire-and-forget and survives page navigation, ideal for tracking calls.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API_BASE + '/api/event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch(API_BASE + '/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    }
  }

  // Experiment goals apply to every variant. An empty list means this test
  // still keeps a different list on each variant — use that variant's goals.
  function goalsFor(experiment, variant) {
    if (experiment && experiment.goals && experiment.goals.length) return experiment.goals;
    return (variant && variant.goals) || [];
  }

  function wireConversionTracking(experimentId, variantId, visitorId, goals) {
    (goals || []).forEach((goal) => {
      const type = goal.type || 'click'; // goals saved before this feature have no "type" — always click
      if (type !== 'click' || !goal.selector) return; // 'url' goals are handled by checkUrlGoals below
      let nodes;
      try { nodes = document.querySelectorAll(goal.selector); } catch (e) { return; }
      const goalId = goal.id || goal.selector;
      nodes.forEach((el) => {
        el.addEventListener('click', () => {
          // One beacon per visitor per goal. Later clicks are not sent, so
          // they cannot burn the per-IP event cap. The server still counts
          // unique conversions from whatever did arrive.
          if (!claimClick(localStorage, visitorId, experimentId, goalId)) return;
          sendEvent(experimentId, variantId, visitorId, 'convert', goalId);
        });
      });
    });
  }

  // A URL goal must not convert on the page view that first enrolled the
  // visitor. Landing on the goal page and being bucketed in the same load
  // would otherwise count as an instant conversion. A later page view still
  // counts. Click goals on the enrolment page are unchanged.
  function shouldCountUrlGoal(experimentId, enrolledThisView) {
    if (!experimentId) return false;
    if (!enrolledThisView) return true;
    if (typeof enrolledThisView.has === 'function' && enrolledThisView.has(experimentId)) return false;
    if (enrolledThisView[experimentId]) return false;
    return true;
  }

  // "Visited a URL" goals can't be wired up as a click listener on the page the
  // experiment runs on, because the goal page (e.g. /thank-you) is often a
  // completely different page. Instead, on every page load, check every experiment
  // this visitor has ever been assigned to (found via localStorage) against the
  // current URL, and fire a conversion once per goal if it matches.
  async function checkUrlGoals(visitorId, enrolledThisView) {
    const assignments = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(ASSIGNMENT_PREFIX) === 0) {
        assignments[key.slice(ASSIGNMENT_PREFIX.length)] = localStorage.getItem(key);
      }
    }
    const experimentIds = Object.keys(assignments);
    if (experimentIds.length === 0) return;

    try {
      const res = await fetch(api.withQaQuery(api.withSite(`${API_BASE}/api/experiments/by-ids?ids=${experimentIds.join(',')}`, SITE_KEY), qaOn));
      const data = await res.json();

      (data.experiments || []).forEach((experiment) => {
        if (!shouldCountUrlGoal(experiment.id, enrolledThisView)) return;
        const variantId = assignments[experiment.id];
        const variant = (experiment.variants || []).find((v) => v.id === variantId);
        if (!variant) return;

        goalsFor(experiment, variant).forEach((goal) => {
          if (goal.type !== 'url' || !goal.url_match) return;
          if (!matchUrlGoal(goal.url_match, window.location.href, goal.match || 'contains')) return;

          const firedKey = '_ab_converted_' + experiment.id + '_' + (goal.id || goal.url_match);
          if (localStorage.getItem(firedKey)) return; // only count once per visitor per goal
          localStorage.setItem(firedKey, '1');
          sendEvent(experiment.id, variantId, visitorId, 'convert', goal.id || goal.url_match);
        });
      });
    } catch (err) {
      console.warn('[ab] failed to check URL goals:', err);
    }
  }

  function elementSelectorOf(experiment) {
    const raw = experiment && experiment.element_selector;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  // none: no selector, so the URL rule is enough.
  // present: the element is already in the document.
  // missing: not yet, and a wait may still find it.
  // invalid: querySelector threw, so the test must not run.
  function elementQuery(doc, selector) {
    const sel = typeof selector === 'string' ? selector.trim() : '';
    if (!sel) return { state: 'none', selector: '' };
    try {
      const node = doc && doc.querySelector ? doc.querySelector(sel) : null;
      return { state: node ? 'present' : 'missing', selector: sel };
    } catch (err) {
      return { state: 'invalid', selector: sel };
    }
  }

  function elementIsPresent(doc, selector) {
    const query = elementQuery(doc, selector);
    return query.state === 'none' || query.state === 'present';
  }

  // Resolves when the element is there, or when the wait gives up.
  // An empty selector resolves immediately as found. An invalid selector
  // resolves immediately as not found, with no observer and no timer.
  function waitForElement(doc, selector, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs == null ? ELEMENT_WAIT_MS : opts.timeoutMs;
    const Observer = opts.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
    const sel = typeof selector === 'string' ? selector.trim() : '';

    return new Promise(function (resolve) {
      const first = elementQuery(doc, sel);
      if (first.state === 'none') {
        resolve({ found: true, reason: 'none' });
        return;
      }
      if (first.state === 'present') {
        resolve({ found: true, reason: 'present' });
        return;
      }
      if (first.state === 'invalid') {
        resolve({ found: false, reason: 'invalid' });
        return;
      }

      let settled = false;
      let observer = null;
      let timer = null;
      function finish(found, reason) {
        if (settled) return;
        settled = true;
        if (observer) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
        }
        if (timer != null) clearTimer(timer);
        resolve({ found: found, reason: reason });
      }
      function look(reason) {
        const query = elementQuery(doc, sel);
        if (query.state === 'present') finish(true, reason);
        else if (query.state === 'invalid') finish(false, 'invalid');
      }

      if (Observer && doc) {
        try {
          observer = new Observer(function () { look('appeared'); });
          const target = doc.documentElement || doc.body || doc;
          if (target) observer.observe(target, { childList: true, subtree: true });
        } catch (err) {
          observer = null;
        }
      }
      timer = setTimer(function () {
        look('appeared');
        if (!settled) finish(false, 'timeout');
      }, timeoutMs);
    });
  }

  // onExpose is the bucket: assignment, DOM changes, and the view. It is
  // not called when the element never appears.
  function exposeWhenReady(experiment, deps) {
    const d = deps || {};
    const selector = elementSelectorOf(experiment);
    return waitForElement(d.document, selector, d).then(function (gate) {
      if (!gate.found) return { exposed: false, reason: gate.reason, selector: selector };
      if (typeof d.onExpose === 'function') d.onExpose(experiment);
      return { exposed: true, reason: gate.reason, selector: selector };
    });
  }

  // A demo test never buckets a real visitor. Test traffic is pivit_qa or a
  // visitor id that starts with v_pt. Live tests are unchanged.
  function mayBucketExperiment(experiment, visitorId, qaOn) {
    if (!experiment || experiment.test_type !== 'demo') return true;
    if (qaOn) return true;
    return typeof visitorId === 'string' && visitorId.indexOf('v_pt') === 0;
  }

  function previewInfo(experiment, variant, gate) {
    const variantName = variant && variant.name ? variant.name : '';
    const experimentName = experiment && experiment.name ? experiment.name : '';
    const selector = elementSelectorOf(experiment);
    const found = !gate || gate.found !== false;
    if (selector && !found) {
      return '[ab] preview mode — not showing variant "' + variantName + '" for experiment "' + experimentName
        + '". This page has no element matching "' + selector + '", so nothing is applied. No events are being logged.';
    }
    if (selector) {
      return '[ab] preview mode — showing variant "' + variantName + '" for experiment "' + experimentName
        + '". It runs only when "' + selector + '" is on the page. No events are being logged.';
    }
    return '[ab] preview mode — showing variant "' + variantName + '" for experiment "' + experimentName
      + '". No events are being logged.';
  }

  function previewVariant(experiments, preview) {
    if (!preview || !preview.variant_id) return null;
    const list = experiments || [];
    let experiment = preview.experiment_id
      ? list.find((item) => item.id === preview.experiment_id)
      : null;
    if (!experiment) {
      const owners = list.filter((item) => (item.variants || []).some((variant) => variant.id === preview.variant_id));
      experiment = owners.length === 1 ? owners[0] : null;
    }
    if (!experiment) return null;
    const variant = (experiment.variants || []).find((item) => item.id === preview.variant_id);
    return variant ? { experiment, variant } : null;
  }

  function rememberPublicGa4(data) {
    const ga4 = data && data.ga4;
    const id = ga4 && normaliseGa4MeasurementId(ga4.measurement_id);
    ga4Config = id ? { measurement_id: id } : null;
    if (data && Array.isArray(data.experiments)) ga4Experiments = data.experiments;
  }

  function visitorLooksLikeTest() {
    let visitorId = '';
    try { visitorId = localStorage.getItem(VISITOR_KEY) || ''; } catch (err) { visitorId = ''; }
    return qaOn || visitorId.indexOf(api.TEST_VISITOR_PREFIX) === 0;
  }

  function assignmentsFor(experiments) {
    const assignments = Object.create(null);
    const list = experiments || [];
    for (let i = 0; i < list.length; i++) {
      const experiment = list[i];
      if (!experiment || experiment.id == null) continue;
      let stored = null;
      try { stored = localStorage.getItem(ASSIGNMENT_PREFIX + experiment.id); } catch (err) { stored = null; }
      if (stored) assignments[experiment.id] = stored;
    }
    return assignments;
  }

  // Ready experiments are sent now. An element rule that is not on the page
  // yet waits, then sends once, without applying the variant again.
  function reportExperienceImpressions(experiments, href) {
    if (ga4Reporting) return;
    ga4Reporting = true;
    const waiting = [];
    try {
      const list = experiments || ga4Experiments || [];
      const ready = [];
      for (let i = 0; i < list.length; i++) {
        const experiment = list[i];
        const selector = api.elementSelectorOf(experiment);
        const query = api.elementQuery(document, selector);
        if (query.state === 'invalid') continue;
        if (query.state === 'missing') waiting.push(experiment);
        else ready.push(experiment);
      }
      const pageHref = href || (window.location && window.location.href) || '';
      const planned = planExperienceImpressions({
        experiments: ready,
        assignments: assignmentsFor(ready),
        pageKey: pageViewKey(pageHref),
        sent: ga4Sent,
        ga4: ga4Config,
        consentAllows: analyticsConsentAllows(window),
        transport: ga4Transport(window),
        preview: false,
        testTraffic: visitorLooksLikeTest(),
      });
      sendPlannedImpressions(window, planned, ga4Sent, ga4Gate);
    } finally {
      ga4Reporting = false;
    }
    const pageKey = pageViewKey(href || (window.location && window.location.href) || '');
    waiting.forEach(function (experiment) {
      api.waitForElement(document, api.elementSelectorOf(experiment)).then(function (gate) {
        if (!gate || !gate.found) return;
        if (pageViewKey(window.location && window.location.href) !== pageKey) return;
        reportExperienceImpressions([experiment], href);
      }).catch(function () { /* the impression is skipped if the wait fails */ });
    });
  }

  function reportGa4FromConsent() {
    reportExperienceImpressions(ga4Experiments, window.location.href);
  }

  async function init() {
    const mode = pageMode();

    // Edit mode: ?ab_edit=<variant_id>&token=<token> hands off entirely to a
    // separate editor script, loaded only now (not for every real visitor) —
    // keeps this production snippet lean. No tracking/preview logic runs below
    // this point for an edit-mode page load, so an editing session never sends
    // a stray view event into real results. A later ab_preview in the same URL
    // is preview mode instead — the newest link wins.
    if (mode.type === 'edit' && mode.variantId) {
      let blocked = null;
      if (mode.token) {
        try {
          const res = await fetch(
            `${API_BASE}/api/editor/variants/${encodeURIComponent(mode.variantId)}?token=${encodeURIComponent(mode.token)}`,
            { cache: 'no-store' }
          );
          const data = await res.json().catch(() => ({}));
          if (data && data.code === 'archived') blocked = data;
        } catch (err) {
          blocked = null;
        }
      }
      const previous = document.querySelectorAll('script[data-pivit-editor]');
      for (let i = 0; i < previous.length; i++) previous[i].remove();
      if (blocked) {
        showExpiredNotice(blocked);
        revealPage();
        return;
      }
      const editorScript = document.createElement('script');
      editorScript.src = `${API_BASE}/snippet/editor.js?v=${EDITOR_VERSION}`;
      editorScript.async = false;
      editorScript.setAttribute('data-pivit-editor', '1');
      editorScript.setAttribute('data-api', API_BASE);
      editorScript.setAttribute('data-variant-id', mode.variantId);
      document.head.appendChild(editorScript);
      revealPage();
      return;
    }

    // Preview needs both the variant id and a signed token. The token is what
    // lets a draft or paused experiment through; the id alone does not.
    const wantsPreview = mode.type === 'preview' && !!(mode.variantId && mode.token);

    // Device frames are a preview of the saved variant. The top document does
    // not apply changes: the frame loads this URL without pivit_device, and
    // that load runs CSS, HTML and JavaScript exactly as a visitor would,
    // including page_css, page_js and banner.
    const devicePreview = wantsPreview
      ? previewDevice(lastQuery(new URLSearchParams(window.location.search), 'pivit_device'))
      : '';
    if (devicePreview) {
      mountDevicePreview(devicePreview);
      revealPage();
      return;
    }

    if (!wantsPreview && !hasTrackingConsent()) {
      // No consent yet (and this isn't a preview) — don't write to localStorage,
      // don't fetch experiments, don't apply changes, don't send anything. The
      // visitor just sees the page exactly as if this snippet weren't there.
      revealPage();
      return;
    }

    if (!wantsPreview) {
      qaOn = api.applyQaFlag(localStorage, document.cookie, window.location.search, function (value) {
        document.cookie = value;
      });
    }

    // A v_pt visitor is test traffic even before ?pivit_qa=1 is on the URL.
    // The experiments request has to say so, or a demo test is left out of
    // the list and that visitor is never bucketed.
    let storedVisitor = '';
    try { storedVisitor = localStorage.getItem(VISITOR_KEY) || ''; } catch (e) { storedVisitor = ''; }
    const fetchAsTest = !wantsPreview && (qaOn || storedVisitor.indexOf(api.TEST_VISITOR_PREFIX) === 0);

    const url = encodeURIComponent(window.location.href);
    const previewQuery = wantsPreview
      ? `&preview=1&preview_variant=${encodeURIComponent(mode.variantId)}&preview_token=${encodeURIComponent(mode.token)}`
      : '';

    try {
      const res = await fetch(
        api.withQaQuery(api.withSite(`${API_BASE}/api/experiments?url=${url}${previewQuery}`, SITE_KEY), fetchAsTest),
        wantsPreview ? { cache: 'no-store' } : undefined
      );
      const data = await res.json();

      // Authorised preview: show only that experiment's variant. Do not assign
      // a visitor, do not write localStorage, and do not log any event. A
      // preview URL whose token was rejected shows the page unchanged — never
      // another experiment that happens to match the same host.
      if (wantsPreview) {
        if (data && data.preview_expired && data.preview_expired.code === 'archived') {
          showExpiredNotice(data.preview_expired);
          revealPage();
          return;
        }
        const match = data.preview && data.preview.variant_id === mode.variantId
          ? previewVariant(data.experiments, data.preview)
          : null;
        if (match) {
          const selector = api.elementSelectorOf(match.experiment);
          const query = api.elementQuery(document, selector);
          if (query.state === 'present' || query.state === 'none') {
            applyVariantChanges(match.variant);
            console.info(api.previewInfo(match.experiment, match.variant, { found: true, reason: query.state }));
          } else if (query.state === 'invalid') {
            console.info(api.previewInfo(match.experiment, match.variant, { found: false, reason: 'invalid' }));
          } else {
            // Reveal now. A page without the element must not stay blank
            // for the whole wait. Apply later only if the element appears.
            revealPage();
            console.info('[ab] preview mode — waiting for "' + selector + '" before showing experiment "' + match.experiment.name + '". No events are being logged.');
            const gate = await api.waitForElement(document, selector);
            if (gate.found) applyVariantChanges(match.variant);
            console.info(api.previewInfo(match.experiment, match.variant, gate));
            return;
          }
        }
        revealPage();
        return;
      }

      if (!hasTrackingConsent()) {
        revealPage();
        return;
      }

      rememberPublicGa4(data);

      const visitorId = getVisitorId();
      const enrolledThisView = Object.create(null);
      const waiting = [];

      // Assignment and the view happen here, and only here. A waiting
      // experiment does not call this until its element is on the page.
      function enroll(experiment) {
        if (!api.mayBucketExperiment(experiment, visitorId, qaOn)) return;
        if (!experiment.variants || experiment.variants.length === 0) return;
        let already = null;
        try { already = localStorage.getItem(ASSIGNMENT_PREFIX + experiment.id); } catch (e) { already = null; }
        const variant = pickVariant(experiment, visitorId);
        if (!variant) return;
        if (!already) enrolledThisView[experiment.id] = 1;
        const outcome = applyVariantChanges(variant);
        const changeApplied = outcome && (outcome.ok === true || outcome.ok === false) ? outcome.ok : undefined;
        sendEvent(experiment.id, variant.id, visitorId, 'view', null, changeApplied);
        wireConversionTracking(experiment.id, variant.id, visitorId, goalsFor(experiment, variant));
        reportExperienceImpressions([experiment], window.location.href);
      }

      (data.experiments || []).forEach((experiment) => {
        if (!experiment.variants || experiment.variants.length === 0) return;
        const selector = api.elementSelectorOf(experiment);
        const query = api.elementQuery(document, selector);
        if (query.state === 'invalid') return;
        if (query.state === 'none' || query.state === 'present') enroll(experiment);
        else waiting.push(experiment);
      });

      waiting.forEach((experiment) => {
        api.exposeWhenReady(experiment, {
          document: document,
          onExpose: function () {
            if (!hasTrackingConsent()) return;
            enroll(experiment);
          },
        }).catch((err) => {
          console.warn('[ab] element wait failed:', err);
        });
      });

      watchAnalyticsConsent(window, reportGa4FromConsent);
      bindSpaRouteChanges(window, function () {
        const href = window.location.href;
        const ticket = ++ga4Nav;
        const page = encodeURIComponent(href);
        fetch(api.withQaQuery(api.withSite(`${API_BASE}/api/experiments?url=${page}`, SITE_KEY), fetchAsTest))
          .then(function (res) { return res.json(); })
          .then(function (next) {
            if (ticket !== ga4Nav) return;
            if (!hasTrackingConsent()) return;
            rememberPublicGa4(next);
            watchAnalyticsConsent(window, reportGa4FromConsent);
            reportExperienceImpressions((next && next.experiments) || [], href);
          })
          .catch(function () { /* a later address change can still report */ });
      });

      // Reveal now. Experiments whose element is already there are applied.
      // A missing element does not hold the page blank: a site-wide URL rule
      // would otherwise hide every page that will never have the button.
      // The observer still applies the variant if the element appears in time.
      revealPage();

      // Check "visited a URL" goals on every page load — including pages with no
      // on-page experiment at all, e.g. a /thank-you confirmation page.
      await checkUrlGoals(visitorId, enrolledThisView);
    } catch (err) {
      console.warn('[ab] failed to load experiments:', err);
      revealPage(); // never leave the page hidden just because the API call failed
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // One click beacon per visitor + experiment + goal. localStorage is the
  // record; if it throws, clickSeen still blocks a repeat on this page.
  function clickStorageKey(visitorId, experimentId, goalId) {
    return '_ab_click_' + visitorId + '_' + experimentId + '_' + goalId;
  }
  function claimClick(storage, visitorId, experimentId, goalId, memory) {
    const mem = memory || clickSeen;
    const key = clickStorageKey(visitorId, experimentId, goalId);
    if (mem[key]) return false;
    try {
      if (storage && storage.getItem && storage.getItem(key)) {
        mem[key] = 1;
        return false;
      }
    } catch (e) { /* private mode or a blocked store — fall through to memory */ }
    mem[key] = 1;
    try {
      if (storage && storage.setItem) storage.setItem(key, '1');
    } catch (e) { /* the memory flag above is the fallback */ }
    return true;
  }

  // Keep in step with public/url-match.js. scripts/goals.test.js checks they agree.
  function stripEdge(value) {
    let s = String(value || '').trim();
    let strippedQuery = false;
    if (s.endsWith('?')) { s = s.slice(0, -1); strippedQuery = true; }
    if (s.length > 1 && s.endsWith('/') && !s.endsWith('://')) s = s.slice(0, -1);
    return { value: s, strippedQuery: strippedQuery };
  }
  function urlCandidates(href) {
    const raw = String(href || '').trim();
    const out = [];
    function add(value) { if (value && out.indexOf(value) === -1) out.push(value); }
    add(raw);
    try {
      const u = new URL(raw, 'https://placeholder.invalid');
      if (/^https?:\/\//i.test(raw) || raw.charAt(0) === '/') {
        add(u.pathname + u.search + u.hash);
        add(u.origin + u.pathname + u.search + u.hash);
        if (!u.search) { add(u.pathname); add(u.origin + u.pathname); }
      }
    } catch (e) {}
    return out;
  }
  function pathOnly(value) {
    const q = value.indexOf('?');
    const h = value.indexOf('#');
    let end = value.length;
    if (q !== -1) end = Math.min(end, q);
    if (h !== -1 && (q === -1 || h < q)) end = h;
    return value.slice(0, end);
  }
  function sameEdge(left, right) {
    if (right.value === left.value) return true;
    if (!left.strippedQuery) return false;
    return stripEdge(pathOnly(right.value)).value === left.value;
  }
  function startsEdge(left, right) {
    if (!left.value) return false;
    if (right.value.indexOf(left.value) === 0) return true;
    if (!left.strippedQuery) return false;
    return stripEdge(pathOnly(right.value)).value.indexOf(left.value) === 0;
  }
  function readQuantifier(source, i) {
    const c = source.charAt(i);
    if (c !== '+' && c !== '*' && c !== '?' && c !== '{') return { quantified: false, repeating: false, next: i };
    if (c !== '{') {
      let next = i + 1;
      if (source.charAt(next) === '?' || source.charAt(next) === '+') next += 1;
      return { quantified: true, repeating: c === '+' || c === '*', next: next };
    }
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (!m) return { quantified: false, repeating: false, next: i };
    let next = i + m[0].length;
    if (source.charAt(next) === '?' || source.charAt(next) === '+') next += 1;
    const min = Number(m[1]);
    const max = m[2] == null ? min : (m[3] === '' ? Infinity : Number(m[3]));
    return { quantified: true, repeating: max > 1, next: next };
  }
  function starHeight(source) {
    let i = 0;
    const n = source.length;
    const frames = [{ alt: 0, max: 0, last: 0, altUsed: false }];
    function frame() { return frames[frames.length - 1]; }
    while (i < n) {
      const c = source.charAt(i);
      if (c === '\\') {
        if (i + 1 >= n) return -1;
        frame().last = 0;
        i += 2;
        continue;
      }
      if (c === '[') {
        i += 1;
        if (source.charAt(i) === '^') i += 1;
        if (source.charAt(i) === ']') i += 1;
        let closed = false;
        while (i < n) {
          if (source.charAt(i) === '\\') { i += 2; continue; }
          if (source.charAt(i) === ']') { closed = true; i += 1; break; }
          i += 1;
        }
        if (!closed) return -1;
        frame().last = 0;
        continue;
      }
      if (c === '(') {
        frames.push({ alt: 0, max: 0, last: 0, altUsed: false });
        i += 1;
        if (source.charAt(i) === '?') {
          i += 1;
          if (source.charAt(i) === '<') i += 1;
          while (i < n && source.charAt(i) !== ':' && source.charAt(i) !== ')') i += 1;
          if (source.charAt(i) === ':') i += 1;
        }
        continue;
      }
      if (c === ')') {
        if (frames.length < 2) return -1;
        const done = frames.pop();
        const h = Math.max(done.max, done.alt, done.last);
        i += 1;
        const q = readQuantifier(source, i);
        const f = frame();
        const repeating = q.quantified && q.repeating;
        if (done.altUsed && repeating) return 99;
        f.last = repeating ? h + 1 : h;
        if (f.last > f.alt) f.alt = f.last;
        if (q.quantified) i = q.next;
        continue;
      }
      if (c === '|') {
        const f = frame();
        f.altUsed = true;
        if (f.alt > f.max) f.max = f.alt;
        if (f.last > f.max) f.max = f.last;
        f.alt = 0;
        f.last = 0;
        i += 1;
        continue;
      }
      if (c === '+' || c === '*' || c === '?' || c === '{') {
        const q = readQuantifier(source, i);
        if (!q.quantified) { frame().last = 0; i += 1; continue; }
        const f = frame();
        if (q.repeating) { f.last += 1; if (f.last > f.alt) f.alt = f.last; }
        i = q.next;
        continue;
      }
      frame().last = 0;
      i += 1;
    }
    if (frames.length !== 1) return -1;
    const top = frames[0];
    return Math.max(top.max, top.alt, top.last);
  }
  function isSafeRegex(pattern) {
    if (typeof pattern !== 'string') return false;
    if (pattern.length < 1 || pattern.length > 200) return false;
    if (/\\[1-9]/.test(pattern)) return false;
    try { new RegExp(pattern); } catch (e) { return false; }
    const height = starHeight(pattern);
    return height >= 0 && height <= 1;
  }
  function qaFlagFromSearch(search) {
    const query = String(search || '').replace(/^\?/, '');
    if (!query) return null;
    const values = new URLSearchParams(query).getAll('pivit_qa');
    if (!values.length) return null;
    const last = values[values.length - 1];
    if (last === '1') return '1';
    if (last === '0') return '0';
    return null;
  }

  function cookieHasQa(cookie) {
    const parts = String(cookie || '').split(';');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].trim() === 'pivit_qa=1') return true;
    }
    return false;
  }

  function readQaFlag(storage, cookie) {
    try {
      if (storage && storage.getItem('pivit_qa') === '1') return true;
    } catch (e) { /* storage blocked */ }
    return cookieHasQa(cookie);
  }

  function applyQaFlag(storage, cookie, search, writeCookie) {
    const flag = qaFlagFromSearch(search);
    if (flag === '1') {
      try { if (storage) storage.setItem('pivit_qa', '1'); } catch (e) { /* storage blocked */ }
      if (typeof writeCookie === 'function') writeCookie('pivit_qa=1; Path=/; Max-Age=31536000; SameSite=Lax');
      return true;
    }
    if (flag === '0') {
      try { if (storage) storage.removeItem('pivit_qa'); } catch (e) { /* storage blocked */ }
      if (typeof writeCookie === 'function') writeCookie('pivit_qa=; Path=/; Max-Age=0; SameSite=Lax');
      return false;
    }
    return readQaFlag(storage, cookie);
  }

  function eventBody(fields, flagged) {
    const body = {
      experiment_id: fields.experiment_id,
      variant_id: fields.variant_id,
      visitor_id: fields.visitor_id,
      event_type: fields.event_type,
      goal_id: fields.goal_id || null,
    };
    if (fields.event_type === 'view' && (fields.change_applied === true || fields.change_applied === false)) {
      body.change_applied = fields.change_applied;
    }
    const id = fields.visitor_id;
    if (flagged || (typeof id === 'string' && id.indexOf('v_pt') === 0)) body.is_test = true;
    if (fields.site && /^site_[a-f0-9]{16,80}$/i.test(fields.site)) body.site = fields.site;
    return body;
  }

  function withSite(url, siteKey) {
    const key = typeof siteKey === 'string' ? siteKey.trim() : '';
    if (!/^site_[a-f0-9]{16,80}$/i.test(key)) return url;
    return url + (String(url).indexOf('?') === -1 ? '?' : '&') + 'site=' + encodeURIComponent(key);
  }

  function withQaQuery(url, flagged) {
    if (!flagged) return url;
    return url + (String(url).indexOf('?') === -1 ? '?' : '&') + 'pivit_qa=1';
  }

  function matchUrlGoal(pattern, href, matchType) {
    const type = matchType || 'contains';
    const pat = String(pattern || '');
    const url = String(href || '');
    if (!pat) return false;
    if (type === 'contains') return url.indexOf(pat) !== -1;
    if (type === 'regex') {
      if (!isSafeRegex(pat)) return false;
      try { return new RegExp(pat).test(url.slice(0, 2000)); } catch (e) { return false; }
    }
    if (type !== 'exact' && type !== 'starts_with') return false;
    const left = stripEdge(pat);
    const candidates = urlCandidates(url);
    for (let i = 0; i < candidates.length; i++) {
      const right = stripEdge(candidates[i]);
      if (type === 'exact' && sameEdge(left, right)) return true;
      if (type === 'starts_with' && startsEdge(left, right)) return true;
    }
    return false;
  }

  // Keep this pattern in step with src/ga4.js. A measurement ID is G- plus
  // 6 to 12 letters or digits. Empty is '', anything else that is not an ID
  // is null.
  function normaliseGa4MeasurementId(value) {
    if (value == null) return '';
    const text = String(value).trim().toUpperCase();
    if (!text) return '';
    if (!/^G-[A-Z0-9]{6,12}$/.test(text)) return null;
    return text;
  }

  function ga4Text(value) {
    return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  }

  function clipGa4(value) {
    const text = ga4Text(value);
    return text.length > 100 ? text.slice(0, 100) : text;
  }

  // test name(test id):variant name(variant id). GA4 keeps 100 characters.
  // When the names do not fit, they are shortened and the ids stay.
  function expVariantString(experimentName, experimentId, variantName, variantId) {
    const expName = ga4Text(experimentName);
    const expId = ga4Text(experimentId);
    const varName = ga4Text(variantName);
    const varId = ga4Text(variantId);
    const full = expName + '(' + expId + '):' + varName + '(' + varId + ')';
    if (full.length <= 100) return full;
    const overhead = expId.length + varId.length + 5;
    const room = 100 - overhead;
    if (room < 2) {
      const compact = expId + ':' + varId;
      return compact.length <= 100 ? compact : compact.slice(0, 100);
    }
    const leftRoom = Math.ceil(room / 2);
    const rightRoom = room - leftRoom;
    return expName.slice(0, leftRoom) + '(' + expId + '):' + varName.slice(0, rightRoom) + '(' + varId + ')';
  }

  function pageViewKey(href) {
    const raw = href == null ? '' : String(href);
    try {
      const url = new URL(raw, 'https://pivitlab.invalid');
      return url.pathname + url.search + url.hash;
    } catch (err) {
      return raw;
    }
  }

  function analyticsStorageFromEntry(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const params = entry[2];
    if (entry[0] === 'consent' && params && typeof params === 'object') {
      if (params.analytics_storage === 'granted' || params.analytics_storage === 'denied') {
        return params.analytics_storage;
      }
    }
    if ((entry[0] === 'consent' || entry.event === 'gtm.init_consent')
      && (entry.analytics_storage === 'granted' || entry.analytics_storage === 'denied')) {
      return entry.analytics_storage;
    }
    return '';
  }

  // granted, denied, or unknown. Unknown means Consent Mode is not in use.
  // The resolved Google tag state wins when it is present. Otherwise the
  // latest consent command already on dataLayer wins.
  function analyticsStorageState(win) {
    const ics = win && win.google_tag_data && win.google_tag_data.ics;
    const entries = ics && ics.entries;
    const item = entries && entries.analytics_storage;
    if (item && typeof item === 'object') {
      const raw = item.update != null && item.update !== '' ? item.update : item.default;
      if (raw === 'granted' || raw === true) return 'granted';
      if (raw === 'denied' || raw === false) return 'denied';
    }
    const dataLayer = win && win.dataLayer;
    if (!Array.isArray(dataLayer)) return 'unknown';
    let state = 'unknown';
    for (let i = 0; i < dataLayer.length; i++) {
      const value = analyticsStorageFromEntry(dataLayer[i]);
      if (value) state = value;
    }
    return state;
  }

  function analyticsConsentAllows(win) {
    return analyticsStorageState(win) !== 'denied';
  }

  // gtag when the page already defined it, otherwise an existing dataLayer.
  // Never creates either one.
  function ga4Transport(win) {
    if (!win) return null;
    if (typeof win.gtag === 'function') return 'gtag';
    if (Array.isArray(win.dataLayer)) return 'dataLayer';
    return null;
  }

  function planExperienceImpressions(input) {
    const opts = input || {};
    function none(reason) { return { events: [], reason: reason }; }
    if (opts.preview === true || opts.testTraffic === true) return none('not-live');
    if (opts.consentAllows !== true) return none('consent');
    if (opts.transport !== 'gtag' && opts.transport !== 'dataLayer') return none('no-transport');
    const ga4 = opts.ga4;
    if (!ga4 || ga4.enabled === false) return none('disabled');
    const measurementId = normaliseGa4MeasurementId(ga4.measurement_id);
    if (!measurementId) return none('measurement-id');
    const pageKey = opts.pageKey == null ? '' : String(opts.pageKey);
    const sent = opts.sent || {};
    const seen = Object.create(null);
    const events = [];
    const experiments = opts.experiments || [];
    const assignments = opts.assignments || {};
    for (let i = 0; i < experiments.length; i++) {
      const experiment = experiments[i];
      if (!experiment || experiment.id == null || experiment.id === '') continue;
      const assigned = assignments[experiment.id];
      if (assigned == null || assigned === '') continue;
      const variants = experiment.variants || [];
      let variant = null;
      for (let v = 0; v < variants.length; v++) {
        if (variants[v] && variants[v].id === assigned) {
          variant = variants[v];
          break;
        }
      }
      if (!variant) continue;
      const dedupeKey = String(experiment.id) + '\n' + String(variant.id) + '\n' + pageKey;
      if (sent[dedupeKey] || seen[dedupeKey]) continue;
      seen[dedupeKey] = 1;
      events.push({
        transport: opts.transport,
        measurement_id: measurementId,
        name: 'experience_impression',
        dedupeKey: dedupeKey,
        params: {
          exp_variant_string: expVariantString(experiment.name, experiment.id, variant.name, variant.id),
          experiment_id: clipGa4(experiment.id),
          experiment_name: clipGa4(experiment.name),
          variant_id: clipGa4(variant.id),
          variant_name: clipGa4(variant.name),
          send_to: measurementId,
        },
      });
    }
    return { events: events, reason: events.length ? 'ok' : 'none' };
  }

  function deliverExperienceImpression(win, event) {
    if (!win || !event || !event.params) return false;
    if (event.transport === 'gtag' && typeof win.gtag === 'function') {
      win.gtag('event', 'experience_impression', event.params);
      return true;
    }
    if (event.transport === 'dataLayer' && Array.isArray(win.dataLayer)) {
      const payload = { event: 'experience_impression' };
      const params = event.params;
      for (const key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
      }
      win.dataLayer.push(payload);
      return true;
    }
    return false;
  }

  function markImpressionsSent(sent, events) {
    const book = sent || Object.create(null);
    const list = events || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].dedupeKey) book[list[i].dedupeKey] = 1;
    }
    return book;
  }

  // Marks each event before it is delivered, and ignores a nested call.
  // gtag itself pushes onto dataLayer, which would otherwise send the rest
  // of the list a second time.
  function sendPlannedImpressions(win, planned, sent, state) {
    const gate = state || {};
    if (gate.busy) return 0;
    gate.busy = true;
    let sentCount = 0;
    try {
      const events = (planned && planned.events) || [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (!event || !event.dedupeKey) continue;
        markImpressionsSent(sent, [event]);
        let ok = false;
        try {
          ok = deliverExperienceImpression(win, event) === true;
        } catch (err) {
          ok = false;
        }
        if (!ok && sent) delete sent[event.dedupeKey];
        if (ok) sentCount += 1;
      }
    } finally {
      gate.busy = false;
    }
    return sentCount;
  }

  function watchAnalyticsConsent(win, onAllow) {
    if (!win || typeof onAllow !== 'function' || !Array.isArray(win.dataLayer)) return false;
    const current = win.dataLayer.push;
    if (typeof current === 'function' && current.__pivitGa4Watch) return true;
    const original = typeof current === 'function' ? current : Array.prototype.push;
    function wrapped() {
      const result = original.apply(win.dataLayer, arguments);
      try {
        if (analyticsConsentAllows(win)) onAllow();
      } catch (err) { /* the page's dataLayer still received the push */ }
      return result;
    }
    wrapped.__pivitGa4Watch = true;
    try {
      win.dataLayer.push = wrapped;
    } catch (err) {
      return false;
    }
    return true;
  }

  function bindSpaRouteChanges(win, onChange) {
    if (!win || typeof onChange !== 'function' || !win.history) return false;
    if (win.__pivitSpaBound) return true;
    let last = pageViewKey(win.location && win.location.href);
    function fire() {
      let next = '';
      try { next = pageViewKey(win.location && win.location.href); }
      catch (err) { return; }
      if (next === last) return;
      last = next;
      try { onChange(next); }
      catch (err) { /* a later navigation can still report */ }
    }
    function wrap(name) {
      const original = win.history[name];
      if (typeof original !== 'function' || original.__pivitSpa) return;
      function wrapped() {
        const result = original.apply(win.history, arguments);
        fire();
        return result;
      }
      wrapped.__pivitSpa = true;
      try { win.history[name] = wrapped; }
      catch (err) { /* the browser's own history stays as it was */ }
    }
    wrap('pushState');
    wrap('replaceState');
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('popstate', fire);
      win.addEventListener('hashchange', fire);
    }
    try { win.__pivitSpaBound = true; }
    catch (err) { /* the listeners are still in place for this document */ }
    return true;
  }

  // Hoisted. Node can require this file and read the return value; the boot
  // above returns first when there is no document.
  function buildPivitRuntime() {
  const STATE_EXACT = {
    active: 1, hover: 1, focus: 1, focused: 1, selected: 1, open: 1, opened: 1,
    closed: 1, disabled: 1, hidden: 1, visible: 1, current: 1, show: 1, shown: 1,
    hide: 1, loading: 1, loaded: 1, error: 1, success: 1, animating: 1, animated: 1,
    entering: 1, leaving: 1, entered: 1, exited: 1, collapsed: 1, expanded: 1,
    checked: 1, pressed: 1,
  };
  const WATCH_TYPES = {
    text: 1, html: 1, show: 1, attr: 1, js: 1, remove: 1, duplicate: 1,
    insert_before: 1, insert_after: 1, replace: 1,
  };
  const MARK = 'data-pivit-applied';

  function cssEscape(str) {
    const s = String(str);
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function isStateClass(cls) {
    const c = String(cls).toLowerCase();
    if (STATE_EXACT[c]) return true;
    if (/^(is|has|js|u|state)-/.test(c)) return true;
    if (/--(?:active|open|opened|selected|hover|focus|focused|disabled|loading|visible|hidden|current|animated|animating|entered|leaving)$/.test(c)) return true;
    if (/-(?:active|open|opened|selected|hover|focus|focused|disabled|loading|visible|hidden|current|animated|animating)$/.test(c)) return true;
    return false;
  }

  // Obviously generated: emotion, styled-components, CSS-module hashes,
  // long hex, Shopify section ids. A stable class alongside one of these
  // wins; a hash is only used when the element has nothing more stable.
  function isGeneratedClass(cls) {
    const c = String(cls);
    if (/^css-[A-Za-z0-9_-]+$/.test(c)) return true;
    if (/^sc-[A-Za-z0-9]+$/.test(c)) return true;
    if (/shopify-section-|template--\d+/i.test(c)) return true;
    if (/[a-f0-9]{8,}/i.test(c)) return true;
    const tail = c.split('__').pop();
    if (c.indexOf('__') !== -1 && tail !== c && tail.length >= 5 && /[0-9]/.test(tail) && /[A-Za-z]/.test(tail) && /^[A-Za-z0-9]+$/.test(tail)) return true;
    const under = c.lastIndexOf('_');
    if (under > 0) {
      const suf = c.slice(under + 1);
      if (suf.length >= 6 && /[0-9]/.test(suf) && /[A-Z]/.test(suf) && /[a-z]/.test(suf) && /^[A-Za-z0-9]+$/.test(suf)) return true;
    }
    return false;
  }

  function isUnstableClass(cls) {
    return isStateClass(cls) || isGeneratedClass(cls);
  }

  function isPositionalSelector(selector) {
    return /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/.test(selector || '');
  }

  function classTokens(el) {
    if (!el) return [];
    let raw = '';
    if (typeof el.className === 'string') raw = el.className;
    else if (el.className && typeof el.className.baseVal === 'string') raw = el.className.baseVal;
    else if (el.getAttribute) raw = el.getAttribute('class') || '';
    return raw.trim().split(/\s+/).filter(Boolean);
  }

  function uniqueSelector(el, doc) {
    const body = (doc && doc.body) || (typeof document !== 'undefined' ? document.body : null);
    if (!el || !el.tagName) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== body) {
      let part = String(node.tagName).toLowerCase();
      if (typeof node.className === 'string' && node.className.trim()) {
        const classes = node.className.trim().split(/\s+/).slice(0, 2).map(cssEscape);
        if (classes.length) part += '.' + classes.join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(' > ');
  }

  function poolFor(tokens) {
    const stable = tokens.filter((c) => !isStateClass(c) && !isGeneratedClass(c));
    if (stable.length) return stable;
    return tokens.filter((c) => !isStateClass(c));
  }

  function sharedClasses(tag, pool, queryAll, descendantTag) {
    if (!queryAll) return pool.slice();
    const shared = [];
    pool.forEach((cls) => {
      const sel = descendantTag
        ? tag + '.' + cssEscape(cls) + ' ' + descendantTag
        : tag + '.' + cssEscape(cls);
      let n = 0;
      try { n = queryAll(sel).length; } catch (e) { n = 0; }
      if (n > 1) shared.push(cls);
    });
    return shared.length ? shared : pool.slice();
  }

  function nearestClassedAncestor(el) {
    let node = el.parentElement;
    while (node && node.nodeType === 1) {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      if (poolFor(classTokens(node)).length) return node;
      node = node.parentElement;
    }
    return null;
  }

  // tag + the stable classes this element shares with others. State and
  // hashed classes are dropped when a real class remains. Classes that
  // match only this element are dropped when another class matches more
  // than one, so a unique hash doesn't pin the selector to one badge.
  function generaliseSelector(el, queryAll) {
    if (!el || !el.tagName) return '';
    const tag = String(el.tagName).toLowerCase();
    const pool = poolFor(classTokens(el));
    if (pool.length) {
      const use = sharedClasses(tag, pool, queryAll, null);
      return tag + '.' + use.map(cssEscape).join('.');
    }
    const ancestor = nearestClassedAncestor(el);
    if (ancestor) {
      const ptag = String(ancestor.tagName).toLowerCase();
      const ppool = poolFor(classTokens(ancestor));
      if (ppool.length) {
        const use = sharedClasses(ptag, ppool, queryAll, tag);
        return ptag + '.' + use.map(cssEscape).join('.') + ' ' + tag;
      }
    }
    return tag;
  }

  function kebab(prop) {
    return String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  }

  function selectorSafeForCss(selector) {
    return !!selector && !/[{}<>]/.test(selector);
  }

  function cssForChange(change) {
    if (!change || !change.selector) return '';
    if (isPositionalSelector(change.selector)) return '';
    if (!selectorSafeForCss(change.selector)) return '';
    if (change.type === 'hide') return change.selector + '{display:none !important}';
    if (change.type !== 'style' || !change.value || typeof change.value !== 'object') return '';
    const decls = [];
    Object.keys(change.value).forEach((key) => {
      const value = change.value[key];
      if (value == null || value === '') return;
      decls.push(kebab(key) + ':' + String(value).replace(/</g, '\\3C ') + ' !important');
    });
    if (!decls.length) return '';
    return change.selector + '{' + decls.join(';') + '}';
  }

  function shouldWatch(change) {
    if (!change || !change.selector || !WATCH_TYPES[change.type]) return false;
    if (isPositionalSelector(change.selector)) return false;
    return true;
  }

  function cssDomId(key) {
    return 'pivit-css-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  // One bar per document. The id is stable, so a second apply, a new applier
  // after an SPA route change, and the mutation observer all update this node
  // instead of adding another. Padding on the root matches the bar's height.
  const BANNER_ID = 'pivit-banner';
  const BANNER_STYLE_ID = 'pivit-banner-css';
  const BANNER_Z = '2147483000';
  const BANNER_FALLBACK_HEIGHT = 48;

  function londonParts(date) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    fmt.formatToParts(date).forEach((part) => {
      if (Object.prototype.hasOwnProperty.call(out, part.type)) out[part.type] = Number(part.value);
    });
    // A few engines report midnight as 24:00:00.
    if (out.hour === 24) out.hour = 0;
    return out;
  }

  function londonOffsetMs(date) {
    const parts = londonParts(date);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - date.getTime();
  }

  // UTC milliseconds of 00:00:00 on that Europe/London calendar date.
  // The offset is read twice so a guess that lands on the other side of a
  // clock change still resolves to the real midnight.
  function londonMidnightUtc(year, month, day) {
    const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
    const offset = londonOffsetMs(new Date(utcGuess));
    let utc = utcGuess - offset;
    const offsetAt = londonOffsetMs(new Date(utc));
    if (offsetAt !== offset) utc = utcGuess - offsetAt;
    return utc;
  }

  // The next Europe/London midnight after `now`. At exactly 00:00 the next
  // one is tomorrow, so a daily countdown rolls forward instead of sitting
  // at zero. Spring is 23 hours and autumn is 25 because the offset changes.
  function nextLondonMidnight(now) {
    const date = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(date.getTime())) return NaN;
    const parts = londonParts(date);
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 86400000);
    return londonMidnightUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate());
  }

  function formatRemaining(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0h 00m 00s';
    const total = Math.floor(ms / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const clock = hours + 'h ' + pad(minutes) + 'm ' + pad(seconds) + 's';
    return days > 0 ? days + 'd ' + clock : clock;
  }

  function bannerColour(value, fallback) {
    const raw = String(value == null ? '' : value).trim();
    const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
    if (!match) return fallback;
    const hex = match[1];
    if (hex.length === 3) return '#' + hex.split('').map((ch) => ch + ch).join('');
    return '#' + hex;
  }

  // http(s), a site path, a query, or a hash. javascript: and protocol-relative
  // URLs are dropped so the bar cannot become a script.
  function bannerHref(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || raw.length > 2000) return '';
    if (raw.charAt(0) === '/' && raw.charAt(1) !== '/' && raw.charAt(1) !== '\\') return raw;
    if (raw.charAt(0) === '#' || raw.charAt(0) === '?') return raw;
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (err) { /* not a URL */ }
    return '';
  }

  function bannerPosition(change) {
    return change && change.position === 'bottom' ? 'bottom' : 'top';
  }

  function bannerSticky(change) {
    return !change || change.sticky !== false;
  }

  function bannerCountdownMode(change) {
    const mode = change && change.countdown;
    if (mode === 'midnight' || mode === 'fixed' || mode === 'none') return mode;
    return 'none';
  }

  function bannerCss(position, sticky) {
    const edge = position === 'bottom' ? 'bottom' : 'top';
    const flow = sticky ? 'fixed' : 'absolute';
    return '#pivit-banner{'
      + 'position:' + flow + ';' + edge + ':0;left:0;right:0;z-index:' + BANNER_Z + ';'
      + 'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;'
      + 'box-sizing:border-box;width:100%;max-width:100%;margin:0;'
      + 'padding:12px 16px;'
      + 'padding:12px max(16px, env(safe-area-inset-right)) 12px max(16px, env(safe-area-inset-left));'
      + 'min-height:' + BANNER_FALLBACK_HEIGHT + 'px;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + 'font-size:16px;font-weight:650;line-height:1.3;text-align:center;'
      + 'overflow-wrap:anywhere;'
      + '}'
      + '#pivit-banner a{color:inherit;text-decoration:underline;display:inline;}'
      + '@media (max-width:640px){#pivit-banner{'
      + 'font-size:14px;line-height:1.35;min-height:44px;'
      + 'padding:10px 12px;'
      + 'padding:10px max(12px, env(safe-area-inset-right)) 10px max(12px, env(safe-area-inset-left));'
      + '}}';
  }

  function clearElementChildren(el) {
    const kids = el && el.children;
    if (kids && typeof kids.splice === 'function') {
      kids.splice(0, kids.length);
      return;
    }
    if (el && typeof el.replaceChildren === 'function') {
      el.replaceChildren();
      return;
    }
    if (el) el.innerHTML = '';
  }

  function applyBannerPadding(doc, position, px) {
    const root = (doc && doc.documentElement) || (doc && doc.body);
    if (!root || !root.style) return;
    const size = (px > 0 ? px : BANNER_FALLBACK_HEIGHT) + 'px';
    if (position === 'bottom') {
      root.style.paddingBottom = size;
      root.style.paddingTop = '';
    } else {
      root.style.paddingTop = size;
      root.style.paddingBottom = '';
    }
  }

  function bannerHeight(el) {
    const measured = el && typeof el.offsetHeight === 'number' ? el.offsetHeight : 0;
    return measured > 0 ? measured : BANNER_FALLBACK_HEIGHT;
  }

  function bannerEndMs(change, now) {
    const mode = bannerCountdownMode(change);
    if (mode === 'midnight') return nextLondonMidnight(now);
    if (mode === 'fixed') {
      const end = Date.parse(change && change.end);
      return Number.isFinite(end) ? end : NaN;
    }
    return NaN;
  }

  function ensureBannerStyle(doc, position, sticky) {
    const css = bannerCss(position, sticky);
    let styleEl = doc.getElementById && doc.getElementById(BANNER_STYLE_ID);
    if (styleEl && styleEl.isConnected === false) styleEl = null;
    if (!styleEl) {
      styleEl = doc.createElement('style');
      if (styleEl.setAttribute) {
        styleEl.setAttribute('id', BANNER_STYLE_ID);
        styleEl.setAttribute('data-pivit-banner-css', '');
      } else {
        styleEl.id = BANNER_STYLE_ID;
      }
      (doc.head || doc.documentElement).appendChild(styleEl);
    }
    if (styleEl.textContent !== css) styleEl.textContent = css;
    return styleEl;
  }

  function clearBannerTimer(doc, clearTimer) {
    if (!doc || doc.__pivitBannerTimerId == null) return;
    const clear = clearTimer || (typeof clearInterval === 'function' ? clearInterval : function () {});
    try { clear(doc.__pivitBannerTimerId); } catch (err) { /* already cleared */ }
    doc.__pivitBannerTimerId = null;
  }

  function watchBannerBox(doc, el) {
    if (!el || el.__pivitBannerObserver) return;
    const View = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!View || typeof View.ResizeObserver !== 'function') return;
    try {
      const observer = new View.ResizeObserver(function () {
        applyBannerPadding(doc, el.__pivitBannerPosition || 'top', bannerHeight(el));
      });
      observer.observe(el);
      el.__pivitBannerObserver = observer;
    } catch (err) { /* measuring the bar is optional */ }
  }

  function paintBannerCountdown(el, change, now) {
    if (!el || !el.__pivitCount) return;
    const date = now instanceof Date ? now : new Date(now);
    const end = bannerEndMs(change, date);
    const label = formatRemaining(end - date.getTime());
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    el.__pivitCount.textContent = (text ? ' ' : '') + label;
  }

  function armBannerCountdown(doc, el, change, opts) {
    const clearTimer = (opts && opts.clearInterval) || (typeof clearInterval === 'function' ? clearInterval : function () {});
    clearBannerTimer(doc, clearTimer);
    const mode = bannerCountdownMode(change);
    if (mode === 'none' || !el.__pivitCount) return;
    const setTimer = (opts && opts.setInterval) || (typeof setInterval === 'function' ? setInterval : null);
    if (!setTimer) return;
    const nowFn = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
    const id = setTimer(function () { paintBannerCountdown(el, change, nowFn()); }, 1000);
    if (id && typeof id.unref === 'function') id.unref();
    doc.__pivitBannerTimerId = id;
  }

  function applyBanner(doc, change, options) {
    if (!doc || !doc.createElement || !change || change.type !== 'banner') return null;
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    const mode = bannerCountdownMode(change);
    if (!text && mode === 'none') return null;
    const opts = options || {};
    const position = bannerPosition(change);
    const sticky = bannerSticky(change);
    const background = bannerColour(change.background, '#131723');
    const color = bannerColour(change.color, '#ffffff');
    const href = bannerHref(change.href);
    ensureBannerStyle(doc, position, sticky);

    const parent = doc.body || doc.documentElement;
    let el = doc.getElementById && doc.getElementById(BANNER_ID);
    if (el && el.isConnected === false) el = null;
    if (!el) {
      el = doc.createElement('div');
      if (el.setAttribute) {
        el.setAttribute('id', BANNER_ID);
        el.setAttribute('data-pivit-banner', '');
        el.setAttribute('role', 'region');
      } else {
        el.id = BANNER_ID;
      }
      if (parent && parent.appendChild) parent.appendChild(el);
    }
    if (el.setAttribute) el.setAttribute('aria-label', text || 'Banner');
    if (!el.style) el.style = {};
    el.style.background = background;
    el.style.color = color;
    el.__pivitBannerPosition = position;

    const nowFn = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
    const now = nowFn();
    clearElementChildren(el);
    const host = href ? doc.createElement('a') : el;
    if (href) {
      if (host.setAttribute) host.setAttribute('href', href);
      host.appendChild && el.appendChild(host);
    }
    const textEl = doc.createElement('span');
    if (textEl.setAttribute) textEl.setAttribute('data-pivit-banner-text', '');
    textEl.textContent = text;
    host.appendChild(textEl);
    el.__pivitCount = null;
    if (mode !== 'none') {
      const countEl = doc.createElement('span');
      if (countEl.setAttribute) countEl.setAttribute('data-pivit-banner-count', '');
      host.appendChild(countEl);
      el.__pivitCount = countEl;
      paintBannerCountdown(el, change, now);
    }
    applyBannerPadding(doc, position, bannerHeight(el));
    watchBannerBox(doc, el);
    armBannerCountdown(doc, el, change, opts);
    return el;
  }

  function createApplier(doc, options) {
    const schedule = (options && options.schedule) || function (fn) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
      else setTimeout(fn, 50);
    };
    const Observer = (options && options.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const skip = (options && options.skip) || function () { return false; };
    const seen = new Set();
    const watched = [];
    let observer = null;
    let pending = [];
    let scheduled = false;
    let applying = 0;
    let domApplies = 0;

    function inject(css, key) {
      if (!css) return;
      const id = cssDomId(key);
      if (doc.getElementById && doc.getElementById(id)) return;
      const styleEl = doc.createElement('style');
      styleEl.id = id;
      styleEl.setAttribute('data-pivit-css', '');
      styleEl.textContent = css;
      (doc.head || doc.documentElement).appendChild(styleEl);
    }

    // One style tag per page_css change. A later apply with the same key
    // updates that tag, or puts it back if an SPA render removed it. It does
    // not append a second tag.
    function injectPageCss(css, key) {
      const id = cssDomId(key);
      const existing = doc.getElementById && doc.getElementById(id);
      if (existing) {
        if (!css) {
          if (existing.remove) existing.remove();
        } else if (existing.textContent !== css) {
          existing.textContent = css;
        }
        return;
      }
      if (!css) return;
      const styleEl = doc.createElement('style');
      styleEl.id = id;
      styleEl.setAttribute('data-pivit-page-css', '');
      styleEl.textContent = css;
      (doc.head || doc.documentElement).appendChild(styleEl);
    }

    // Once per page view. The mark lives on the document, so a new applier
    // (the snippet starting again after an SPA re-render) and the mutation
    // observer cannot run the same change again. A new document is a new view.
    function pageJsStore() {
      if (!doc.__pivitPageJsRan || typeof doc.__pivitPageJsRan !== 'object') {
        doc.__pivitPageJsRan = Object.create(null);
      }
      return doc.__pivitPageJsRan;
    }

    function runPageJs(change, key) {
      let store;
      try {
        store = pageJsStore();
      } catch (err) {
        console.warn('[ab] page JS change failed:', err);
        return;
      }
      if (store[key]) return;
      store[key] = true;
      const source = typeof change.value === 'string' ? change.value : '';
      if (!source) return;
      try {
        const result = new Function('document', source)(doc);
        if (result && typeof result.then === 'function') {
          result.then(function () {}, function (err) {
            console.warn('[ab] page JS change failed:', err);
          });
        }
      } catch (err) {
        console.warn('[ab] page JS change failed:', err);
      }
    }

    function already(el, key) {
      const cur = el.getAttribute(MARK) || '';
      return cur.split(' ').indexOf(key) !== -1;
    }

    function mark(el, key) {
      if (!el || !el.setAttribute || already(el, key)) return;
      const cur = el.getAttribute(MARK) || '';
      el.setAttribute(MARK, cur ? cur + ' ' + key : key);
    }

    function markMatching(node, selector, key) {
      if (!node || node.nodeType !== 1) return;
      try {
        if (node.matches && node.matches(selector)) mark(node, key);
        if (node.querySelectorAll) node.querySelectorAll(selector).forEach((n) => mark(n, key));
      } catch (e) { /* selector can't be matched against the inserted fragment */ }
    }

    // `boundary` is the sibling that was next to `el` before the insert, so the
    // walk covers only the nodes just added and stops before pre-existing ones.
    function markInserted(el, which, selector, key, boundary) {
      let n = which === 'before' ? el.previousSibling : el.nextSibling;
      while (n && n !== boundary) {
        const step = which === 'before' ? n.previousSibling : n.nextSibling;
        if (n.nodeType === 1) markMatching(n, selector, key);
        n = step;
      }
    }

    function applyToElement(el, change, key, track) {
      if (!el || el.nodeType !== 1) return;
      if (skip(el)) return;
      if (track && already(el, key)) return;
      if (domApplies > 500) { disconnect(); return; }
      domApplies += 1;
      if (track) mark(el, key);
      applying += 1;
      try {
        switch (change.type) {
          case 'text':
            el.textContent = change.value;
            break;
          case 'html':
            el.innerHTML = change.value;
            break;
          case 'hide':
            el.style.display = 'none';
            break;
          case 'show':
            el.style.display = '';
            break;
          case 'style':
            Object.assign(el.style, change.value || {});
            break;
          case 'attr':
            if (change.attr) el.setAttribute(change.attr, change.value);
            break;
          case 'js':
            try { new Function('el', change.value)(el); }
            catch (err) { console.warn('[ab] custom JS change failed:', err); }
            break;
          case 'remove':
            el.remove();
            break;
          case 'duplicate': {
            const clone = el.cloneNode(true);
            clone.removeAttribute('id');
            if (track) mark(clone, key);
            el.insertAdjacentElement('afterend', clone);
            break;
          }
          case 'insert_before': {
            const boundary = el.previousSibling;
            el.insertAdjacentHTML('beforebegin', change.value || '');
            markInserted(el, 'before', change.selector, key, boundary);
            break;
          }
          case 'insert_after': {
            const boundary = el.nextSibling;
            el.insertAdjacentHTML('afterend', change.value || '');
            markInserted(el, 'after', change.selector, key, boundary);
            break;
          }
          case 'replace': {
            const boundary = el.nextSibling;
            el.insertAdjacentHTML('afterend', change.value || '');
            markInserted(el, 'after', change.selector, key, boundary);
            el.remove();
            break;
          }
          default:
            console.warn('[ab] unknown change type:', change.type);
        }
      } finally {
        applying -= 1;
        if (applying === 0 && pending.length) scheduleFlush();
      }
    }

    function applyDomQuery(change, key, track) {
      let list;
      try {
        list = doc.querySelectorAll(change.selector);
      } catch (err) {
        if (isPositionalSelector(change.selector)) throw err;
        console.warn('[ab] selector failed:', change.selector, err);
        return 0;
      }
      list.forEach((el) => applyToElement(el, change, key, track));
      return list.length;
    }

    function matchCount(selector) {
      try {
        const list = doc.querySelectorAll(selector);
        return list ? list.length : 0;
      } catch (err) {
        return 0;
      }
    }

    function processNode(node) {
      if (!node || node.nodeType !== 1 || node.isConnected === false) return;
      watched.forEach((w) => {
        try {
          if (node.matches && node.matches(w.change.selector)) applyToElement(node, w.change, w.key, true);
          if (node.querySelectorAll) node.querySelectorAll(w.change.selector).forEach((el) => applyToElement(el, w.change, w.key, true));
        } catch (err) {
          console.warn('[ab] selector failed:', w.change.selector, err);
        }
      });
    }

    function flush() {
      const batch = pending.splice(0, 40);
      batch.forEach(processNode);
      if (pending.length) scheduleFlush();
    }

    function scheduleFlush() {
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        flush();
      });
    }

    function ensureObserver() {
      if (observer || !Observer) return;
      const target = doc.documentElement || doc;
      if (!target || !target.nodeType) return;
      observer = new Observer((records) => {
        records.forEach((record) => {
          const nodes = record.addedNodes || [];
          for (let i = 0; i < nodes.length; i++) {
            if (nodes[i] && nodes[i].nodeType === 1) pending.push(nodes[i]);
          }
        });
        if (applying) return;
        if (pending.length) scheduleFlush();
      });
      observer.observe(target, { childList: true, subtree: true });
    }

    function applyOne(change, key) {
      if (!change) return { checked: false, applied: false };
      // Whole-page changes are not tied to an element, so they are not part
      // of the change-applied check and they are not replayed per node.
      if (change.type === 'page_css') {
        try { injectPageCss(typeof change.value === 'string' ? change.value : '', key); }
        catch (err) { console.warn('[ab] page CSS change failed:', err); }
        return { checked: false, applied: false };
      }
      if (change.type === 'page_js') {
        runPageJs(change, key);
        return { checked: false, applied: false };
      }
      if (change.type === 'banner') {
        try { applyBanner(doc, change, options); }
        catch (err) { console.warn('[ab] banner change failed:', err); }
        return { checked: false, applied: false };
      }
      if (seen.has(key)) return { checked: false, applied: false };
      seen.add(key);
      if (change.type === 'stylesheet') {
        // Free-form CSS, including the variant's custom CSS block. Injected
        // only because this variant is active — other variants never reach here.
        // No element lookup, so it is not part of the change-applied check.
        inject(change.value || '', key);
        return { checked: false, applied: false };
      }
      const css = cssForChange(change);
      if (css) {
        inject(css, key);
        return { checked: true, applied: matchCount(change.selector) > 0 };
      }
      if (!change.selector) {
        if (change.type && change.type !== 'stylesheet') console.warn('[ab] unknown change type:', change.type);
        return { checked: false, applied: false };
      }
      const track = shouldWatch(change);
      const found = applyDomQuery(change, key, track);
      if (track) {
        watched.push({ change, key });
        ensureObserver();
      }
      return { checked: true, applied: found > 0 };
    }

    function applyAll(changes, prefix) {
      const p = prefix || 'c';
      let checked = 0;
      let hit = 0;
      (changes || []).forEach((change, i) => {
        const result = applyOne(change, p + ':' + i);
        if (result && result.checked) {
          checked += 1;
          if (result.applied) hit += 1;
        }
      });
      return { checked, applied: hit, ok: checked > 0 ? hit === checked : null };
    }

    function disconnect() {
      if (observer) observer.disconnect();
      observer = null;
      clearBannerTimer(doc, options && options.clearInterval);
    }

    return { applyAll, applyOne, flush, disconnect };
  }

  return {
    cssEscape,
    isUnstableClass,
    isStateClass,
    isGeneratedClass,
    isPositionalSelector,
    uniqueSelector,
    generaliseSelector,
    cssForChange,
    createApplier,
    applyBanner,
    nextLondonMidnight,
    formatRemaining,
    bannerHref,
  };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
