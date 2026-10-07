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

  function leadingStat(bayes) {
    const stats = (bayes && Array.isArray(bayes.stats)) ? bayes.stats : [];
    return stats.reduce((best, row) => {
      if (!best || Number(row.probability_best) > Number(best.probability_best)) return row;
      return best;
    }, null);
  }

  function visitorTotal(bayes) {
    if (!bayes) return 0;
    const total = Number(bayes.total_visitors);
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  // Signal column on the experiments list.
  // Draft or nothing recorded yet → "No data yet".
  // Running, once each variant has a usable sample → "B leading · 68% prob. best".
  // Paused → "Paused · last: <leader or Control>".
  function signalText(status, bayes) {
    const visitors = visitorTotal(bayes);
    const leader = leadingStat(bayes);
    const leaderName = leader && leader.variant_name ? leader.variant_name : 'Control';

    if (status === 'draft') return 'No data yet';
    if (status === 'paused') {
      return visitors === 0 ? 'Paused · last: Control' : `Paused · last: ${leaderName}`;
    }
    if (visitors === 0) return 'No data yet';
    if (status === 'archived') return `Archived · last: ${leaderName}`;
    if (status === 'running') {
      if (!leader || bayes.low_sample_warning) return 'Collecting data';
      return `${shortVariantLabel(leader.variant_name)} leading · ${leader.probability_best}% prob. best`;
    }
    return 'No data yet';
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

  function describeGoal(goal) {
    if (!goal) return '';
    const label = goal.id ? goal.id : (goal.type === 'url' ? 'Visited URL' : 'Click');
    const target = goal.type === 'url' ? (goal.url_match || '') : (goal.selector || '');
    return target ? `${label} → ${target}` : label;
  }

  function formatCreated(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
    resultsGated,
    overviewBanner,
    showNextSteps,
    statusAction,
    describeGoal,
    formatCreated,
    shouldShowSignpost,
  };
});
