/**
 * AB Platform snippet — v0.6
 *
 * Usage on client site:
 *   <script src="https://your-api.example.com/snippet/ab.js"
 *           data-api="https://your-api.example.com"></script>
 *
 * Fetches active experiments for the current page, assigns the visitor
 * to a variant per experiment (sticky via localStorage), applies DOM
 * changes, and reports view/click events back to the API.
 *
 * Preview mode: the dashboard opens ?ab_preview=<variant_id>&ab_preview_token=<token>.
 * The token is signed and expires. It can show a draft, paused or disabled
 * variant and never logs a view or conversion. A preview link without a valid
 * token is ignored, so drafts are not served to anyone who guesses the URL.
 * If the URL still has an older ab_edit or ab_preview (a leftover from the
 * previous test), the last one wins, and preview applies only that experiment.
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
 * Selectors and applying changes live on PivitRuntime (also exported for tests).
 * The visual editor uses the same helpers, so a selector saved from the editor
 * is what visitors get. Positional selectors (nth-child / nth-of-type and the
 * other structural pseudos) are applied once, inline, exactly as before.
 */
(function (root) {
  const api = buildPivitRuntime();
  const clickSeen = Object.create(null);
  api.matchUrlGoal = matchUrlGoal;
  api.isSafeRegex = isSafeRegex;
  api.claimClick = claimClick;
  api.clickStorageKey = clickStorageKey;
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
  const VISITOR_KEY = '_ab_visitor_id';
  const ASSIGNMENT_PREFIX = '_ab_assign_';
  // Bump when editor.js changes so a cached copy cannot keep the old variant.
  const EDITOR_VERSION = '20261007';

  // The first query value is the leftover. The last ab_edit or ab_preview is
  // the link the owner just opened.
  function lastQuery(params, name) {
    const values = params.getAll(name).filter((value) => value);
    return values.length ? values[values.length - 1] : null;
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

  // Deterministic-ish hash so the same visitor could be re-derived if storage is cleared
  // mid-session; combined with localStorage stickiness for the common case.
  function pickVariant(experiment, visitorId) {
    const stored = localStorage.getItem(ASSIGNMENT_PREFIX + experiment.id);
    if (stored) {
      const match = experiment.variants.find((v) => v.id === stored);
      if (match) return match;
    }

    const totalWeight = experiment.variants.reduce((sum, v) => sum + (v.traffic_split || 0), 0) || 100;
    let hash = 0;
    const str = visitorId + experiment.id;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    const roll = hash % totalWeight;

    let cumulative = 0;
    let chosen = experiment.variants[0];
    for (const v of experiment.variants) {
      cumulative += v.traffic_split || 0;
      if (roll < cumulative) { chosen = v; break; }
    }

    localStorage.setItem(ASSIGNMENT_PREFIX + experiment.id, chosen.id);
    return chosen;
  }

  // One applier for the page so every variant shares a single observer.
  // Style and hide on a non-positional selector become a <style> rule (current
  // and later matches, no per-element write). Text, HTML, attributes and the
  // structural types are applied to matches now and to elements added later.
  let pageApplier = null;
  function applyVariantChanges(variant) {
    if (!variant) return;
    if (!pageApplier) pageApplier = api.createApplier(document);
    pageApplier.applyAll(variant.changes || [], variant.id || 'variant');
  }

  function sendEvent(experimentId, variantId, visitorId, eventType, goalId) {
    const body = JSON.stringify({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: visitorId,
      event_type: eventType,
      goal_id: goalId || null,
    });
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

  // "Visited a URL" goals can't be wired up as a click listener on the page the
  // experiment runs on, because the goal page (e.g. /thank-you) is often a
  // completely different page. Instead, on every page load, check every experiment
  // this visitor has ever been assigned to (found via localStorage) against the
  // current URL, and fire a conversion once per goal if it matches.
  async function checkUrlGoals(visitorId) {
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
      const res = await fetch(`${API_BASE}/api/experiments/by-ids?ids=${experimentIds.join(',')}`);
      const data = await res.json();

      (data.experiments || []).forEach((experiment) => {
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

  async function init() {
    const mode = pageMode();

    // Edit mode: ?ab_edit=<variant_id>&token=<token> hands off entirely to a
    // separate editor script, loaded only now (not for every real visitor) —
    // keeps this production snippet lean. No tracking/preview logic runs below
    // this point for an edit-mode page load, so an editing session never sends
    // a stray view event into real results. A later ab_preview in the same URL
    // is preview mode instead — the newest link wins.
    if (mode.type === 'edit' && mode.variantId) {
      const previous = document.querySelectorAll('script[data-pivit-editor]');
      for (let i = 0; i < previous.length; i++) previous[i].remove();
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

    if (!wantsPreview && !hasTrackingConsent()) {
      // No consent yet (and this isn't a preview) — don't write to localStorage,
      // don't fetch experiments, don't apply changes, don't send anything. The
      // visitor just sees the page exactly as if this snippet weren't there.
      revealPage();
      return;
    }

    const url = encodeURIComponent(window.location.href);
    const previewQuery = wantsPreview
      ? `&preview=1&preview_variant=${encodeURIComponent(mode.variantId)}&preview_token=${encodeURIComponent(mode.token)}`
      : '';

    try {
      const res = await fetch(
        `${API_BASE}/api/experiments?url=${url}${previewQuery}`,
        wantsPreview ? { cache: 'no-store' } : undefined
      );
      const data = await res.json();

      // Authorised preview: show only that experiment's variant. Do not assign
      // a visitor, do not write localStorage, and do not log any event. A
      // preview URL whose token was rejected shows the page unchanged — never
      // another experiment that happens to match the same host.
      if (wantsPreview) {
        const match = data.preview && data.preview.variant_id === mode.variantId
          ? previewVariant(data.experiments, data.preview)
          : null;
        if (match) {
          applyVariantChanges(match.variant);
          console.info(`[ab] preview mode — showing variant "${match.variant.name}" for experiment "${match.experiment.name}". No events are being logged.`);
        }
        revealPage();
        return;
      }

      if (!hasTrackingConsent()) {
        revealPage();
        return;
      }

      const visitorId = getVisitorId();
      (data.experiments || []).forEach((experiment) => {
        if (!experiment.variants || experiment.variants.length === 0) return;
        const variant = pickVariant(experiment, visitorId);
        applyVariantChanges(variant);
        sendEvent(experiment.id, variant.id, visitorId, 'view');
        wireConversionTracking(experiment.id, variant.id, visitorId, goalsFor(experiment, variant));
      });

      // Reveal now — DOM changes are applied, so this is the earliest safe moment.
      // Everything after this (goal-checking) doesn't affect what's visible.
      revealPage();

      // Check "visited a URL" goals on every page load — including pages with no
      // on-page experiment at all, e.g. a /thank-you confirmation page.
      await checkUrlGoals(visitorId);
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
        return;
      }
      list.forEach((el) => applyToElement(el, change, key, track));
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
      if (!change || seen.has(key)) return;
      seen.add(key);
      if (change.type === 'stylesheet') {
        // Free-form CSS, including the variant's custom CSS block. Injected
        // only because this variant is active — other variants never reach here.
        inject(change.value || '', key);
        return;
      }
      const css = cssForChange(change);
      if (css) {
        inject(css, key);
        return;
      }
      if (!change.selector) {
        if (change.type && change.type !== 'stylesheet') console.warn('[ab] unknown change type:', change.type);
        return;
      }
      const track = shouldWatch(change);
      applyDomQuery(change, key, track);
      if (track) {
        watched.push({ change, key });
        ensureObserver();
      }
    }

    function applyAll(changes, prefix) {
      const p = prefix || 'c';
      (changes || []).forEach((change, i) => applyOne(change, p + ':' + i));
    }

    function disconnect() {
      if (observer) observer.disconnect();
      observer = null;
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
  };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
