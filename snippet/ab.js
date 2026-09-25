/**
 * AB Platform snippet — v0.1
 *
 * Usage on client site:
 *   <script src="https://your-api.example.com/snippet/ab.js"
 *           data-api="https://your-api.example.com"></script>
 *
 * Fetches active experiments for the current page, assigns the visitor
 * to a variant per experiment (sticky via localStorage), applies DOM
 * changes, and reports view/click events back to the API.
 */
(function () {
  const scriptTag = document.currentScript;
  const API_BASE = scriptTag.getAttribute('data-api') || '';
  const VISITOR_KEY = '_ab_visitor_id';
  const ASSIGNMENT_PREFIX = '_ab_assign_';

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
      document.querySelectorAll(goal.selector).forEach((el) => {
        el.addEventListener('click', () => {
          sendEvent(experimentId, variantId, visitorId, 'convert', goal.id || goal.selector);
        });
      });
    });
  }

  async function init() {
    const visitorId = getVisitorId();
    const url = encodeURIComponent(window.location.href);

    try {
      const res = await fetch(`${API_BASE}/api/experiments?url=${url}`);
      const data = await res.json();

      (data.experiments || []).forEach((experiment) => {
        if (!experiment.variants || experiment.variants.length === 0) return;

        const variant = pickVariant(experiment, visitorId);
        (variant.changes || []).forEach(applyChange);

        sendEvent(experiment.id, variant.id, visitorId, 'view');
        wireConversionTracking(experiment.id, variant.id, visitorId, variant);
      });
    } catch (err) {
      console.warn('[ab] failed to load experiments:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
