// Pure UI decisions for the owner admin. Kept free of DOM so the draft/empty
// rules can be checked without a browser. Loaded as a classic script in the
// dashboard (window.PivitUI) and via require() in scripts/admin-ui.test.js.
(function (root, factory) {
  const plan = (typeof module === 'object' && module.exports) ? require('../src/plan') : root.PivitPlan;
  const api = factory(plan);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PivitUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (plan) {
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
        <button type="button" class="choice" data-plan-choice="custom" aria-pressed="false">Custom<span>your own figures</span></button>
      </div>
      <p class="plan-sentence" id="${id}-plan-sentence"></p>
      <p class="hint" id="${id}-plan-meta"></p>
      <p class="hint" id="${id}-baseline-note"></p>
      <details class="plan-more">
        <summary>More info</summary>
        <div class="accordion-body">
          <h3>Why traffic sets how long a test takes</h3>
          <p>A test is like flipping a coin to check whether it is weighted.</p>
          <ul>
            <li><strong>Flip it 10 times, get 6 heads.</strong> That could easily be luck. You can't tell.</li>
            <li><strong>Flip it 1,000 times, get 600 heads.</strong> That's no accident. The coin is weighted.</li>
          </ul>
          <p>Your website works the same way. Every visitor is a flip of the coin. Conversion rates go up and down by themselves, so a few extra sales after a change might just be a good week. The more visitors you have, the sooner you can tell a real improvement from luck.</p>
          <ul>
            <li><strong>More visitors, a faster answer.</strong> Double your traffic and the test takes roughly half as long.</li>
            <li><strong>Small changes are hard to spot.</strong> A tiny difference is easily lost in the everyday ups and downs. Halve the change you're looking for and you need about four times the visitors.</li>
            <li><strong>Fewer sales means slower learning.</strong> What counts is conversions. A page where 1 in 100 people buy needs far more visitors than one where 1 in 10 do.</li>
          </ul>
          <p>pivitlab reads the result once, at the planned sample. The weeks below are how long those visitors take to arrive. The test also waits out the minimum runtime, and it does not call a winner before both are in.</p>
          <h3>Small, medium and large sites</h3>
          <div id="${id}-site-examples"></div>
        </div>
      </details>
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

  // A read that started before a confirmed write must not paint the old status.
  // A read that started after the write is the newer server state.
  function displayedStatus(readStatus, confirm, readStartedAt) {
    if (!confirm || confirm.status == null || confirm.status === '') return readStatus;
    if (Number(readStartedAt) < Number(confirm.at) && readStatus !== confirm.status) return confirm.status;
    return readStatus;
  }

  const PLAN_PRESETS = { small: 5, medium: 10, big: 20 };

  // Same baseline, change and variants as the plan on screen. Weekly traffic
  // is the only thing that changes, and the sentences are buildPlan's own.
  function trafficGuideHtml(input) {
    if (!plan || typeof plan.siteDurationExamples !== 'function') {
      return '<p class="hint">Examples are unavailable.</p>';
    }
    const examples = plan.siteDurationExamples(input || {});
    const failed = examples.find((row) => !row.ok);
    if (!examples.length || failed) {
      const message = failed && failed.error ? failed.error : 'Enter a baseline and a change to see these examples.';
      return `<p class="hint">${escapeHtml(message)}</p>`;
    }
    const small = examples.find((row) => row.id === 'small');
    const intro = small
      ? `<p class="hint">Same baseline, change and variants as the plan above. Only the weekly visits change. A small site is ${escapeHtml(small.range)}.</p>`
      : '';
    const cards = examples.map((row) => `<section class="site-example">
        <h3>${escapeHtml(row.label)}</h3>
        <p class="range">${escapeHtml(row.range)}, at ${escapeHtml(row.weekly_label)} visits a week</p>
        <p class="plan-sentence">${escapeHtml(row.sentence)}</p>
      </section>`).join('');
    return `${intro}<div class="site-examples">${cards}</div>`;
  }

  function plannerChoice(relativePct) {
    const value = Number(relativePct);
    if (!Number.isFinite(value)) return 'custom';
    const match = Object.keys(PLAN_PRESETS).find((key) => Math.abs(PLAN_PRESETS[key] - value) < 0.05);
    return match || 'custom';
  }

  // Typing any figure leaves the presets. A relative value that lands on
  // 5, 10 or 20 selects that preset again.
  function plannerSelectionAfterEdit(field, relativePct) {
    if (field === 'relative') return plannerChoice(relativePct);
    return 'custom';
  }

  function showSupportBar({ superadmin, viewing, otherAccounts } = {}) {
    if (viewing) return true;
    return superadmin === true && Number(otherAccounts) > 0;
  }

  function supportViewCopy(viewing, name) {
    if (viewing) {
      const label = name ? String(name) : 'this account';
      return `Support view: you are looking at ${label}, read-only. This view is logged.`;
    }
    return 'Support view: see another customer\'s account read-only. Every view is logged.';
  }

  const OWNER_PASSWORD_BANNER = 'You signed in with the owner password. Day to day, sign in by email at info@heclr.com. This password is only the fallback.';

  function showOwnerPasswordBanner(emergency, dismissed) {
    return emergency === true && dismissed !== true;
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

  // Shown in results when the health panel is hidden (a paused or archived test).
  // Running tests already show the same sentences on the health card.
  function renderChangeApplied(rows) {
    const lines = (rows || []).filter((row) => row && row.rate != null && row.text);
    if (!lines.length) return '';
    const body = lines.map((row) => {
      const klass = row.state === 'amber' ? 'warn-text' : 'hint';
      return `<p class="${klass}">${escapeHtml(row.text)}</p>`;
    }).join('');
    return `<div class="card"><h2>Changes</h2>${body}</div>`;
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

  const INSTALL_WAITING = 'Waiting for a page on your site to load the snippet.';
  const INSTALL_BANNER = 'We have not seen the snippet on your site yet. You can build a test, and you can start it once the check ticks.';

  // The check line on the setup screen. A server message wins when the visit
  // arrived without this account's site key. A verified site always shows the
  // success line, even if an older note is still on the payload.
  function installCheckLine(site, domain) {
    const name = domain || (site && site.domains && site.domains[0]) || (site && site.name) || 'your site';
    if (site && site.verified) {
      return { text: `We can see pivitlab on ${name}.`, problem: false, banner: '' };
    }
    const message = site && site.install_check && typeof site.install_check.message === 'string'
      ? site.install_check.message.trim()
      : '';
    if (message) return { text: message, problem: true, banner: message };
    return { text: INSTALL_WAITING, problem: false, banner: INSTALL_BANNER };
  }

  function clientLoginUrl(origin) {
    return `${origin}/login.html?role=client`;
  }

  // The address the owner opens to mark this browser as a test visit.
  // Anything that is not a plain hostname falls back to a sample, so the
  // checklist never prints a value that could break out of the page.
  function previewExampleUrl(domain) {
    const fallback = 'https://example.co.uk/?pivit_qa=1';
    if (typeof domain !== 'string') return fallback;
    let host = domain.trim().toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.includes('..')) return fallback;
    return `https://${host}/?pivit_qa=1`;
  }

  // Whether the Make edits desktop note should appear. `matches` is the
  // narrow-or-touch media query; `stored` is the dismissal flag ('1' hides it).
  function shouldShowSignpost(matches, stored) {
    return !!matches && stored !== '1';
  }

  const DEMO_RUNTIME_NOTE = 'The 14-day minimum runtime is skipped because this is a demo test. That is only allowed for a demo test. A live test still waits at least 14 days.';

  function isDemoTest(experiment) {
    if (!experiment) return false;
    if (experiment.test_type === 'demo') return true;
    return !!(experiment.plan && experiment.plan.demo === true);
  }

  function demoBadgeHtml() {
    return '<span class="badge demo">Demo</span>';
  }

  function demoRuntimeNote() {
    return DEMO_RUNTIME_NOTE;
  }

  const AUDIT_PAGE_SIZE = 25;

  const AUDIT_ACTION_LABELS = {
    test_traffic_remove: 'Removed test traffic',
    test_traffic_restore: 'Restored test traffic',
    reveal: 'Revealed early',
    role_change: 'Changed a role',
    signin: 'Signed in',
    emergency_signin: 'Signed in with the owner password',
    signout_everywhere: 'Signed out everywhere',
    signup: 'Signed up',
    email_verified: 'Verified email',
    signup_requested: 'Asked to sign up',
    signin_failed: 'Failed sign-in',
    site_added: 'Added a site',
    site_verified: 'Verified a site',
    domain_conflict: 'Flagged a domain clash',
    invite_created: 'Created an invite',
    invite_revoked: 'Revoked an invite',
    access_request_invite: 'Created an invite from a request',
    view_as: 'Started a support view',
    view_as_stop: 'Stopped a support view',
    review_request: 'Asked for a review',
    review_decided: 'Marked a review as seen',
    conclusion_drafted: 'Drafted a conclusion',
    conclusion_released: 'Released a conclusion',
    conclusion_approved: 'Approved a conclusion',
    email_bounce: 'Email bounced',
  };

  function auditActionLabel(action) {
    if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
    return String(action || '').replace(/_/g, ' ');
  }

  function auditDetailText(entry) {
    const detail = (entry && entry.detail) || {};
    if (entry && entry.action === 'role_change') {
      const who = detail.email ? `${detail.email}, ` : '';
      return `${who}from ${detail.from_role || 'unknown'} to ${detail.to_role || 'unknown'}`;
    }
    if (detail.visitor_count != null || detail.event_count != null || (detail.criteria && detail.criteria.kind === 'peek')) {
      const visitors = Number(detail.visitor_count) || 0;
      const events = Number(detail.event_count) || 0;
      const criteria = detail.criteria || {};
      let what = 'Test traffic';
      if (criteria.kind === 'peek') what = 'Early look';
      else if (criteria.mode === 'prefix' && criteria.prefix) what = `Prefix ${criteria.prefix}`;
      const visitorWord = visitors === 1 ? 'visitor' : 'visitors';
      const eventWord = events === 1 ? 'event' : 'events';
      return `${what}. ${visitors} ${visitorWord}, ${events} ${eventWord}.`;
    }
    if (detail.host) return String(detail.host);
    if (detail.website) return String(detail.website);
    if (detail.name) return String(detail.name);
    return '';
  }

  function auditRoute(hash) {
    const text = String(hash || '');
    if (text !== '#audit' && !text.startsWith('#audit?')) return null;
    const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : '');
    const page = parseInt(params.get('page') || '1', 10);
    return {
      test: params.get('test') || '',
      user: params.get('user') || '',
      action: params.get('action') || '',
      page: Number.isFinite(page) && page > 0 ? page : 1,
    };
  }

  function auditHash(state) {
    const current = state || {};
    const params = new URLSearchParams();
    if (current.test) params.set('test', current.test);
    if (current.user) params.set('user', current.user);
    if (current.action) params.set('action', current.action);
    if (current.page && Number(current.page) > 1) params.set('page', String(current.page));
    const query = params.toString();
    return query ? `#audit?${query}` : '#audit';
  }

  function auditQuery(state) {
    const current = state || {};
    const params = new URLSearchParams();
    if (current.test) params.set('test', current.test);
    if (current.user) params.set('user', current.user);
    if (current.action) params.set('action', current.action);
    params.set('page', String(current.page && current.page > 0 ? current.page : 1));
    params.set('page_size', String(current.pageSize || AUDIT_PAGE_SIZE));
    return `/api/audit?${params.toString()}`;
  }

  function auditPageLabel(page, total, pageSize) {
    const size = Number(pageSize) > 0 ? Number(pageSize) : AUDIT_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil((Number(total) || 0) / size));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);
    return `Page ${current} of ${pages}`;
  }

  function demoPlanHtml() {
    return `<div class="demo-plan" data-demo-plan="1">
      <h2>Demo plan</h2>
      <p>This is a demo test on pivitlab. It counts pivit_qa, is_test and v_pt visitors only. Real visitors are ignored and are not bucketed.</p>
      <p>The planned sample is fixed at 100 visitors per variant. The plan cannot be changed, and the test cannot be switched to live.</p>
      <p>${escapeHtml(DEMO_RUNTIME_NOTE)}</p>
    </div>`;
  }

  return {
    escapeHtml,
    shortUrl,
    shortVariantLabel,
    signalText,
    plannerShell,
    trafficGuideHtml,
    resultsGated,
    overviewBanner,
    showNextSteps,
    statusAction,
    displayedStatus,
    PLAN_PRESETS,
    plannerChoice,
    plannerSelectionAfterEdit,
    showSupportBar,
    supportViewCopy,
    OWNER_PASSWORD_BANNER,
    showOwnerPasswordBanner,
    describeGoal,
    MAX_VARIANTS,
    canAddVariant,
    variantCapMessage,
    renderHealth,
    renderChangeApplied,
    formatCreated,
    displayOrigin,
    snippetTag,
    installCheckLine,
    clientLoginUrl,
    previewExampleUrl,
    shouldShowSignpost,
    isDemoTest,
    demoBadgeHtml,
    demoRuntimeNote,
    demoPlanHtml,
    AUDIT_PAGE_SIZE,
    auditActionLabel,
    auditDetailText,
    auditRoute,
    auditHash,
    auditQuery,
    auditPageLabel,
  };
});
