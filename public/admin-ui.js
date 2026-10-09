// Pure UI decisions for the owner admin. Kept free of DOM so the draft/empty
// rules can be checked without a browser. Loaded as a classic script in the
// dashboard (window.PivitUI) and via require() in scripts/admin-ui.test.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PivitUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function shortUrl(url) {
    if (!url) return '—';
    let text = String(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (text.length > 42) text = text.slice(0, 40) + '…';
    return text;
  }

  // "variant-b" → "B" so the experiments list can read "B leading · 68% prob. best".
  function shortVariantLabel(name) {
    const text = String(name || '').trim();
    if (!text) return 'Variant';
    if (/^control$/i.test(text)) return 'Control';
    const matched = text.match(/^(?:variant|challenger)[\s_-]*([a-z0-9]+)$/i);
    if (matched) return matched[1].length <= 2 ? matched[1].toUpperCase() : matched[1];
    return text;
  }

  function visitorTotal(bayes) {
    if (!bayes) return 0;
    const total = Number(bayes.total_visitors);
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  // Signal column on the experiments list.
  // A running test does not announce a winner from a live probability.
  // The server sends mode; without one, the column stays a health check.
  function signalText(status, reading) {
    if (status === 'draft') return 'No data yet';
    const mode = reading && reading.mode;
    const days = reading ? Number(reading.days_elapsed) || 0 : 0;
    const min = reading ? Number(reading.min_runtime_days) || 0 : 0;
    if (mode === 'unplanned') return status === 'paused' ? 'Paused · set a plan' : 'Set a plan';
    if (mode === 'data_problem') return status === 'paused' ? 'Paused · data problem' : 'Data problem';
    if (mode === 'verdict') return status === 'paused' ? 'Paused · verdict ready' : 'Verdict ready';
    if (mode === 'peeked') return 'Peeked · not a verdict';
    if (mode === 'blind') {
      const head = status === 'paused' ? 'Paused · health check' : 'Health check';
      return min ? `${head} · ${days} of ${min} days` : head;
    }
    const visitors = visitorTotal(reading);
    if (status === 'paused') return visitors === 0 ? 'Paused · last: Control' : 'Paused';
    if (status === 'archived') return visitors === 0 ? 'No data yet' : 'Archived';
    if (status === 'running') return visitors === 0 ? 'No data yet' : 'Health check';
    return 'No data yet';
  }

  function plannerShell(prefix) {
    const id = escapeHtml(prefix);
    return `<div class="planner" data-planner="${id}">
      <h2>How big a change are you looking for?</h2>
      <p class="hint">You can leave the suggestion. pivitlab turns it into the visitors you need, and saves a plan either way.</p>
      <div class="choice-row" role="radiogroup" aria-label="Size of change">
        <button type="button" class="choice" data-plan-choice="small" aria-pressed="false">Small change<span>about 5% relative</span></button>
        <button type="button" class="choice" data-plan-choice="medium" aria-pressed="true">Medium<span>about 10% relative</span></button>
        <button type="button" class="choice" data-plan-choice="big" aria-pressed="false">Big<span>about 20% relative</span></button>
      </div>
      <p class="plan-sentence" id="${id}-plan-sentence"></p>
      <p class="hint" id="${id}-plan-meta"></p>
      <p class="hint" id="${id}-baseline-note"></p>
      <details>
        <summary>Advanced</summary>
        <div class="accordion-body">
          <label for="${id}-baseline">Baseline conversion rate (%)</label>
          <input id="${id}-baseline" type="number" min="0.1" max="99" step="0.1" value="3">
          <label for="${id}-relative">Relative change to detect (%)</label>
          <input id="${id}-relative" type="number" min="1" max="200" step="0.5" value="10">
          <label for="${id}-weekly">Visitors you expect in a week</label>
          <input id="${id}-weekly" type="number" min="0" step="1">
          <label for="${id}-weeks">Minimum runtime (weeks)</label>
          <input id="${id}-weeks" type="number" min="1" max="26" step="1" value="2">
          <p class="hint" id="${id}-week-warn"></p>
          <p class="hint" id="${id}-maths"></p>
        </div>
      </details>
    </div>`;
  }

  // Draft, or a test that has not recorded a visitor, must not show rates or
  // a Bayesian read (those sit near 50/50 with no evidence).
  function resultsGated(status, visitors) {
    return status === 'draft' || !(Number(visitors) > 0);
  }

  function overviewBanner(status, visitors) {
    if (status === 'draft') {
      return {
        show: true,
        text: 'Not running — Bayesian and conversion rates stay hidden until you collect traffic. Install the snippet, then start.',
      };
    }
    if (!(Number(visitors) > 0)) {
      return {
        show: true,
        text: 'No traffic yet — rates and probability best stay hidden until visitors arrive.',
      };
    }
    return { show: false, text: '' };
  }

  function showNextSteps(status, visitors) {
    return status === 'draft' || !(Number(visitors) > 0);
  }

  function statusAction(status) {
    if (status === 'draft') return { label: 'Start experiment', next: 'running' };
    if (status === 'running') return { label: 'Pause', next: 'paused' };
    if (status === 'paused') return { label: 'Resume', next: 'running' };
    return null;
  }

  const MAX_VARIANTS = 3;

  function canAddVariant(count) {
    return Number(count) < MAX_VARIANTS;
  }

  // Shown when a test is already at the limit, and a gentler line when an
  // older test has more than three and must keep running.
  function variantCapMessage(count) {
    const n = Number(count) || 0;
    if (n > MAX_VARIANTS) {
      return `This test has ${n} variants. New tests are limited to 3, including Control. These extra variants still run.`;
    }
    if (n >= MAX_VARIANTS) return 'A test can have at most 3 variants, including Control.';
    return '';
  }

  function describeGoal(goal) {
    if (!goal) return '';
    const label = goal.name || goal.id || (goal.type === 'url' ? 'Visited URL' : 'Click');
    if (goal.type === 'url') {
      const target = goal.url_match || '';
      const how = {
        contains: 'contains',
        exact: 'is exactly',
        starts_with: 'starts with',
        regex: 'matches',
      }[goal.match || 'contains'] || 'contains';
      return target ? `${label} → URL ${how} ${target}` : label;
    }
    const target = goal.selector || '';
    return target ? `${label} → ${target}` : label;
  }

  function renderHealth(report) {
    if (!report || !report.show || !Array.isArray(report.checks)) return '';
    const cards = report.checks.map((check) => {
      const state = check.state === 'red' || check.state === 'amber' || check.state === 'green' ? check.state : 'amber';
      const label = state === 'green' ? 'OK' : (state === 'red' ? 'Problem' : 'Check');
      return `<section class="health-card ${state}"><div class="state">${escapeHtml(label)}</div><h3>${escapeHtml(check.title || '')}</h3><p>${escapeHtml(check.detail || '')}</p></section>`;
    }).join('');
    return `<h2>Health</h2><div class="health-grid">${cards}</div>`;
  }

  function formatCreated(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // scheme://host[:port] only. Blocks quotes and other characters that would
  // break out of the snippet tag's src and data-api attributes.
  const SAFE_ORIGIN = /^https?:\/\/(?:(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)|\[[a-f0-9:]+\])(?::\d+)?$/i;

  // Server-configured public origin for the snippet tag and client login link.
  // Empty or anything that is not an http(s) origin falls back to the page host,
  // which is what the admin UI used before APP_ORIGIN existed.
  function displayOrigin(configured, fallback) {
    if (typeof configured !== 'string') return fallback;
    const value = configured.trim();
    if (!value) return fallback;
    let url;
    try {
      url = new URL(value);
    } catch (err) {
      return fallback;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    if (url.username || url.password) return fallback;
    if (url.search || url.hash) return fallback;
    if (url.pathname !== '/' && url.pathname !== '' && !/^\/+$/.test(url.pathname)) return fallback;
    if (!SAFE_ORIGIN.test(url.origin)) return fallback;
    return url.origin;
  }

  function snippetTag(origin, siteKey) {
    const closeTag = '</' + 'script>';
    const key = typeof siteKey === 'string' ? siteKey.trim() : '';
    const siteAttr = /^site_[a-f0-9]{16,80}$/i.test(key) ? ` data-site="${key}"` : '';
    return `<script src="${origin}/snippet/ab.js" data-api="${origin}"${siteAttr}>${closeTag}`;
  }

  function clientLoginUrl(origin) {
    return `${origin}/login.html?role=client`;
  }

  // Whether the Make edits desktop note should appear. `matches` is the
  // narrow-or-touch media query; `stored` is the dismissal flag ('1' hides it).
  function shouldShowSignpost(matches, stored) {
    return !!matches && stored !== '1';
  }

  return {
    escapeHtml,
    shortUrl,
    shortVariantLabel,
    signalText,
    plannerShell,
    resultsGated,
    overviewBanner,
    showNextSteps,
    statusAction,
    describeGoal,
    MAX_VARIANTS,
    canAddVariant,
    variantCapMessage,
    renderHealth,
    formatCreated,
    displayOrigin,
    snippetTag,
    clientLoginUrl,
    shouldShowSignpost,
  };
});
