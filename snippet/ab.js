/**
 * pivitlab snippet — v0.10
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
 * and names the selector in the preview note. This is separate from when
 * the test starts (below). A test that starts on page load keeps this wait.
 *
 * Start the test when: activation_type is page_load, element, js_condition
 * or manual. page_load is the default and is today's behaviour, including
 * the four second element_selector wait when that field is set. element
 * waits for activation_value, a CSS selector, for as long as the visitor
 * stays on this page. It does not use the four second limit. js_condition
 * waits until activation_value, an expression, is true. It is checked when
 * the DOM changes and every 500 milliseconds, for up to 10 minutes. A throw
 * is caught. After three errors in a row, checking stops and one message is
 * written to the console. The page is not broken. manual waits until the
 * page calls pivit.activate with the experiment id, including a call queued
 * before this file loads as pivit.push(['activate', id]). The visitor is
 * assigned, the variant is applied, and the view and GA4
 * experience_impression are sent only after that start. A visitor who never
 * reaches it is not assigned and is not counted. If element_selector is also
 * set, both have to be satisfied, and the watch uses the activation's own
 * limit rather than four seconds. An invalid selector or an unreadable
 * condition does not run the test. Leaving the address the test matched
 * cancels the watch. Preview shows the variant straight away and does not
 * wait. The editor (ab_edit) does not wait and does not count the visit.
 * pivit_qa is still stored as usual, and the view that is sent once the
 * test starts is still marked as test traffic.
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
 * and does not add a second one. page_js runs at most once per experiment
 * per document, not once per element. A second apply, a new applier on the
 * same document (an SPA re-render or a later address), and the mutation
 * observer all leave it unrun. A thrown error is caught so the rest of the
 * page still runs. Element html, stylesheet and js are unchanged.
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
 * nothing is sent until that state is granted. Google Tag Manager gets one
 * plain dataLayer object, because gtag('event', ...) hides the fields from
 * Data Layer Variables. A gtag.js page with no Tag Manager still uses gtag.
 * The two are never both used for the same impression.
 *
 * Click goals use one listener on the document, in the capture phase. The
 * selector is checked when the visitor clicks, so an element added after
 * load, or replaced by a later render, still converts. The listener does
 * not call preventDefault or stopPropagation: a link still navigates, and
 * the conversion beacon is sent with that click. One beacon per visitor
 * per goal. Preview and the editor do not install the listener.
 *
 * Element goals (type "element") count a conversion when a CSS selector
 * appears in the document. The check runs as soon as the visitor is in the
 * test, then a MutationObserver watches for a later render, including a
 * checkout that swaps the step in place and leaves the address unchanged.
 * The first time the element is there, one conversion is sent and that
 * watch disconnects. A second appearance, including a later page load, does
 * not send again. Preview and the editor do not watch. A pivit_qa visit
 * still sends the conversion as test traffic, on the same beacon as a click.
 *
 * Custom goals (type "custom") count a conversion when the page calls
 * pivit.track('payment_complete') with that goal's event name. A second
 * argument, pivit.track('checkout_step', { step_name: 'confirmation' }),
 * is the properties. A goal may require up to 3 key = value conditions.
 * Every condition has to match, compared as text, so the number 4 matches
 * "4". A goal with no conditions counts every call with that event name.
 * A page can queue the call before this file loads with
 * window.pivit = window.pivit || []; pivit.push(['track', 'payment_complete']).
 * The queued form with properties is
 * pivit.push(['track', 'checkout_step', { step_name: 'confirmation' }]).
 * The same queue starts a manual test:
 * pivit.push(['activate', '<test key>']). After this file loads, that is
 * pivit.activate('<test key>'). An array already stored on window.pivit is
 * replayed. An existing object is kept, and track and activate are added
 * on it. One conversion per visitor per goal.
 * Preview and the editor do not send. A pivit_qa visit still sends the
 * conversion as test traffic.
 *
 * When the experiments response includes datalayer_events, the same goals
 * also count a dataLayer.push({ event: 'payment_complete' }). The same
 * conditions are read from that object, so checkout_step with
 * step_name confirmation counts and checkout_step with step_name basket
 * does not. Entries already on dataLayer are scanned, and later pushes
 * are watched. The push itself is left alone. experience_impression, the
 * Send to GA4 event, is ignored, including a push this file makes. The
 * watch is not installed when the site has left the switch off. Preview
 * and the editor do not watch dataLayer for goals.
 *
 * Single-page apps: history.pushState, history.replaceState, popstate and
 * hashchange are watched. A change that leaves the address the same is
 * ignored. Changes inside about a tenth of a second collapse into one, so
 * the API is asked once for the address the visitor actually landed on.
 * That request enrols and applies any test that newly matches, and URL
 * goals are checked again. A test already applied on this document stays
 * applied until the next full load: it is not removed, not applied again,
 * and its view is not sent again. Its page JavaScript does not run again.
 * Send to GA4 still uses the same impression dedupe, so the combined check
 * does not send a second experience_impression for that address. The click
 * listener is the one already installed; a newly applied test adds its
 * goals to it. data-spa="off" on the snippet tag leaves tests and URL goals
 * on full loads only. Send to GA4 still follows the address in that case.
 * An ab_edit or preview address is not re-checked and is not tracked.
 * In the editor, pushState and replaceState keep ab_edit and token on the
 * address, so a single-page app that rewrites the URL does not close it.
 *
 * Selectors and applying changes live on PivitRuntime (also exported for tests).
 * The visual editor uses the same helpers, so a selector saved from the editor
 * is what visitors get. Positional selectors (nth-child / nth-of-type and the
 * other structural pseudos) are applied once, inline, exactly as before.
 */
(function (root) {
  const ELEMENT_WAIT_MS = 4000;
  // A JavaScript condition is checked on DOM changes and on this poll.
  // Ten minutes is the longest a visit keeps being asked. Three throws in
  // a row stop the check. One console warning is written, and the page
  // keeps running.
  const JS_CONDITION_POLL_MS = 500;
  const JS_CONDITION_LIMIT_MS = 10 * 60 * 1000;
  const JS_CONDITION_ERROR_LIMIT = 3;
  const JS_CONDITION_MAX = 500;
  // These sit above the early return. Node requires this file and never
  // reaches the browser boot, so a const declared later would still be
  // uninitialised when a test calls in.
  const compiledConditions = Object.create(null);
  const jsConditionLogged = Object.create(null);
  const pendingManual = Object.create(null);
  const manualListeners = [];
  // About a tenth of a second. A router that writes the address twice in
  // one turn, or a push followed at once by a replace, becomes one request.
  const SPA_DEBOUNCE_MS = 100;
  const ASSIGNMENT_PREFIX = '_ab_assign_';
  const api = buildPivitRuntime();
  const clickSeen = Object.create(null);
  const elementSeen = Object.create(null);
  const customSeen = Object.create(null);
  // Filled in once this file is running in a browser. Tests call the
  // exported helpers and never reach the page wiring below.
  let noteCustomEvent = function () {};
  let addCustomGoals = function () {};
  let customTracking = false;
  api.matchUrlGoal = matchUrlGoal;
  api.isSafeRegex = isSafeRegex;
  api.shouldCountUrlGoal = shouldCountUrlGoal;
  api.claimClick = claimClick;
  api.claimElement = claimElement;
  api.claimCustom = claimCustom;
  api.clickStorageKey = clickStorageKey;
  api.elementStorageKey = elementStorageKey;
  api.customStorageKey = customStorageKey;
  api.clickGoalsFrom = clickGoalsFrom;
  api.elementGoalsFrom = elementGoalsFrom;
  api.customGoalsFrom = customGoalsFrom;
  api.customGoalsFromExperiments = customGoalsFromExperiments;
  api.normaliseCustomEventName = normaliseCustomEventName;
  api.eventNameFromQueueItem = eventNameFromQueueItem;
  api.propsFromQueueItem = propsFromQueueItem;
  api.dataLayerEntryEventName = dataLayerEntryEventName;
  api.customPropertiesMatch = customPropertiesMatch;
  api.installPivitTracker = installPivitTracker;
  api.hookDataLayer = hookDataLayer;
  api.watchDataLayer = watchDataLayer;
  api.customTrackingAllowed = customTrackingAllowed;
  api.createElementWatcher = createElementWatcher;
  api.clickGoalElement = clickGoalElement;
  api.createClickTracker = createClickTracker;
  api.qaFlagFromSearch = qaFlagFromSearch;
  api.applyQaFlag = applyQaFlag;
  api.readQaFlag = readQaFlag;
  api.eventBody = eventBody;
  api.withQaQuery = withQaQuery;
  api.withSite = withSite;
  api.ELEMENT_WAIT_MS = ELEMENT_WAIT_MS;
  api.elementSelectorOf = elementSelectorOf;
  api.activationOf = activationOf;
  api.activationDelays = activationDelays;
  api.activationQuery = activationQuery;
  api.compileJsCondition = compileJsCondition;
  api.rememberManualActivation = rememberManualActivation;
  api.manualActivationSeen = manualActivationSeen;
  api.resetManualActivations = resetManualActivations;
  api.activationKeyFromQueueItem = activationKeyFromQueueItem;
  api.JS_CONDITION_POLL_MS = JS_CONDITION_POLL_MS;
  api.JS_CONDITION_LIMIT_MS = JS_CONDITION_LIMIT_MS;
  api.JS_CONDITION_ERROR_LIMIT = JS_CONDITION_ERROR_LIMIT;
  api.elementQuery = elementQuery;
  api.elementIsPresent = elementIsPresent;
  api.waitForElement = waitForElement;
  api.exposeWhenReady = exposeWhenReady;
  api.createActivationSession = createActivationSession;
  api.previewWaits = previewWaits;
  api.previewInfo = previewInfo;
  api.mayBucketExperiment = mayBucketExperiment;
  api.assignVariant = assignVariant;
  api.normaliseGa4MeasurementId = normaliseGa4MeasurementId;
  api.expVariantString = expVariantString;
  api.pageViewKey = pageViewKey;
  api.analyticsStorageState = analyticsStorageState;
  api.analyticsConsentAllows = analyticsConsentAllows;
  api.gtmOnPage = gtmOnPage;
  api.ga4Transport = ga4Transport;
  api.planExperienceImpressions = planExperienceImpressions;
  api.deliverExperienceImpression = deliverExperienceImpression;
  api.markImpressionsSent = markImpressionsSent;
  api.sendPlannedImpressions = sendPlannedImpressions;
  api.watchAnalyticsConsent = watchAnalyticsConsent;
  api.bindSpaRouteChanges = bindSpaRouteChanges;
  api.SPA_DEBOUNCE_MS = SPA_DEBOUNCE_MS;
  api.spaNavigationEnabled = spaNavigationEnabled;
  api.spaRecheckAllowed = spaRecheckAllowed;
  api.modeFromHref = modeFromHref;
  api.urlWithEditParams = urlWithEditParams;
  api.bindEditHistory = bindEditHistory;
  api.stepsNoteLabel = stepsNoteLabel;
  api.mountStepsNote = mountStepsNote;
  api.createRouteSession = createRouteSession;
  api.startSpaRecheck = startSpaRecheck;
  api.createNavigationGate = createNavigationGate;
  api.publicExperimentsUrl = publicExperimentsUrl;
  api.applyMatchingExperiments = applyMatchingExperiments;
  api.deliverNavigation = deliverNavigation;
  api.planUrlConversions = planUrlConversions;
  api.TEST_VISITOR_PREFIX = 'v_pt';
  api.QA_STORAGE_KEY = 'pivit_qa';
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.PivitRuntime = api;

  // Calls made before this file loads sit on window.pivit as an array.
  // The event name and its properties are remembered, and sent only after
  // a real visit is enrolled. Preview and the editor leave customTracking
  // false, so nothing is sent. A later goal can still match an earlier
  // payload, which is how confirmation counts when basket was already
  // on dataLayer. Fifty payloads is enough for a checkout and bounds a
  // page that pushes on a timer.
  const customEvents = [];
  const customGoalList = [];
  const customMemory = Object.create(null);
  function flushCustom(onlyName) {
    if (!customTracking) return;
    for (let i = 0; i < customGoalList.length; i++) {
      const goal = customGoalList[i];
      if (!goal) continue;
      if (onlyName && goal.event !== onlyName) continue;
      let matched = false;
      for (let k = 0; k < customEvents.length; k++) {
        const entry = customEvents[k];
        if (entry.name !== goal.event) continue;
        if (!customPropertiesMatch(goal.when, entry.props)) continue;
        matched = true;
        break;
      }
      if (!matched) continue;
      if (!claimCustom(localStorage, goal.visitorId, goal.experimentId, goal.goalId, customMemory)) continue;
      sendEvent(goal.experimentId, goal.variantId, goal.visitorId, 'convert', goal.goalId);
    }
  }
  noteCustomEvent = function (name, props) {
    const clean = normaliseCustomEventName(name);
    if (!clean) return;
    customEvents.push({ name: clean, props: plainCustomProps(props) });
    if (customEvents.length > 50) customEvents.shift();
    flushCustom(clean);
  };
  addCustomGoals = function (list) {
    const adding = list || [];
    for (let i = 0; i < adding.length; i++) {
      const goal = adding[i];
      if (!goal || !goal.goalId || !goal.event) continue;
      let duplicate = false;
      for (let j = 0; j < customGoalList.length; j++) {
        const existing = customGoalList[j];
        if (existing.experimentId === goal.experimentId && existing.goalId === goal.goalId) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) customGoalList.push(goal);
    }
    flushCustom(null);
  };
  installPivitTracker(root, noteCustomEvent);

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
  // Bump when editor.js changes so a cached copy cannot keep the old variant.
  const EDITOR_VERSION = '20261024a';
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

  // The last ab_edit or ab_preview in the query wins, including a leftover
  // from an earlier test in the same address.
  function modeFromHref(href) {
    let params;
    try {
      params = new URL(href, 'https://pivitlab.invalid').searchParams;
    } catch (err) {
      return { type: null, variantId: null, token: null };
    }
    let mode = null;
    params.forEach(function (value, key) {
      if (!value) return;
      if (key === 'ab_edit') mode = { type: 'edit', variantId: value };
      else if (key === 'ab_preview') mode = { type: 'preview', variantId: value };
    });
    if (!mode) return { type: null, variantId: null, token: null };
    mode.token = mode.type === 'edit' ? lastQuery(params, 'token') : lastQuery(params, 'ab_preview_token');
    return mode;
  }

  function pageMode() {
    return modeFromHref(window.location.href);
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
  function pickVariant(experiment, visitorId, storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    let stored = null;
    try { stored = store && store.getItem ? store.getItem(ASSIGNMENT_PREFIX + experiment.id) : null; } catch (e) { stored = null; }
    if (stored) {
      const match = (experiment.variants || []).find((v) => v.id === stored);
      if (match) return match;
    }

    const chosen = assignVariant(experiment, visitorId);
    if (!chosen || !chosen.id) return null;
    try {
      if (!store || !store.setItem) return null;
      store.setItem(ASSIGNMENT_PREFIX + experiment.id, chosen.id);
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

  // One document listener for every click goal enrolled on this page.
  // The selector is checked at click time, so a node that was not in the
  // document yet still counts, and so does a node a later render swapped in.
  // Binding each match as it appeared would miss a click in that same turn,
  // and would drop the goal when the node was replaced. Capture runs before
  // the page's own handler, which may remove the button or follow a link.
  // The event is left alone, so that still happens. claimClick keeps a
  // single beacon per visitor per goal.
  let pageClickTracker = null;
  let pageElementWatcher = null;
  function wireConversionTracking(experimentId, variantId, visitorId, goals) {
    const context = {
      experimentId: experimentId,
      variantId: variantId,
      visitorId: visitorId,
    };
    const list = clickGoalsFrom(goals, context);
    if (list.length) {
      if (!pageClickTracker) {
        pageClickTracker = createClickTracker(document, {
          claim: function (goal) {
            return claimClick(localStorage, goal.visitorId, goal.experimentId, goal.goalId);
          },
          send: function (goal) {
            sendEvent(goal.experimentId, goal.variantId, goal.visitorId, 'convert', goal.goalId);
          },
        });
      }
      pageClickTracker.track(list);
    }
    // The visitor is already in the test. Watch until the element appears,
    // including a render that does not change the address, then disconnect.
    // claimElement is the same once-per-visitor record as a click, on its
    // own key, so a repeat visit does not send a second conversion.
    addCustomGoals(customGoalsFrom(goals, context));
    const elements = elementGoalsFrom(goals, context);
    if (!elements.length) return;
    if (!pageElementWatcher) {
      pageElementWatcher = createElementWatcher(document, {
        claim: function (goal) {
          return claimElement(localStorage, goal.visitorId, goal.experimentId, goal.goalId);
        },
        send: function (goal) {
          sendEvent(goal.experimentId, goal.variantId, goal.visitorId, 'convert', goal.goalId);
        },
      });
    }
    pageElementWatcher.watch(elements);
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
  // completely different page. On a full load, and again when a single-page
  // app changes the address, check every experiment this visitor has been
  // assigned to (found via localStorage) against that address, and fire a
  // conversion once per goal if it matches.
  function planUrlConversions(experiments, assignments, href, enrolledThisView) {
    const assigned = assignments || {};
    const out = [];
    (experiments || []).forEach((experiment) => {
      if (!experiment || !shouldCountUrlGoal(experiment.id, enrolledThisView)) return;
      const variantId = assigned[experiment.id];
      const variant = (experiment.variants || []).find((v) => v.id === variantId);
      if (!variant) return;
      goalsFor(experiment, variant).forEach((goal) => {
        if (goal.type !== 'url' || !goal.url_match) return;
        if (!matchUrlGoal(goal.url_match, href, goal.match || 'contains')) return;
        const goalId = goal.id || goal.url_match;
        out.push({
          experimentId: experiment.id,
          variantId: variantId,
          goalId: goalId,
          key: '_ab_converted_' + experiment.id + '_' + goalId,
        });
      });
    });
    return out;
  }

  async function checkUrlGoals(visitorId, enrolledThisView, href) {
    const assignments = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(ASSIGNMENT_PREFIX) === 0) {
        assignments[key.slice(ASSIGNMENT_PREFIX.length)] = localStorage.getItem(key);
      }
    }
    const experimentIds = Object.keys(assignments);
    if (experimentIds.length === 0) return;

    const pageHref = href || (window.location && window.location.href) || '';
    try {
      const res = await fetch(api.withQaQuery(api.withSite(`${API_BASE}/api/experiments/by-ids?ids=${experimentIds.join(',')}`, SITE_KEY), qaOn));
      const data = await res.json();
      // The visitor may have moved on while this request was in flight. The
      // navigation that is current now checks that address itself.
      if (pageViewKey(window.location.href) !== pageViewKey(pageHref)) return;
      const planned = planUrlConversions(data.experiments, assignments, pageHref, enrolledThisView);
      planned.forEach((item) => {
        if (localStorage.getItem(item.key)) return; // only count once per visitor per goal
        localStorage.setItem(item.key, '1');
        sendEvent(item.experimentId, item.variantId, visitorId, 'convert', item.goalId);
      });
      addCustomGoals(customGoalsFromExperiments(data.experiments, assignments, visitorId));
    } catch (err) {
      console.warn('[ab] failed to check URL goals:', err);
    }
  }

  function elementSelectorOf(experiment) {
    const raw = experiment && experiment.element_selector;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  // page_load is the default, including a payload from before this field
  // existed. element with an empty selector does not run: it must not fall
  // through to counting every visitor. js_condition and manual do not fall
  // through either. The manual key is the experiment id.
  function activationOf(experiment) {
    const raw = experiment && experiment.activation_type;
    const value = experiment && typeof experiment.activation_value === 'string'
      ? experiment.activation_value.trim()
      : '';
    if (raw === 'element') return { type: 'element', selector: value };
    if (raw === 'js_condition') return { type: 'js_condition', expression: value };
    if (raw === 'manual') {
      const id = experiment && experiment.id != null ? String(experiment.id).trim() : '';
      return { type: 'manual', key: id };
    }
    return { type: 'page_load', selector: '' };
  }

  function activationDelays(experiment) {
    const type = activationOf(experiment).type;
    return type === 'element' || type === 'js_condition' || type === 'manual';
  }

  function logJsConditionOnce(key, message, err) {
    const id = String(key || message || 'js');
    if (jsConditionLogged[id]) return;
    jsConditionLogged[id] = true;
    try {
      if (typeof console !== 'undefined' && console.warn) console.warn(message, err || '');
    } catch (logErr) { /* a console failure must not break the page */ }
  }
  function compileJsCondition(source) {
    const text = typeof source === 'string' ? source.trim() : '';
    if (!text || text.length > JS_CONDITION_MAX || /[\u0000-\u001f]/.test(text)) {
      return { ok: false, reason: 'invalid' };
    }
    if (Object.prototype.hasOwnProperty.call(compiledConditions, text)) return compiledConditions[text];
    let fn;
    try {
      // Sloppy on purpose, so a bare name such as checkout resolves on the
      // page. The same new Function shape as page JavaScript. It is not run
      // until the check below, and a throw there is caught.
      fn = new Function('window', 'document', 'return (' + text + ');');
    } catch (err) {
      const failed = { ok: false, reason: 'syntax', error: err };
      compiledConditions[text] = failed;
      logJsConditionOnce(text, '[ab] JavaScript condition stopped. It could not be read, so this test will not run.', err);
      return failed;
    }
    const compiled = { ok: true, fn: fn };
    compiledConditions[text] = compiled;
    return compiled;
  }
  function readJsCondition(fn, win, doc) {
    try {
      return { ok: true, value: !!fn(win || {}, doc) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  function manualKey(value) {
    if (typeof value !== 'string') return '';
    const id = value.trim().toLowerCase();
    if (!id || id.length > 80) return '';
    return id;
  }
  function rememberManualActivation(key) {
    const id = manualKey(key);
    if (!id) return '';
    pendingManual[id] = true;
    const pending = manualListeners.slice();
    for (let i = 0; i < pending.length; i++) {
      try { pending[i](id); }
      catch (err) { /* a listener must not break the page */ }
    }
    return id;
  }
  function manualActivationSeen(key) {
    const id = manualKey(key);
    return !!(id && pendingManual[id]);
  }
  function resetManualActivations() {
    Object.keys(pendingManual).forEach(function (id) { delete pendingManual[id]; });
    manualListeners.length = 0;
  }
  function onManualActivation(fn) {
    manualListeners.push(fn);
    return function () {
      const index = manualListeners.indexOf(fn);
      if (index !== -1) manualListeners.splice(index, 1);
    };
  }

  // present when the test may start. missing when a watch should continue.
  // invalid when a selector cannot be queried. page_load only looks at
  // element_selector, which is what tests already do.
  function activationQuery(doc, experiment) {
    const activation = activationOf(experiment);
    if (activation.type === 'js_condition' || activation.type === 'manual') {
      return delayedActivationQuery(doc, experiment, activation);
    }
    if (activation.type === 'element') {
      if (!activation.selector) return { state: 'invalid', selector: '' };
      const act = elementQuery(doc, activation.selector);
      if (act.state !== 'present') return act;
    }
    const extra = elementQuery(doc, elementSelectorOf(experiment));
    if (activation.type === 'element' && extra.state === 'none') {
      return { state: 'present', selector: activation.selector };
    }
    return extra;
  }

  // present once the start has happened and element_selector, when set, is
  // on the page. A throw is missing, not invalid, so a later check can still
  // succeed. An unreadable expression is invalid and does not run the test.
  function delayedActivationQuery(doc, experiment, activation) {
    if (activation.type === 'manual') {
      if (!activation.key || !manualActivationSeen(activation.key)) {
        return { state: 'missing', selector: activation.key || '' };
      }
    } else {
      const compiled = compileJsCondition(activation.expression);
      if (!compiled.ok) return { state: 'invalid', selector: '' };
      const win = typeof window !== 'undefined' ? window : globalThis;
      const read = readJsCondition(compiled.fn, win, doc);
      if (!read.ok || !read.value) return { state: 'missing', selector: '' };
    }
    const extra = elementQuery(doc, elementSelectorOf(experiment));
    if (extra.state === 'none') {
      return { state: 'present', selector: activation.type === 'manual' ? activation.key : '' };
    }
    return extra;
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

  // Watches until the activation selector is in the document, and until
  // element_selector is too when that rule is set. There is no timer: the
  // watch lasts for the visit. An invalid selector resolves immediately.
  // hold.disconnect stops the observer, for a route change.
  function waitForActivation(doc, activationSelector, elementSelector, options) {
    const opts = options || {};
    const act = typeof activationSelector === 'string' ? activationSelector.trim() : '';
    const extra = typeof elementSelector === 'string' ? elementSelector.trim() : '';
    if (!act) return Promise.resolve({ found: false, reason: 'invalid', selector: '' });
    const selectors = extra && extra !== act ? [act, extra] : [act];

    function combined() {
      let missing = '';
      for (let i = 0; i < selectors.length; i++) {
        const query = elementQuery(doc, selectors[i]);
        if (query.state === 'invalid') return { found: false, reason: 'invalid', selector: query.selector };
        if (query.state === 'missing') missing = query.selector;
      }
      if (missing) return { found: false, reason: 'missing', selector: missing };
      return { found: true, reason: 'present', selector: act };
    }

    const first = combined();
    if (first.found || first.reason === 'invalid') return Promise.resolve(first);

    const Observer = opts.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    return new Promise(function (resolve) {
      let settled = false;
      let observer = null;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (observer) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
        }
        resolve(result);
      }
      function look(reason) {
        if (typeof opts.isStale === 'function' && opts.isStale()) {
          finish({ found: false, reason: 'stale', selector: act });
          return;
        }
        const query = combined();
        if (query.found) finish({ found: true, reason: reason, selector: act });
        else if (query.reason === 'invalid') finish(query);
      }
      if (opts.hold) {
        opts.hold.disconnect = function () {
          finish({ found: false, reason: 'stale', selector: act });
        };
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
      if (!observer) finish({ found: false, reason: 'unavailable', selector: act });
    });
  }

  function clearHandle(clear, id) {
    if (id == null || typeof clear !== 'function') return;
    try { clear(id); } catch (err) { /* already cleared */ }
  }

  // A timer must not keep a test process alive, and must not throw if the
  // browser has no unref.
  function armTimer(set, fn, ms) {
    let id = null;
    try { id = set(fn, ms); } catch (err) { return null; }
    if (id && typeof id.unref === 'function') {
      try { id.unref(); } catch (err) { /* browsers have no unref */ }
    }
    return id;
  }

  // Checks the expression on DOM changes and every 500 milliseconds, for up
  // to 10 minutes. A throw is caught. Three in a row stop the check and log
  // once. The promise always settles. It does not reject.
  function waitForJsCondition(doc, expression, elementSelector, options) {
    const opts = options || {};
    const compiled = compileJsCondition(expression);
    if (!compiled.ok) return Promise.resolve({ found: false, reason: 'invalid' });
    const extra = typeof elementSelector === 'string' ? elementSelector.trim() : '';
    const win = opts.window || (typeof window !== 'undefined' ? window : globalThis);
    const setIntervalFn = opts.setInterval || function (fn, ms) { return setInterval(fn, ms); };
    const clearIntervalFn = opts.clearInterval || function (id) { clearInterval(id); };
    const setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
    const Observer = opts.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const log = opts.log || function (message, err) { logJsConditionOnce(expression, message, err); };

    function ready() {
      const read = readJsCondition(compiled.fn, win, doc);
      if (!read.ok) return { found: false, reason: 'error', error: read.error };
      if (!read.value) return { found: false, reason: 'missing' };
      const query = elementQuery(doc, extra);
      if (query.state === 'invalid') return { found: false, reason: 'invalid', stop: true };
      if (query.state === 'missing') return { found: false, reason: 'missing' };
      return { found: true, reason: 'condition' };
    }

    const first = ready();
    if (first.found || first.stop) return Promise.resolve(first);
    if (first.reason === 'error') {
      // Counted again inside the watch, so the first failure is not lost
      // when the caller also checked before arming the watch.
    }

    return new Promise(function (resolve) {
      let settled = false;
      let observer = null;
      let interval = null;
      let timer = null;
      let errors = 0;
      let logged = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (observer) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
        }
        clearHandle(clearIntervalFn, interval);
        clearHandle(clearTimer, timer);
        resolve(result);
      }
      function fail(err) {
        if (logged) {
          finish({ found: false, reason: 'errors' });
          return;
        }
        logged = true;
        try {
          log('[ab] JavaScript condition stopped after repeated errors. This test will not run.', err);
        } catch (logErr) { /* the page still runs */ }
        finish({ found: false, reason: 'errors' });
      }
      function look() {
        if (settled) return;
        try {
          if (typeof opts.isStale === 'function' && opts.isStale()) {
            finish({ found: false, reason: 'stale' });
            return;
          }
          const query = ready();
          if (query.found) finish(query);
          else if (query.stop || query.reason === 'invalid') finish(query);
          else if (query.reason === 'error') {
            errors += 1;
            if (errors >= JS_CONDITION_ERROR_LIMIT) fail(query.error);
          } else {
            errors = 0;
          }
        } catch (err) {
          errors += 1;
          if (errors >= JS_CONDITION_ERROR_LIMIT) fail(err);
        }
      }
      if (opts.hold) {
        opts.hold.disconnect = function () {
          finish({ found: false, reason: 'stale' });
        };
      }
      if (Observer && doc) {
        try {
          observer = new Observer(function () { look(); });
          const target = doc.documentElement || doc.body || doc;
          if (target) observer.observe(target, { childList: true, subtree: true, attributes: true });
        } catch (err) {
          observer = null;
        }
      }
      interval = armTimer(setIntervalFn, look, JS_CONDITION_POLL_MS);
      timer = armTimer(setTimer, function () {
        finish({ found: false, reason: 'timeout' });
      }, JS_CONDITION_LIMIT_MS);
      if (first.reason === 'error') {
        errors = 1;
      }
    });
  }

  // Resolves when pivit.activate has been called for this test's key, and
  // element_selector is on the page when that rule is set. There is no
  // ten-minute limit. Leaving the address disconnects the watch.
  function waitForManual(doc, key, elementSelector, options) {
    const opts = options || {};
    const id = typeof key === 'string' ? key.trim() : '';
    const extra = typeof elementSelector === 'string' ? elementSelector.trim() : '';
    if (!id) return Promise.resolve({ found: false, reason: 'invalid', selector: '' });
    const Observer = opts.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    function ready() {
      if (typeof opts.isStale === 'function' && opts.isStale()) {
        return { found: false, reason: 'stale', selector: id, stop: true };
      }
      if (!manualActivationSeen(id)) return { found: false, reason: 'missing', selector: id };
      const query = elementQuery(doc, extra);
      if (query.state === 'invalid') return { found: false, reason: 'invalid', selector: query.selector, stop: true };
      if (query.state === 'missing') return { found: false, reason: 'missing', selector: id };
      return { found: true, reason: 'activated', selector: id };
    }

    const first = ready();
    if (first.found || first.stop) return Promise.resolve(first);

    return new Promise(function (resolve) {
      let settled = false;
      let observer = null;
      let unlisten = null;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (observer) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
        }
        if (typeof unlisten === 'function') {
          try { unlisten(); } catch (err) { /* already gone */ }
        }
        resolve(result);
      }
      function look() {
        if (settled) return;
        try {
          const query = ready();
          if (query.found || query.stop) finish(query);
        } catch (err) { /* a later call can still start the test */ }
      }
      if (opts.hold) {
        opts.hold.disconnect = function () {
          finish({ found: false, reason: 'stale', selector: id });
        };
      }
      try { unlisten = onManualActivation(look); }
      catch (err) { unlisten = null; }
      if (Observer && doc) {
        try {
          observer = new Observer(function () { look(); });
          const target = doc.documentElement || doc.body || doc;
          if (target) observer.observe(target, { childList: true, subtree: true });
        } catch (err) {
          observer = null;
        }
      }
    });
  }

  // onExpose is the bucket: assignment, DOM changes, and the view. It is
  // not called when the start never happens. page_load uses the four
  // second element_selector wait. An element start waits for the visit.
  // A JavaScript condition waits up to 10 minutes. Manual waits for the call.
  function exposeWhenReady(experiment, deps) {
    const d = deps || {};
    const activation = activationOf(experiment);
    if (activation.type === 'element') {
      return waitForActivation(d.document, activation.selector, elementSelectorOf(experiment), d).then(function (gate) {
        if (!gate.found) return { exposed: false, reason: gate.reason, selector: gate.selector || activation.selector };
        if (typeof d.isStale === 'function' && d.isStale()) {
          return { exposed: false, reason: 'stale', selector: activation.selector };
        }
        if (typeof d.onExpose === 'function') d.onExpose(experiment);
        return { exposed: true, reason: gate.reason, selector: activation.selector };
      });
    }
    if (activation.type === 'js_condition') {
      return waitForJsCondition(d.document, activation.expression, elementSelectorOf(experiment), d).then(function (gate) {
        if (!gate.found) return { exposed: false, reason: gate.reason };
        if (typeof d.isStale === 'function' && d.isStale()) return { exposed: false, reason: 'stale' };
        if (typeof d.onExpose === 'function') d.onExpose(experiment);
        return { exposed: true, reason: gate.reason };
      });
    }
    if (activation.type === 'manual') {
      return waitForManual(d.document, activation.key, elementSelectorOf(experiment), d).then(function (gate) {
        if (!gate.found) return { exposed: false, reason: gate.reason, selector: gate.selector || activation.key };
        if (typeof d.isStale === 'function' && d.isStale()) {
          return { exposed: false, reason: 'stale', selector: activation.key };
        }
        if (typeof d.onExpose === 'function') d.onExpose(experiment);
        return { exposed: true, reason: gate.reason, selector: activation.key };
      });
    }
    const selector = elementSelectorOf(experiment);
    return waitForElement(d.document, selector, d).then(function (gate) {
      if (!gate.found) return { exposed: false, reason: gate.reason, selector: selector };
      if (typeof d.onExpose === 'function') d.onExpose(experiment);
      return { exposed: true, reason: gate.reason, selector: selector };
    });
  }

  // One watch per experiment. A later arm, or retain() dropping the id,
  // disconnects the previous observer so a route change cannot assign late.
  function createActivationSession() {
    const cancels = Object.create(null);
    return {
      retain: function (keep) {
        const ids = keep || {};
        Object.keys(cancels).forEach(function (id) {
          if (!ids[id]) {
            cancels[id]();
            delete cancels[id];
          }
        });
      },
      arm: function (experiment, context) {
        const ctx = context || {};
        const id = experiment && experiment.id;
        if (id == null || id === '') return;
        if (cancels[id]) cancels[id]();
        let cancelled = false;
        const hold = {};
        cancels[id] = function () {
          cancelled = true;
          if (typeof hold.disconnect === 'function') hold.disconnect();
        };
        const pageKey = pageViewKey(ctx.href || '');
        api.exposeWhenReady(experiment, {
          document: ctx.document,
          MutationObserver: ctx.MutationObserver,
          hold: hold,
          isStale: function () { return cancelled; },
          onExpose: function () {
            if (cancelled) return;
            let current = ctx.href || '';
            if (typeof ctx.currentHref === 'function') {
              try { current = ctx.currentHref(); } catch (err) { return; }
            }
            if (pageViewKey(current) !== pageKey) return;
            if (typeof ctx.onExpose === 'function') ctx.onExpose(experiment);
          },
        }).catch(function () { /* a later address can still watch */ });
      },
    };
  }

  // Preview does not wait for an element start. The older element rule
  // still waits about four seconds, the same as before.
  function previewWaits(experiment) {
    const selector = elementSelectorOf(experiment);
    return {
      activation: activationDelays(experiment),
      selector: selector,
      waitForElementRule: !!selector,
    };
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
    const activation = activationOf(experiment);
    const found = !gate || gate.found !== false;
    if (selector && !found) {
      return '[ab] preview mode — not showing variant "' + variantName + '" for experiment "' + experimentName
        + '". This page has no element matching "' + selector + '", so nothing is applied. No events are being logged.';
    }
    if (activation.type === 'element' && activation.selector) {
      let message = '[ab] preview mode — showing variant "' + variantName + '" for experiment "' + experimentName + '". ';
      if (selector) message += 'It runs only when "' + selector + '" is on the page. ';
      return message + 'Live visitors are counted only once "' + activation.selector
        + '" appears. This preview shows the variant now, without waiting. No events are being logged.';
    }
    if (activation.type === 'js_condition') {
      let message = '[ab] preview mode — showing variant "' + variantName + '" for experiment "' + experimentName + '". ';
      if (selector) message += 'It runs only when "' + selector + '" is on the page. ';
      return message + 'Live visitors are counted only once the JavaScript condition is true. This preview shows the variant now, without waiting. No events are being logged.';
    }
    if (activation.type === 'manual') {
      let message = '[ab] preview mode — showing variant "' + variantName + '" for experiment "' + experimentName + '". ';
      if (selector) message += 'It runs only when "' + selector + '" is on the page. ';
      return message + 'Live visitors are counted only once the page calls pivit.activate. This preview shows the variant now, without waiting. No events are being logged.';
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
        const activation = api.activationOf(experiment);
        const query = api.activationDelays(experiment)
          ? api.activationQuery(document, experiment)
          : api.elementQuery(document, api.elementSelectorOf(experiment));
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
      const pending = api.activationDelays(experiment)
        ? api.exposeWhenReady(experiment, { document: document })
        : api.waitForElement(document, api.elementSelectorOf(experiment)).then(function (gate) {
          return { exposed: !!(gate && gate.found) };
        });
      pending.then(function (gate) {
        if (!gate || gate.exposed === false) return;
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

    // Before any await. A single-page app often rewrites the address as soon
    // as its own script runs, and that can drop ab_edit and token. Wrapping
    // history here, while this script is still synchronous, puts them back.
    if (mode.type === 'edit' && mode.variantId && mode.token) {
      bindEditHistory(window, mode.variantId, mode.token);
    }

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
      if (mode.token) editorScript.setAttribute('data-token', mode.token);
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
          api.mountStepsNote(document, match.variant && match.variant.steps_note);
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
      if (customTrackingAllowed(mode)) customTracking = true;

      const visitorId = getVisitorId();
      const enrolledThisView = Object.create(null);
      // One record for this document. A test applied on the first load, or
      // on a later address, is not applied again until the next full load.
      const appliedOnPage = Object.create(null);
      const activationSession = createActivationSession();
      const navigationGate = createNavigationGate();

      function watchWaiting(waiting, href, enrolled, stayOnPage) {
        const pageKey = pageViewKey(href || window.location.href);
        const keep = Object.create(null);
        (waiting || []).forEach((experiment) => {
          if (experiment && api.activationDelays(experiment) && experiment.id != null) {
            keep[experiment.id] = 1;
          }
        });
        activationSession.retain(keep);
        (waiting || []).forEach((experiment) => {
          if (api.activationDelays(experiment)) {
            activationSession.arm(experiment, {
              document: document,
              href: href || window.location.href,
              currentHref: function () { return window.location.href; },
              onExpose: function () {
                if (!hasTrackingConsent()) return;
                applyMatchingExperiments({
                  experiments: [experiment],
                  href: window.location.href,
                  document: document,
                  visitorId: visitorId,
                  qaOn: qaOn,
                  applied: appliedOnPage,
                  enrolledThisView: enrolled,
                });
              },
            });
            return;
          }
          api.exposeWhenReady(experiment, {
            document: document,
            onExpose: function () {
              if (!hasTrackingConsent()) return;
              if (stayOnPage && pageViewKey(window.location.href) !== pageKey) return;
              applyMatchingExperiments({
                experiments: [experiment],
                href: window.location.href,
                document: document,
                visitorId: visitorId,
                qaOn: qaOn,
                applied: appliedOnPage,
                enrolledThisView: enrolled,
              });
            },
          }).catch((err) => {
            console.warn('[ab] element wait failed:', err);
          });
        });
      }

      const first = applyMatchingExperiments({
        experiments: data.experiments || [],
        href: window.location.href,
        document: document,
        visitorId: visitorId,
        qaOn: qaOn,
        applied: appliedOnPage,
        enrolledThisView: enrolledThisView,
      });
      watchWaiting(first.waiting, window.location.href, enrolledThisView, false);
      if (data && data.datalayer_events === true) watchDataLayer(window, noteCustomEvent);

      watchAnalyticsConsent(window, reportGa4FromConsent);

      function refreshAfterNavigation(href) {
        const nextMode = modeFromHref(href);
        // An edit or preview address is a full-load handoff. A client-side
        // change into one of those must not enrol or send a view.
        if (nextMode.type === 'edit' || nextMode.type === 'preview') return;
        const token = navigationGate.start();
        fetch(publicExperimentsUrl(href, fetchAsTest))
          .then(function (res) { return res.json(); })
          .then(function (next) {
            if (!navigationGate.current(token, href, window.location.href)) return;
            if (!hasTrackingConsent()) return;
            rememberPublicGa4(next);
            watchAnalyticsConsent(window, reportGa4FromConsent);
            if (next && next.datalayer_events === true) watchDataLayer(window, noteCustomEvent);
            const delivered = deliverNavigation({
              experiments: (next && next.experiments) || [],
              href: href,
              document: document,
              visitorId: visitorId,
              qaOn: qaOn,
              applied: appliedOnPage,
              reportOne: function (experiment, pageHref) {
                reportExperienceImpressions([experiment], pageHref);
              },
              reportAll: function (experiments, pageHref) {
                reportExperienceImpressions(experiments, pageHref);
              },
            });
            watchWaiting(delivered.waiting, href, delivered.enrolledThisView, true);
            checkUrlGoals(visitorId, delivered.enrolledThisView, href);
          })
          .catch(function () { /* a later address change can still report */ });
      }

      if (spaRecheckAllowed(mode, scriptTag)) {
        startSpaRecheck(window, {
          mode: mode,
          script: scriptTag,
          applied: appliedOnPage,
          initialHref: window.location.href,
          onNavigate: refreshAfterNavigation,
        });
      } else {
        // data-spa="off": tests and URL goals stay on the full load. GA4
        // still follows the address, once per address, as before.
        bindSpaRouteChanges(window, function () {
          const href = window.location.href;
          const token = navigationGate.start();
          fetch(publicExperimentsUrl(href, fetchAsTest))
            .then(function (res) { return res.json(); })
            .then(function (next) {
              if (!navigationGate.current(token, href, window.location.href)) return;
              if (!hasTrackingConsent()) return;
              rememberPublicGa4(next);
              watchAnalyticsConsent(window, reportGa4FromConsent);
              if (next && next.datalayer_events === true) watchDataLayer(window, noteCustomEvent);
              reportExperienceImpressions((next && next.experiments) || [], href);
            })
            .catch(function () { /* a later address change can still report */ });
        });
      }

      // Reveal now. Experiments whose element is already there are applied.
      // A missing element does not hold the page blank: a site-wide URL rule
      // would otherwise hide every page that will never have the button.
      // The observer still applies the variant if the element appears in time.
      revealPage();

      // Check "visited a URL" goals on every page load — including pages with no
      // on-page experiment at all, e.g. a /thank-you confirmation page. A
      // single-page app checks again from refreshAfterNavigation.
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
  function elementStorageKey(visitorId, experimentId, goalId) {
    return '_ab_element_' + visitorId + '_' + experimentId + '_' + goalId;
  }
  function claimOnce(storage, key, memory) {
    if (!memory || !key) return false;
    if (memory[key]) return false;
    try {
      if (storage && storage.getItem && storage.getItem(key)) {
        memory[key] = 1;
        return false;
      }
    } catch (e) { /* private mode or a blocked store — fall through to memory */ }
    memory[key] = 1;
    try {
      if (storage && storage.setItem) storage.setItem(key, '1');
    } catch (e) { /* the memory flag above is the fallback */ }
    return true;
  }
  function claimClick(storage, visitorId, experimentId, goalId, memory) {
    return claimOnce(storage, clickStorageKey(visitorId, experimentId, goalId), memory || clickSeen);
  }
  function claimElement(storage, visitorId, experimentId, goalId, memory) {
    return claimOnce(storage, elementStorageKey(visitorId, experimentId, goalId), memory || elementSeen);
  }
  function customStorageKey(visitorId, experimentId, goalId) {
    return '_ab_custom_' + visitorId + '_' + experimentId + '_' + goalId;
  }
  function claimCustom(storage, visitorId, experimentId, goalId, memory) {
    return claimOnce(storage, customStorageKey(visitorId, experimentId, goalId), memory || customSeen);
  }

  // Keep this pattern in step with src/goals.js. experience_impression is
  // the Send to GA4 event and is never a custom goal. The limits live in
  // the function so a test that returns before this line still has them.
  function normaliseCustomEventName(value) {
    const max = 64;
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
    if (typeof value !== 'string') return '';
    const name = value.trim();
    if (!name || name.length > max) return '';
    if (name === 'experience_impression') return '';
    if (!pattern.test(name)) return '';
    return name;
  }
  function isQueueList(item) {
    if (Array.isArray(item)) return true;
    if (!item || typeof item !== 'object') return false;
    if (typeof item.length !== 'number') return false;
    return Object.prototype.toString.call(item) === '[object Arguments]';
  }
  function eventNameFromQueueItem(item) {
    if (typeof item === 'string') return normaliseCustomEventName(item);
    if (!item || typeof item !== 'object') return '';
    if (isQueueList(item)) {
      if (item[0] === 'activate') return '';
      if (item[0] === 'track') return typeof item[1] === 'string' ? normaliseCustomEventName(item[1]) : '';
      if (typeof item[0] === 'string') return normaliseCustomEventName(item[0]);
      return '';
    }
    if (typeof item.event === 'string') return normaliseCustomEventName(item.event);
    return '';
  }
  // A plain object of properties. Arrays and argument lists are not props.
  function plainCustomProps(value) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return null;
    if (Object.prototype.toString.call(value) === '[object Arguments]') return null;
    return value;
  }
  function activationKeyFromQueueItem(item) {
    if (!isQueueList(item) || item[0] !== 'activate') return '';
    return typeof item[1] === 'string' ? item[1].trim() : '';
  }
  function propsFromQueueItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (isQueueList(item)) {
      if (item[0] === 'track') return plainCustomProps(item[2]);
      return plainCustomProps(item[1]);
    }
    return plainCustomProps(item);
  }
  // Keep in step with src/goals.js. null means the conditions are not usable,
  // so the goal must not convert. An empty list means the event name is enough.
  function customWhenFromGoal(when) {
    if (when == null) return [];
    if (!Array.isArray(when)) return null;
    const keyPattern = /^[A-Za-z0-9_.-]{1,64}$/;
    const out = [];
    for (let i = 0; i < when.length; i++) {
      const item = when[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const key = typeof item.key === 'string' ? item.key.trim() : '';
      let value = '';
      if (typeof item.value === 'string') value = item.value.trim();
      else if (typeof item.value === 'number' && isFinite(item.value)) value = String(item.value);
      else if (typeof item.value === 'boolean') value = item.value ? 'true' : 'false';
      else return null;
      if (!key && !value) continue;
      if (!key || !value) return null;
      if (key.length > 64 || !keyPattern.test(key)) return null;
      if (value.length > 100) return null;
      out.push({ key: key, value: value });
    }
    return out;
  }
  function customValueEquals(actual, expected) {
    if (typeof actual === 'string' || typeof actual === 'boolean') {
      return String(actual).trim() === String(expected).trim();
    }
    if (typeof actual === 'number' && isFinite(actual)) {
      return String(actual).trim() === String(expected).trim();
    }
    return false;
  }
  function customPropertiesMatch(when, props) {
    const conditions = customWhenFromGoal(when);
    if (conditions === null) return false;
    if (!conditions.length) return true;
    const source = plainCustomProps(props);
    if (!source) return false;
    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];
      if (!Object.prototype.hasOwnProperty.call(source, condition.key)) return false;
      if (!customValueEquals(source[condition.key], condition.value)) return false;
    }
    return true;
  }
  function dataLayerEntryEventName(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
    if (Object.prototype.toString.call(entry) === '[object Arguments]') return '';
    if (typeof entry.event !== 'string') return '';
    return normaliseCustomEventName(entry.event);
  }
  function customGoalsFrom(goals, context) {
    const ctx = context || {};
    const list = goals || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const goal = list[i] || {};
      if (goal.type !== 'custom') continue;
      const eventName = normaliseCustomEventName(goal.event);
      if (!eventName) continue;
      const when = customWhenFromGoal(goal.when);
      if (when === null) continue;
      out.push({
        experimentId: ctx.experimentId,
        variantId: ctx.variantId,
        visitorId: ctx.visitorId,
        goalId: goal.id || eventName,
        event: eventName,
        when: when,
      });
    }
    return out;
  }
  function customGoalsFromExperiments(experiments, assignments, visitorId) {
    const assigned = assignments || {};
    const out = [];
    (experiments || []).forEach(function (experiment) {
      if (!experiment) return;
      const variantId = assigned[experiment.id];
      const variant = (experiment.variants || []).find(function (item) { return item.id === variantId; });
      if (!variant) return;
      const list = customGoalsFrom(goalsFor(experiment, variant), {
        experimentId: experiment.id,
        variantId: variantId,
        visitorId: visitorId,
      });
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    });
    return out;
  }
  function customTrackingAllowed(mode) {
    if (mode && (mode.type === 'edit' || mode.type === 'preview')) return false;
    return true;
  }
  function installPivitTracker(win, onTrack) {
    if (!win) return null;
    const previous = win.pivit;
    if (previous && previous.__pivitTracker === true) return previous;
    if (typeof previous === 'function') return previous;
    const queued = Array.isArray(previous) ? previous.slice() : [];
    function track(name, props) {
      if (typeof onTrack === 'function') onTrack(name, props);
    }
    function activate(key) {
      try { rememberManualActivation(key); }
      catch (err) { /* a queued call must not break the page */ }
    }
    function replay() {
      for (let i = 0; i < queued.length; i++) {
        const key = activationKeyFromQueueItem(queued[i]);
        if (key) {
          activate(key);
          continue;
        }
        const name = eventNameFromQueueItem(queued[i]);
        if (name) track(name, propsFromQueueItem(queued[i]));
      }
    }
    function addActivate(target) {
      const prior = target.activate;
      if (typeof prior === 'function') {
        target.activate = function (key) {
          const result = prior.apply(target, arguments);
          activate(key);
          return result;
        };
      } else {
        target.activate = function (key) { activate(key); };
      }
    }
    if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const priorTrack = previous.track;
      if (typeof priorTrack === 'function') {
        previous.track = function (name, props) {
          const result = priorTrack.apply(previous, arguments);
          track(name, props);
          return result;
        };
      } else {
        previous.track = function (name, props) { track(name, props); };
      }
      addActivate(previous);
      previous.__pivitTracker = true;
      replay();
      return previous;
    }
    const tracker = { track: track, activate: activate, __pivitTracker: true };
    try {
      win.pivit = tracker;
    } catch (err) {
      return null;
    }
    replay();
    return tracker;
  }
  function hookDataLayer(win, onEvent) {
    if (!win || !Array.isArray(win.dataLayer)) return { hooked: false, scanned: 0 };
    return hookDataLayerValue(win.dataLayer, onEvent);
  }
  function hookDataLayerValue(layer, onEvent) {
    if (!Array.isArray(layer)) return { hooked: false, scanned: 0 };
    if (layer.__pivitCustomEvents === true) return { hooked: true, scanned: 0 };
    let scanned = 0;
    for (let i = 0; i < layer.length; i++) {
      const name = dataLayerEntryEventName(layer[i]);
      if (!name) continue;
      scanned += 1;
      try { if (typeof onEvent === 'function') onEvent(name, layer[i]); } catch (err) { /* the entry stays on dataLayer */ }
    }
    const original = typeof layer.push === 'function' ? layer.push : Array.prototype.push;
    function wrapped() {
      const result = original.apply(layer, arguments);
      try {
        for (let i = 0; i < arguments.length; i++) {
          const name = dataLayerEntryEventName(arguments[i]);
          if (name && typeof onEvent === 'function') onEvent(name, arguments[i]);
        }
      } catch (err) { /* the push already landed */ }
      return result;
    }
    wrapped.__pivitCustomEvents = true;
    if (original && original.__pivitGa4Watch) wrapped.__pivitGa4Watch = true;
    try {
      layer.push = wrapped;
      layer.__pivitCustomEvents = true;
    } catch (err) {
      return { hooked: false, scanned: scanned };
    }
    return { hooked: true, scanned: scanned };
  }
  function watchDataLayer(win, onEvent) {
    if (!win) return { hooked: false, scanned: 0 };
    if (win.__pivitDataLayerWatch === true) return hookDataLayer(win, onEvent);
    let current = win.dataLayer;
    let scanned = 0;
    function attach(value) {
      current = value;
      const result = hookDataLayerValue(value, onEvent);
      scanned += result.scanned || 0;
      return result;
    }
    if (Array.isArray(current)) attach(current);
    let defined = false;
    try {
      Object.defineProperty(win, 'dataLayer', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (value) { attach(value); },
      });
      defined = true;
    } catch (err) {
      defined = false;
    }
    try { win.__pivitDataLayerWatch = true; } catch (err) { /* a sealed window still has the push hook */ }
    const hooked = defined || (Array.isArray(current) && current.__pivitCustomEvents === true);
    return { hooked: hooked, scanned: scanned };
  }

  // Goals saved before types existed have no "type" and are always click.
  // URL goals are handled by checkUrlGoals, not by this listener.
  function clickGoalsFrom(goals, context) {
    const ctx = context || {};
    const list = goals || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const goal = list[i] || {};
      const type = goal.type || 'click';
      if (type !== 'click' || typeof goal.selector !== 'string' || !goal.selector) continue;
      out.push({
        experimentId: ctx.experimentId,
        variantId: ctx.variantId,
        visitorId: ctx.visitorId,
        goalId: goal.id || goal.selector,
        selector: goal.selector,
      });
    }
    return out;
  }

  // type must be element. A goal saved before types existed is a click, and
  // a click goal is left to the document listener.
  function elementGoalsFrom(goals, context) {
    const ctx = context || {};
    const list = goals || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const goal = list[i] || {};
      if (goal.type !== 'element' || typeof goal.selector !== 'string') continue;
      const selector = goal.selector.trim();
      if (!selector) continue;
      out.push({
        experimentId: ctx.experimentId,
        variantId: ctx.variantId,
        visitorId: ctx.visitorId,
        goalId: goal.id || selector,
        selector: selector,
      });
    }
    return out;
  }

  // The innermost element that matches. composedPath sees through a shadow
  // root, where event.target is retargeted to the host. An invalid selector
  // matches nothing and does not throw into the page.
  function nodesForClick(event) {
    if (!event) return [];
    if (typeof event.composedPath === 'function') {
      try {
        const path = event.composedPath();
        if (path && path.length) return path;
      } catch (err) { /* fall through to the target chain */ }
    }
    const nodes = [];
    let current = null;
    if (event.target !== undefined && event.nodeType == null) current = event.target;
    else current = event;
    if (current && current.nodeType === 3) current = current.parentElement || null;
    while (current) {
      nodes.push(current);
      if (current.nodeType === 9) break;
      current = current.parentElement || null;
    }
    return nodes;
  }
  function clickGoalElement(event, selector) {
    if (typeof selector !== 'string' || !selector) return null;
    const nodes = nodesForClick(event);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || node.nodeType !== 1 || typeof node.matches !== 'function') continue;
      try {
        if (node.matches(selector)) return node;
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  // One capture listener. track() can be called again as further experiments
  // enrol; it does not add a second listener. The click is never cancelled.
  function createClickTracker(doc, hooks) {
    const goals = [];
    let listening = false;
    const claim = hooks && hooks.claim;
    const send = hooks && hooks.send;
    function onClick(event) {
      for (let i = 0; i < goals.length; i++) {
        const goal = goals[i];
        if (!clickGoalElement(event, goal.selector)) continue;
        if (!claim(goal, event)) continue;
        send(goal, event);
      }
    }
    return {
      track: function (list) {
        const adding = list || [];
        for (let i = 0; i < adding.length; i++) {
          const goal = adding[i];
          if (!goal || typeof goal.selector !== 'string' || !goal.selector) continue;
          goals.push(goal);
        }
        if (listening) return;
        if (!doc || typeof doc.addEventListener !== 'function') return;
        if (!goals.length) return;
        listening = true;
        doc.addEventListener('click', onClick, true);
      },
    };
  }

  // One observer for every element goal on this document. An initial
  // querySelector covers an element that is already there. Later renders,
  // including a step swap that does not change the address, notify the
  // observer. Each goal is removed when it is found or its selector cannot
  // be queried. The observer disconnects when none are left. A later test
  // that enrols on this document starts a fresh observer.
  function createElementWatcher(doc, hooks) {
    const goals = [];
    const claim = hooks && hooks.claim;
    const send = hooks && hooks.send;
    const Observer = (hooks && hooks.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    let observer = null;
    let looking = false;

    function disconnect() {
      if (!observer) return;
      try { observer.disconnect(); } catch (err) { /* already gone */ }
      observer = null;
    }

    function drop(goal) {
      const index = goals.indexOf(goal);
      if (index !== -1) goals.splice(index, 1);
      if (!goals.length) disconnect();
    }

    function sameGoal(left, right) {
      return left.visitorId === right.visitorId
        && left.experimentId === right.experimentId
        && left.goalId === right.goalId
        && left.selector === right.selector;
    }

    function look() {
      if (looking) return;
      looking = true;
      try {
        const pending = goals.slice();
        for (let i = 0; i < pending.length; i++) {
          const goal = pending[i];
          if (goals.indexOf(goal) === -1) continue;
          const query = elementQuery(doc, goal.selector);
          if (query.state === 'invalid') {
            drop(goal);
            continue;
          }
          if (query.state !== 'present') continue;
          drop(goal);
          let claimed = false;
          try { claimed = typeof claim === 'function' && claim(goal); }
          catch (err) { claimed = false; }
          if (!claimed || typeof send !== 'function') continue;
          try { send(goal); }
          catch (err) { /* the claim is already stored, so this is not retried */ }
        }
      } finally {
        looking = false;
      }
    }

    function ensureObserver() {
      if (observer || !goals.length || !Observer || !doc) return;
      try {
        observer = new Observer(function () { look(); });
        const target = doc.documentElement || doc.body || doc;
        if (!target || typeof observer.observe !== 'function') {
          observer = null;
          return;
        }
        observer.observe(target, { childList: true, subtree: true });
      } catch (err) {
        observer = null;
      }
    }

    return {
      watch: function (list) {
        const adding = list || [];
        for (let i = 0; i < adding.length; i++) {
          const goal = adding[i];
          if (!goal || typeof goal.selector !== 'string' || !goal.selector) continue;
          let seen = false;
          for (let j = 0; j < goals.length; j++) {
            if (sameGoal(goals[j], goal)) { seen = true; break; }
          }
          if (!seen) goals.push(goal);
        }
        look();
        if (!goals.length) return;
        ensureObserver();
        look();
      },
      disconnect: disconnect,
    };
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

  function gtmContainerKey(name) {
    return String(name || '').indexOf('GTM-') === 0;
  }

  function gtmScriptSrc(src) {
    const value = String(src || '');
    return value.indexOf('gtm.js') !== -1 && value.indexOf('id=GTM-') !== -1;
  }

  function gtmNoscriptSrc(src) {
    const value = String(src || '');
    return value.indexOf('ns.html') !== -1 && value.indexOf('id=GTM-') !== -1;
  }

  function gtmInline(text) {
    const value = String(text || '');
    return value.indexOf('gtm.js') !== -1 && value.indexOf('GTM-') !== -1;
  }

  function nodeSrc(node) {
    if (!node) return '';
    if (node.src) return String(node.src);
    if (typeof node.getAttribute === 'function') {
      const attr = node.getAttribute('src');
      if (attr) return String(attr);
    }
    return '';
  }

  // Tag Manager is a GTM- container, the gtm.js snippet, or the noscript
  // iframe. A gtag.js tag uses a G- id and is not Tag Manager.
  function gtmOnPage(win) {
    if (!win) return false;
    try {
      const manager = win.google_tag_manager;
      if (manager && typeof manager === 'object') {
        const keys = Object.keys(manager);
        for (let i = 0; i < keys.length; i++) {
          if (gtmContainerKey(keys[i])) return true;
        }
      }
      const doc = win.document;
      if (!doc || typeof doc.getElementsByTagName !== 'function') return false;
      const scripts = doc.getElementsByTagName('script');
      for (let i = 0; scripts && i < scripts.length; i++) {
        const node = scripts[i];
        const src = nodeSrc(node);
        if (gtmScriptSrc(src)) return true;
        if (!src && gtmInline(node && (node.text || node.textContent))) return true;
      }
      const frames = doc.getElementsByTagName('iframe');
      for (let i = 0; frames && i < frames.length; i++) {
        if (gtmNoscriptSrc(nodeSrc(frames[i]))) return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  // Tag Manager gets a plain dataLayer object. gtag('event', name, params)
  // pushes an arguments list, so Data Layer Variables cannot read the fields.
  // gtag.js with no Tag Manager still uses gtag. Never both, and never
  // creates gtag or dataLayer.
  function ga4Transport(win) {
    if (!win) return null;
    if (gtmOnPage(win)) return Array.isArray(win.dataLayer) ? 'dataLayer' : null;
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

  // Missing, empty, or anything other than "off" keeps the address check on.
  function spaNavigationEnabled(script) {
    if (!script || typeof script.getAttribute !== 'function') return true;
    const raw = script.getAttribute('data-spa');
    if (raw == null) return true;
    return String(raw).trim().toLowerCase() !== 'off';
  }

  // Edit and preview are a full-load handoff. They do not enrol on a later
  // address change. data-spa="off" keeps tests and URL goals on the full load.
  function spaRecheckAllowed(mode, script) {
    if (mode && (mode.type === 'edit' || mode.type === 'preview')) return false;
    return spaNavigationEnabled(script);
  }

  // apiBase and siteKey are filled in by tests. A page call leaves them out
  // and uses the snippet tag's own API origin and site key.
  function publicExperimentsUrl(href, testTraffic, apiBase, siteKey) {
    const base = arguments.length >= 3 ? apiBase : API_BASE;
    const site = arguments.length >= 4 ? siteKey : SITE_KEY;
    const page = encodeURIComponent(href == null ? '' : String(href));
    return api.withQaQuery(api.withSite(`${base}/api/experiments?url=${page}`, site), !!testTraffic);
  }

  // Drops a response when a newer address change has already started, or
  // when the visitor has moved on from the address that was requested.
  function createNavigationGate() {
    let ticket = 0;
    return {
      start: function () {
        ticket += 1;
        return ticket;
      },
      current: function (token, href, currentHref) {
        if (token !== ticket) return false;
        return pageViewKey(href) === pageViewKey(currentHref);
      },
    };
  }

  function createRouteSession(options) {
    const opts = options || {};
    const applied = opts.applied || Object.create(null);
    const debounceMs = opts.debounceMs == null ? SPA_DEBOUNCE_MS : opts.debounceMs;
    const setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
    let handledKey = opts.initialKey == null ? '' : String(opts.initialKey);
    let timer = null;
    let generation = 0;

    function schedule() {
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      const generationAtSchedule = ++generation;
      timer = setTimer(function () {
        timer = null;
        if (generationAtSchedule !== generation) return;
        let href = '';
        try {
          href = typeof opts.currentHref === 'function' ? opts.currentHref() : '';
        } catch (err) {
          return;
        }
        const pageKey = pageViewKey(href);
        if (!pageKey || pageKey === handledKey) return;
        handledKey = pageKey;
        if (typeof opts.onChange !== 'function') return;
        try { opts.onChange(href, pageKey); }
        catch (err) { /* a later address change can still run */ }
      }, debounceMs);
    }

    return { applied: applied, schedule: schedule };
  }

  function startSpaRecheck(win, hooks) {
    const h = hooks || {};
    if (!spaRecheckAllowed(h.mode, h.script)) return { enabled: false, session: null };
    if (!win || !win.history) return { enabled: false, session: null };
    const initialHref = h.initialHref || (win.location && win.location.href) || '';
    const session = createRouteSession({
      applied: h.applied,
      debounceMs: h.debounceMs,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      initialKey: pageViewKey(initialHref),
      currentHref: function () { return win.location && win.location.href; },
      onChange: h.onNavigate,
    });
    const bound = bindSpaRouteChanges(win, function () { session.schedule(); });
    if (!bound) return { enabled: false, session: session };
    return { enabled: true, session: session };
  }

  // Enrols tests that are not already applied on this document. A second call
  // with the same experiment sends no view, applies nothing, and does not
  // wire the click goal again. Page JavaScript stays on the document mark
  // inside the applier, so it cannot run a second time either.
  function applyMatchingExperiments(input) {
    const opts = input || {};
    const experiments = opts.experiments || [];
    const applied = opts.applied || Object.create(null);
    const enrolledThisView = opts.enrolledThisView || Object.create(null);
    const doc = opts.document;
    const storage = opts.storage;
    const visitorId = opts.visitorId;
    const qa = !!opts.qaOn;
    const href = opts.href || '';
    const waiting = [];
    const views = [];

    function storedAssignment(experimentId) {
      if (!storage || typeof storage.getItem !== 'function') {
        try {
          return typeof localStorage !== 'undefined'
            ? localStorage.getItem(ASSIGNMENT_PREFIX + experimentId)
            : null;
        } catch (err) {
          return null;
        }
      }
      try { return storage.getItem(ASSIGNMENT_PREFIX + experimentId); }
      catch (err) { return null; }
    }

    function enrolOne(experiment) {
      if (!experiment || experiment.id == null || experiment.id === '') return { reason: 'missing' };
      if (applied[experiment.id]) return { reason: 'already' };
      if (!mayBucketExperiment(experiment, visitorId, qa)) return { reason: 'demo' };
      if (!experiment.variants || experiment.variants.length === 0) return { reason: 'no-variants' };
      const selector = elementSelectorOf(experiment);
      const query = activationDelays(experiment)
        ? activationQuery(doc, experiment)
        : elementQuery(doc, selector);
      if (query.state === 'invalid') return { reason: 'invalid' };
      if (query.state === 'missing') return { reason: 'waiting' };
      const stored = storedAssignment(experiment.id);
      const variant = pickVariant(experiment, visitorId, storage);
      if (!variant) return { reason: 'no-variant' };
      applied[experiment.id] = 1;
      if (!stored) enrolledThisView[experiment.id] = 1;
      let outcome = null;
      if (typeof opts.apply === 'function') outcome = opts.apply(variant, experiment);
      else outcome = applyVariantChanges(variant);
      const changeApplied = outcome && (outcome.ok === true || outcome.ok === false) ? outcome.ok : undefined;
      const goalList = goalsFor(experiment, variant);
      if (typeof opts.send === 'function') opts.send(experiment.id, variant.id, visitorId, 'view', null, changeApplied);
      else sendEvent(experiment.id, variant.id, visitorId, 'view', null, changeApplied);
      views.push(experiment.id);
      if (typeof opts.wire === 'function') opts.wire(experiment.id, variant.id, visitorId, goalList);
      else wireConversionTracking(experiment.id, variant.id, visitorId, goalList);
      if (typeof opts.report === 'function') opts.report(experiment, href);
      else reportExperienceImpressions([experiment], href);
      return { reason: 'applied', variant: variant };
    }

    experiments.forEach(function (experiment) {
      const result = enrolOne(experiment);
      if (result && result.reason === 'waiting') waiting.push(experiment);
    });
    return { waiting: waiting, views: views, applied: applied, enrolledThisView: enrolledThisView };
  }

  // One pass for a new address: apply what is new, then report impressions
  // for every test that matches this address. The second report is how an
  // already-applied test tells GA4 about the new address. Dedupe keeps the
  // test that was just applied from being sent twice.
  function deliverNavigation(input) {
    const opts = input || {};
    const enrolledThisView = opts.enrolledThisView || Object.create(null);
    const appliedResult = applyMatchingExperiments({
      experiments: opts.experiments,
      href: opts.href,
      document: opts.document,
      storage: opts.storage,
      visitorId: opts.visitorId,
      qaOn: opts.qaOn,
      applied: opts.applied,
      enrolledThisView: enrolledThisView,
      apply: opts.apply,
      send: opts.send,
      wire: opts.wire,
      report: opts.reportOne,
    });
    if (typeof opts.reportAll === 'function') opts.reportAll(opts.experiments || [], opts.href);
    return {
      applied: appliedResult,
      enrolledThisView: enrolledThisView,
      waiting: appliedResult.waiting,
      views: appliedResult.views,
    };
  }

  // Keep the editor's ab_edit and token on whatever address a single-page
  // app passes to pushState or replaceState. A missing URL argument is left
  // alone. A different origin is left alone: pushState cannot go there, and
  // the token must not be copied onto it. The hash and the site's own query
  // parameters stay.
  function urlWithEditParams(nextUrl, currentHref, variantId, token) {
    if (!variantId || !token || nextUrl == null) return nextUrl;
    let current;
    try { current = new URL(String(currentHref || ''), 'https://pivitlab.invalid'); }
    catch (err) { return nextUrl; }
    let raw = nextUrl;
    if (typeof nextUrl === 'object') {
      raw = typeof nextUrl.href === 'string' ? nextUrl.href : String(nextUrl);
    }
    let target;
    try { target = new URL(String(raw), current.href); }
    catch (err) { return nextUrl; }
    if (target.origin !== current.origin) return nextUrl;
    target.searchParams.set('ab_edit', String(variantId));
    target.searchParams.set('token', String(token));
    return target.pathname + target.search + target.hash;
  }

  function bindEditHistory(win, variantId, token) {
    if (!win || !variantId || !token || !win.history) return false;
    if (win.__pivitEditHistory) return true;
    function wrap(name) {
      const original = win.history[name];
      if (typeof original !== 'function' || original.__pivitEditHistory) return;
      function wrapped(state, title, url) {
        if (arguments.length < 3 || url == null) return original.call(win.history, state, title);
        const next = urlWithEditParams(url, win.location && win.location.href, variantId, token);
        return original.call(win.history, state, title, next);
      }
      wrapped.__pivitEditHistory = true;
      try { win.history[name] = wrapped; }
      catch (err) { /* the browser's own history stays as it was */ }
    }
    wrap('pushState');
    wrap('replaceState');
    try { win.__pivitEditHistory = { variantId: String(variantId), token: String(token) }; }
    catch (err) { /* the wrappers are still in place for this document */ }
    return true;
  }

  function stepsNoteLabel(note) {
    const text = String(note == null ? '' : note).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return 'Steps: ' + text;
  }

  function mountStepsNote(doc, note) {
    const label = stepsNoteLabel(note);
    if (!doc || typeof doc.createElement !== 'function' || !label) return null;
    let el = typeof doc.getElementById === 'function' ? doc.getElementById('pivit-steps-note') : null;
    if (!el) {
      el = doc.createElement('div');
      if (el.setAttribute) {
        el.setAttribute('id', 'pivit-steps-note');
        el.setAttribute('role', 'note');
      } else {
        el.id = 'pivit-steps-note';
      }
      if (el.style) {
        el.style.position = 'fixed';
        el.style.top = '0';
        el.style.left = '0';
        el.style.right = '0';
        el.style.zIndex = '2147483646';
        el.style.background = '#f4f1ff';
        el.style.color = '#131723';
        el.style.padding = '10px 16px';
        el.style.font = '14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif';
        el.style.boxShadow = '0 2px 8px rgba(19,23,35,0.12)';
      }
      const parent = doc.body || doc.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') return null;
      parent.appendChild(el);
    }
    el.textContent = label;
    return el;
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
