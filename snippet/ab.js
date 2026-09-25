/**
 * AB Platform snippet — v0.2
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
