/**
 * AB Platform snippet — v0.3
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

  function wireConversionTracking(experimentId, variantId, visitorId, variant) {
    (variant.goals || []).forEach((goal) => {
      const type = goal.type || 'click'; // goals saved before this feature have no "type" — always click
      if (type !== 'click') return; // 'url' goals are handled by checkUrlGoals below, not here
      document.querySelectorAll(goal.selector).forEach((el) => {
        el.addEventListener('click', () => {
          sendEvent(experimentId, variantId, visitorId, 'convert', goal.id || goal.selector);
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

        (variant.goals || []).forEach((goal) => {
          if (goal.type !== 'url' || !goal.url_match) return;
          if (window.location.href.indexOf(goal.url_match) === -1) return;

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

  async function init() {
    const visitorId = getVisitorId();
    const url = encodeURIComponent(window.location.href);

    // Preview mode: ?ab_preview=<variant_id> forces that exact variant, works even
    // for a draft/paused experiment or a paused variant, and never logs events —
    // so previewing never pollutes your real results.
    const previewVariantId = new URLSearchParams(window.location.search).get('ab_preview');
    const previewQuery = previewVariantId ? '&preview=1' : '';

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
          wireConversionTracking(experiment.id, variant.id, visitorId, variant);
        }
      });

      // Reveal now — DOM changes are applied, so this is the earliest safe moment.
      // Everything after this (goal-checking) doesn't affect what's visible.
      revealPage();

      // Check "visited a URL" goals on every page load — including pages with no
      // on-page experiment at all, e.g. a /thank-you confirmation page.
      if (!previewVariantId) await checkUrlGoals(visitorId);
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
})();
