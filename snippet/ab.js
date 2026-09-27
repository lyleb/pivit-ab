/**
 * AB Platform snippet — v0.4
 *
 * Usage on client site:
 *   <script src="https://your-api.example.com/snippet/ab.js"
 *           data-api="https://your-api.example.com"></script>
 *
 * Fetches active experiments for the current page, assigns the visitor
 * to a variant per experiment (sticky via localStorage), applies DOM
 * changes, and reports view/click events back to the API.
 *
 * Preview mode: append ?ab_preview=<variant_id> to any URL to force that
 * variant (works even if the experiment is draft/paused or the variant is
 * disabled) without logging any view/conversion events. The admin dashboard
 * generates these links for you.
 *
 * Anti-flicker: if the anti-flicker snippet (from the dashboard's "Copy
 * Snippet" popover) is also installed in <head>, it hides the page via an
 * `ab-hide` class on <html>. This file removes that class as soon as DOM
 * changes are applied, so the reveal happens as fast as possible rather than
 * waiting for anything else (e.g. goal-checking) to finish. The anti-flicker
 * snippet has its own 3-second timeout as a safety net, so this file doesn't
 * need one — if you skip installing it, this call is just a harmless no-op.
 *
 * Goals (v0.4): click, url, form (submit), custom and revenue. Custom and
 * revenue goals fire from the site's own code:
 *   pivit.track('signup');
 *   pivit.track('purchase', { value: 49.99 });
 * Calls made before this file loads are queued if the site first sets
 *   window.pivit = window.pivit || []; pivit.push(['track', 'purchase', { value: 49.99 }]);
 * Each non-revenue goal fires once per visitor; revenue fires on every purchase.
 */
(function () {
  const scriptTag = document.currentScript;
  const API_BASE = scriptTag.getAttribute('data-api') || '';
  const VISITOR_KEY = '_ab_visitor_id';
  const ASSIGNMENT_PREFIX = '_ab_assign_';

  function revealPage() {
    document.documentElement.classList.remove('ab-hide');
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

  function applyChange(change) {
    const els = document.querySelectorAll(change.selector);
    els.forEach((el) => {
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
          // Advanced / power-user option: runs arbitrary JS you configured yourself
          // against the matched element. Only ever set by you via the admin dashboard —
          // never accept this from anything outside your own control.
          try {
            new Function('el', change.value)(el);
          } catch (err) {
            console.warn('[ab] custom JS change failed:', err);
          }
          break;
        default:
          console.warn('[ab] unknown change type:', change.type);
      }
    });
  }

  function sendEvent(experimentId, variantId, visitorId, eventType, goalId, value) {
    const payload = {
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: visitorId,
      event_type: eventType,
      goal_id: goalId || null,
    };
    if (typeof value === 'number' && isFinite(value)) payload.value = value;
    const body = JSON.stringify(payload);
    // sendBeacon is fire-and-forget and survives page navigation, ideal for tracking calls.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API_BASE + '/api/event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch(API_BASE + '/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    }
  }

  // The string stored as goal_id. MUST match goalKey() in src/metrics.js.
  function goalKey(goal) {
    if (goal.id) return goal.id;
    const type = goal.type || 'click';
    if (type === 'url') return goal.url_match || '';
    if (type === 'custom' || type === 'revenue') return goal.event || '';
    return goal.selector || '';
  }

  // Sends a conversion, once per visitor per goal (revenue goals: every time,
  // because each purchase adds to revenue). The server also counts unique
  // visitors, so this is about keeping traffic down, not correctness.
  function convert(experimentId, variantId, visitorId, goal, value) {
    const key = goalKey(goal);
    if (!key) return;
    const isRevenue = goal.type === 'revenue';
    const firedKey = '_ab_converted_' + experimentId + '_' + key;
    if (!isRevenue) {
      if (localStorage.getItem(firedKey)) return;
      localStorage.setItem(firedKey, '1');
    }
    sendEvent(experimentId, variantId, visitorId, 'convert', key, isRevenue ? value : undefined);
  }

  // Click and form goals for experiments running on THIS page. One delegated
  // listener each on document, so elements added after page load (e.g. a
  // basket drawer or a lazy-loaded button) still count.
  function wirePageGoals(active, visitorId) {
    function handle(eventType, target) {
      if (!target || !target.closest) return;
      active.forEach(({ experimentId, variant }) => {
        (variant.goals || []).forEach((goal) => {
          const type = goal.type || 'click'; // goals saved before types existed are clicks
          if (type !== eventType || !goal.selector) return;
          let match = null;
          try { match = target.closest(goal.selector); } catch (e) { return; } // invalid selector
          if (match) convert(experimentId, variant.id, visitorId, goal);
        });
      });
    }
    // Capture phase, so a site calling stopPropagation() can't hide the event.
    document.addEventListener('click', (e) => handle('click', e.target), true);
    document.addEventListener('submit', (e) => handle('form', e.target), true);
  }

  // Every experiment this visitor has ever been assigned to (from localStorage),
  // with its goals. Used for URL goals (the goal page is often a different page,
  // e.g. /thank-you) and for pivit.track() custom/revenue goals.
  async function loadAssignedExperiments() {
    const assignments = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(ASSIGNMENT_PREFIX) === 0) {
        assignments[key.slice(ASSIGNMENT_PREFIX.length)] = localStorage.getItem(key);
      }
    }
    const experimentIds = Object.keys(assignments);
    if (experimentIds.length === 0) return [];

    const res = await fetch(`${API_BASE}/api/experiments/by-ids?ids=${experimentIds.join(',')}`);
    const data = await res.json();
    const out = [];
    (data.experiments || []).forEach((experiment) => {
      const variantId = assignments[experiment.id];
      const variant = (experiment.variants || []).find((v) => v.id === variantId);
      if (variant) out.push({ experimentId: experiment.id, variant });
    });
    return out;
  }

  function checkUrlGoals(assigned, visitorId) {
    assigned.forEach(({ experimentId, variant }) => {
      (variant.goals || []).forEach((goal) => {
        if (goal.type !== 'url' || !goal.url_match) return;
        if (window.location.href.indexOf(goal.url_match) === -1) return;
        convert(experimentId, variant.id, visitorId, goal);
      });
    });
  }

  // --- pivit.track() — custom and revenue goals fired from the site's own code ---
  let assignedExperiments = null; // null until loaded
  let trackingDisabled = false;   // true in preview mode
  const pendingTracks = [];

  function runTrack(name, props, visitorId) {
    if (trackingDisabled || !name) return;
    const value = props && props.value !== undefined ? Number(props.value) : undefined;
    assignedExperiments.forEach(({ experimentId, variant }) => {
      (variant.goals || []).forEach((goal) => {
        if ((goal.type === 'custom' || goal.type === 'revenue') && goal.event === name) {
          convert(experimentId, variant.id, visitorId, goal, value);
        }
      });
    });
  }

  function installTrackApi(visitorId) {
    const queued = Array.isArray(window.pivit) ? window.pivit.slice() : [];
    function track(name, props) {
      if (assignedExperiments === null) pendingTracks.push([name, props]);
      else runTrack(name, props, visitorId);
    }
    window.pivit = {
      track,
      push(args) { if (args && args[0] === 'track') track(args[1], args[2]); },
    };
    queued.forEach((args) => window.pivit.push(args));
  }

  function flushTracks(visitorId) {
    while (pendingTracks.length) {
      const [name, props] = pendingTracks.shift();
      runTrack(name, props, visitorId);
    }
  }

  async function init() {
    const visitorId = getVisitorId();
    const url = encodeURIComponent(window.location.href);

    // Preview mode: ?ab_preview=<variant_id> forces that exact variant, works even
    // for a draft/paused experiment or a paused variant, and never logs events —
    // so previewing never pollutes your real results.
    const previewVariantId = new URLSearchParams(window.location.search).get('ab_preview');
    const previewQuery = previewVariantId ? '&preview=1' : '';
    if (previewVariantId) trackingDisabled = true;
    const activeOnPage = [];

    try {
      const res = await fetch(`${API_BASE}/api/experiments?url=${url}${previewQuery}`);
      const data = await res.json();

      (data.experiments || []).forEach((experiment) => {
        if (!experiment.variants || experiment.variants.length === 0) return;

        let variant;
        let isPreview = false;
        if (previewVariantId) {
          const match = experiment.variants.find((v) => v.id === previewVariantId);
          if (match) { variant = match; isPreview = true; }
        }
        if (!variant) variant = pickVariant(experiment, visitorId);

        (variant.changes || []).forEach(applyChange);

        if (isPreview) {
          console.info(`[ab] preview mode — showing variant "${variant.name}" for experiment "${experiment.name}". No events are being logged.`);
        } else {
          sendEvent(experiment.id, variant.id, visitorId, 'view');
          activeOnPage.push({ experimentId: experiment.id, variant });
        }
      });
      if (activeOnPage.length) wirePageGoals(activeOnPage, visitorId);

      // Reveal now — DOM changes are applied, so this is the earliest safe moment.
      // Everything after this (goal-checking) doesn't affect what's visible.
      revealPage();

      // Check "visited a URL" goals on every page load — including pages with no
      // on-page experiment at all, e.g. a /thank-you confirmation page.
      if (!previewVariantId) {
        try {
          assignedExperiments = await loadAssignedExperiments();
          checkUrlGoals(assignedExperiments, visitorId);
        } catch (err) {
          console.warn('[ab] failed to check goals:', err);
          assignedExperiments = [];
        }
      } else {
        assignedExperiments = [];
      }
      flushTracks(visitorId);
    } catch (err) {
      console.warn('[ab] failed to load experiments:', err);
      revealPage(); // never leave the page hidden just because the API call failed
      assignedExperiments = assignedExperiments || [];
      flushTracks(visitorId);
    }
  }

  // Install pivit.track() straight away (not on DOMContentLoaded), so site code
  // can call it as soon as this script has run; calls queue until goals load.
  installTrackApi(getVisitorId());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
