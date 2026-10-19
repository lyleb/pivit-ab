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
      const label = name ? String(name) : 'this agency';
      return `Support view: you are looking at ${label}, read-only. This view is logged.`;
    }
    return 'Support view: see another agency read-only. Every view is logged.';
  }

  // Visible role names. The session role and the database columns stay as they are.
  function roleBadgeLabel({ superadmin, membership, viewer } = {}) {
    if (viewer === true) return 'Viewer';
    if (superadmin === true) return 'Platform admin';
    if (membership === 'member') return 'Member';
    return 'Owner';
  }

  function membershipWord(role) {
    if (role === 'owner') return 'Owner';
    if (role === 'member') return 'Member';
    return role || 'unknown';
  }

  function auditActorLabel(label) {
    const text = label == null ? '' : String(label);
    if (text === 'superadmin') return 'Platform admin';
    if (text === 'client') return 'Viewer';
    return text || 'Unknown';
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

  // Server-configured public origin for the snippet tag and viewer login link.
  // Empty or anything that is not an http(s) origin returns fallback.
  // The dashboard passes null. It must not substitute location.origin.
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

  // Split OK / Split skewed / Too early. The server decides the state
  // (p < 0.01, hidden as a verdict until 100 visitors). This only paints the pill.
  // A link to #srm-panel. Pass an experiment id on a list row so the dashboard
  // can open that test's results before scrolling.
  function splitPillHtml(check, experimentId) {
    if (!check || !check.label) return '';
    const state = check.state === 'ok' || check.state === 'skewed' ? check.state : 'early';
    const id = experimentId ? ` data-open-srm="${escapeHtml(experimentId)}"` : '';
    return `<a class="split-pill ${state}" href="#srm-panel"${id} title="${escapeHtml(check.tooltip || '')}">${escapeHtml(check.label)}</a>`;
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
    account_invite_created: 'Created an agency invite',
    account_invite_resent: 'Resent an agency invite',
    account_invite_revoked: 'Revoked an agency invite',
    account_invite_accepted: 'Accepted an agency invite',
    access_request_invite: 'Created an invite from a request',
    view_as: 'Started a support view',
    view_as_stop: 'Stopped a support view',
    review_request: 'Asked for a review',
    review_decided: 'Marked a review as seen',
    conclusion_drafted: 'Drafted a conclusion',
    conclusion_released: 'Released a conclusion',
    conclusion_approved: 'Approved a conclusion',
    email_bounce: 'Email bounced',
    'user.suspended': 'Suspended sign-in',
    'user.unsuspended': 'Allowed sign-in again',
    'user.archived': 'Archived a person',
    'user.restored': 'Restored a person',
    'user.deleted': 'Deleted a person',
    'membership.removed': 'Removed from the agency',
    'viewer.created': 'Created a Viewer',
    'viewer.updated': 'Edited a Viewer',
    'viewer.password_reset': 'Reset a Viewer password',
    'viewer.deleted': 'Deleted a Viewer',
  };

  function auditActionLabel(action) {
    if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
    return String(action || '').replace(/_/g, ' ');
  }

  function auditDetailText(entry) {
    const detail = (entry && entry.detail) || {};
    if (entry && String(entry.action || '').indexOf('user.') === 0) {
      if (detail.label) return String(detail.label);
      if (detail.email) return String(detail.email);
      if (detail.username) return String(detail.username);
    }
    if (entry && String(entry.action || '').indexOf('account_invite_') === 0) {
      const who = detail.email ? String(detail.email) : '';
      const role = membershipWord(detail.role);
      if (who && (role === 'Owner' || role === 'Member')) return `${who}, ${role}`;
      return who || '';
    }
    if (entry && entry.action === 'role_change') {
      const who = detail.email ? `${detail.email}, ` : '';
      return `${who}from ${membershipWord(detail.from_role)} to ${membershipWord(detail.to_role)}`;
    }
    if (entry && entry.action === 'membership.removed') {
      const who = detail.email ? String(detail.email) : '';
      const role = membershipWord(detail.role);
      if (who && (role === 'Owner' || role === 'Member')) return `${who}, ${role}`;
      return who;
    }
    if (entry && String(entry.action || '').indexOf('viewer.') === 0) {
      const name = detail.name ? String(detail.name) : '';
      const username = detail.username ? String(detail.username) : '';
      if (name && username && name.toLowerCase() !== username.toLowerCase()) return `${name} (${username})`;
      return name || username;
    }
    if (detail.visitor_count != null || detail.event_count != null || (detail.criteria && detail.criteria.kind === 'peek')) {
      const visitors = Number(detail.visitor_count) || 0;
      const events = Number(detail.event_count) || 0;
      const criteria = detail.criteria || {};
      let what = 'Test traffic';
      if (criteria.kind === 'peek') what = 'Early look';
      else if (criteria.mode === 'all') what = 'All test traffic';
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

  const DOMAIN_IN_USE_WARNING = 'This domain is already in use. A test runs only where this site\'s snippet is installed.';

  // One site is used as it is. Several sites use a remembered id, and never
  // the first row, until the owner has chosen.
  function siteChoiceState(sites, rememberedId) {
    const list = Array.isArray(sites) ? sites : [];
    if (list.length === 1) return { required: false, site: list[0], sites: list };
    const site = rememberedId
      ? (list.find((item) => item && item.id === rememberedId) || null)
      : null;
    return { required: list.length > 1 && !site, site, sites: list };
  }

  function auditPageLabel(page, total, pageSize) {
    const size = Number(pageSize) > 0 ? Number(pageSize) : AUDIT_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil((Number(total) || 0) / size));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);
    return `Page ${current} of ${pages}`;
  }

  // Users screen. The list comes from GET /api/admin/users. Decisions here
  // stay free of the DOM so the filters and the guard rails can be tested
  // without a browser. The sentences match the API.

  const USERS_GUARD_SELF = "You can't change your own access.";
  const USERS_GUARD_LAST_ADMIN = 'pivitlab needs at least one Platform admin.';
  const USERS_GUARD_LAST_OWNER = 'This agency needs at least one Owner.';

  const USERS_TYPE_LABELS = {
    platform_admin: 'Platform admin',
    owner: 'Owner',
    member: 'Member',
    viewer: 'Viewer',
  };

  const USERS_STATUS_LABELS = {
    active: 'Active',
    suspended: 'Suspended',
    archived: 'Archived',
  };

  function usersText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function personOpen(person) {
    return !!(person && !person.suspended && !person.archived);
  }

  function personTypes(person) {
    if (!person) return [];
    if (person.kind === 'viewer' || person.role === 'viewer') return ['viewer'];
    const types = [];
    if (person.superadmin) types.push('platform_admin');
    if (person.role === 'owner') types.push('owner');
    if (person.role === 'member') types.push('member');
    return types;
  }

  function personTypeLabel(person) {
    const types = personTypes(person);
    if (!types.length) return '—';
    return types.map((type) => USERS_TYPE_LABELS[type] || type).join(' · ');
  }

  function personStatusKeys(person) {
    if (!person) return ['active'];
    const keys = [];
    if (person.archived) keys.push('archived');
    if (person.suspended) keys.push('suspended');
    if (!keys.length) keys.push('active');
    return keys;
  }

  function personStatusLabel(person) {
    return personStatusKeys(person).map((key) => USERS_STATUS_LABELS[key] || key).join(' · ');
  }

  function personIdentity(person) {
    if (!person) return { primary: '—', secondary: '' };
    if (person.kind === 'viewer') {
      const name = String(person.name || '').trim();
      const username = String(person.username || '').trim();
      if (name && username && name.toLowerCase() !== username.toLowerCase()) {
        return { primary: name, secondary: username };
      }
      return { primary: name || username || '—', secondary: '' };
    }
    const email = String(person.email || '').trim();
    return { primary: email || '—', secondary: '' };
  }

  function personSearchText(person) {
    const identity = personIdentity(person);
    return [
      identity.primary,
      identity.secondary,
      person && person.email,
      person && person.username,
      person && person.name,
      person && person.account_name,
      personTypeLabel(person),
      personStatusLabel(person),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function activePlatformAdminCount(people) {
    const ids = new Set();
    (people || []).forEach((person) => {
      if (!person || person.kind === 'viewer' || !person.superadmin || !personOpen(person)) return;
      ids.add(String(person.id).toLowerCase());
    });
    return ids.size;
  }

  // True when suspending or archiving this person would leave an agency
  // with no active Owner. Checked across every agency they own, not only
  // the row on screen.
  function soleOwner(person, people) {
    if (!person || person.kind === 'viewer') return false;
    const self = String(person.id).toLowerCase();
    const accounts = new Set();
    (people || []).forEach((row) => {
      if (!row || row.kind === 'viewer') return;
      if (String(row.id).toLowerCase() !== self) return;
      if (row.role === 'owner' && row.account_id) accounts.add(String(row.account_id));
    });
    for (const accountId of accounts) {
      const covered = (people || []).some((other) => {
        if (!other || other.kind === 'viewer') return false;
        if (String(other.account_id) !== accountId) return false;
        if (String(other.id).toLowerCase() === self) return false;
        if (other.role !== 'owner') return false;
        return personOpen(other);
      });
      if (!covered) return true;
    }
    return false;
  }

  // Same order as the API: last Platform admin, then last Owner, then yourself.
  // A person who is already suspended or archived is not "open", so closing
  // them further is allowed.
  function closingBlock(person, people, selfEmail) {
    if (!person || person.kind === 'viewer' || !personOpen(person)) return '';
    if (person.superadmin && activePlatformAdminCount(people) < 2) return USERS_GUARD_LAST_ADMIN;
    if (soleOwner(person, people)) return USERS_GUARD_LAST_OWNER;
    if (selfEmail && person.email && usersText(person.email) === usersText(selfEmail)) {
      return USERS_GUARD_SELF;
    }
    return '';
  }

  function otherPlatformAdmin(person, people) {
    const self = String(person.id).toLowerCase();
    return (people || []).some((other) => {
      if (!other || other.kind === 'viewer' || !other.superadmin) return false;
      return String(other.id).toLowerCase() !== self;
    });
  }

  // An Owner who is suspended or archived still counts. Delete is permanent,
  // so the agency must keep someone who can be restored.
  function soleRemainingOwner(person, people) {
    if (!person || person.kind === 'viewer') return false;
    const self = String(person.id).toLowerCase();
    const accounts = new Set();
    (people || []).forEach((row) => {
      if (!row || row.kind === 'viewer') return;
      if (String(row.id).toLowerCase() !== self) return;
      if (row.role === 'owner' && row.account_id) accounts.add(String(row.account_id));
    });
    for (const accountId of accounts) {
      const covered = (people || []).some((other) => {
        if (!other || other.kind === 'viewer') return false;
        if (String(other.account_id) !== accountId) return false;
        if (String(other.id).toLowerCase() === self) return false;
        if (other.role !== 'owner') return false;
        return true;
      });
      if (!covered) return true;
    }
    return false;
  }

  function personDeleteBlock(person, people, selfEmail) {
    if (!person || person.kind === 'viewer') return '';
    if (person.superadmin && !otherPlatformAdmin(person, people)) return USERS_GUARD_LAST_ADMIN;
    if (soleRemainingOwner(person, people)) return USERS_GUARD_LAST_OWNER;
    if (selfEmail && person.email && usersText(person.email) === usersText(selfEmail)) {
      return USERS_GUARD_SELF;
    }
    return '';
  }

  function personActions(person, people, selfEmail) {
    const block = closingBlock(person, people, selfEmail);
    const actions = [];
    if (!person) return { actions, reason: '' };
    if (person.suspended) actions.push({ id: 'unsuspend', label: 'Unsuspend', blocked: '' });
    else actions.push({ id: 'suspend', label: 'Suspend', blocked: block, danger: true });
    if (person.archived) actions.push({ id: 'restore', label: 'Restore', blocked: '' });
    else actions.push({ id: 'archive', label: 'Archive', blocked: personOpen(person) ? block : '', danger: true });
    if (person.suspended || person.archived) {
      actions.push({
        id: 'delete',
        label: 'Delete',
        blocked: personDeleteBlock(person, people, selfEmail),
        danger: true,
      });
    }
    const reason = actions.map((action) => action.blocked).find(Boolean) || '';
    return { actions, reason };
  }

  function personConfirm(action, person) {
    const who = personIdentity(person).primary;
    const copy = {
      suspend: {
        title: 'Suspend sign-in?',
        confirm: 'Suspend',
        danger: true,
        body: `Suspend sign-in for ${who}? They are signed out of every agency straight away and cannot sign in until you allow it again.`,
      },
      unsuspend: {
        title: 'Allow sign-in again?',
        confirm: 'Unsuspend',
        danger: false,
        body: `Allow ${who} to sign in again?`,
      },
      archive: {
        title: 'Archive this person?',
        confirm: 'Archive',
        danger: true,
        body: `Archive ${who}? They disappear from lists and dropdowns in every agency, including the audit log. They can still sign in until you suspend them. You can restore them later.`,
      },
      restore: {
        title: 'Restore this person?',
        confirm: 'Restore',
        danger: false,
        body: `Restore ${who}? They show in lists and dropdowns again.`,
      },
      delete: {
        title: 'Delete this person?',
        confirm: 'Delete',
        danger: true,
        typed: true,
        prompt: person && person.kind === 'viewer' ? 'Type their username' : 'Type their email',
        body: `Delete ${who}? This cannot be undone. pivitlab removes their name, email or username, password and sign-in tokens, and their place in every agency. The audit log stays, under a label that does not name them.`,
      },
    };
    return copy[action] || null;
  }

  function personConfirmPhrase(person) {
    if (!person) return '';
    if (person.kind === 'viewer') return String(person.username || '').trim();
    return String(person.email || '').trim();
  }

  function personConfirmReady(action, person, typed) {
    if (action !== 'delete') return true;
    const expected = personConfirmPhrase(person);
    if (!expected) return false;
    return usersText(typed) === usersText(expected);
  }

  function personAccessPatch(action) {
    if (action === 'suspend') return { suspended: true };
    if (action === 'unsuspend') return { suspended: false };
    if (action === 'archive') return { archived: true };
    if (action === 'restore') return { archived: false };
    return null;
  }

  function personAccessPath(person) {
    if (!person || !person.id) return '';
    const id = encodeURIComponent(String(person.id));
    if (person.kind === 'viewer') return `/api/admin/clients/${id}`;
    return `/api/admin/users/${id}`;
  }

  function personRowKey(person) {
    if (!person) return '';
    return [person.kind || 'user', person.id || '', person.account_id || '', person.role || ''].join(':');
  }

  function personDoneMessage(action) {
    return {
      suspend: 'Sign-in suspended.',
      unsuspend: 'Sign-in allowed again.',
      archive: 'Archived. They stay hidden from lists until you restore them.',
      restore: 'Restored.',
      delete: 'Deleted. The audit log keeps the history without their personal details.',
    }[action] || '';
  }

  function filterPeople(people, options) {
    const opts = options || {};
    const query = String(opts.query || '').trim().toLowerCase();
    const type = opts.type || '';
    const status = opts.status || '';
    const agency = opts.agency == null ? '' : String(opts.agency);
    const showArchived = opts.showArchived === true || status === 'archived';
    return (people || []).filter((person) => {
      if (!person) return false;
      if (person.archived && !showArchived) return false;
      if (type && personTypes(person).indexOf(type) === -1) return false;
      if (status === 'active' && (person.suspended || person.archived)) return false;
      if (status === 'suspended' && !person.suspended) return false;
      if (status === 'archived' && !person.archived) return false;
      if (agency === 'none' && person.account_id) return false;
      if (agency && agency !== 'none' && String(person.account_id) !== agency) return false;
      if (query && personSearchText(person).indexOf(query) === -1) return false;
      return true;
    });
  }

  function peopleAgencies(people) {
    const map = new Map();
    (people || []).forEach((person) => {
      if (!person || !person.account_id) return;
      if (!map.has(String(person.account_id))) {
        map.set(String(person.account_id), person.account_name || 'Agency');
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => {
      const byName = String(a.name).localeCompare(String(b.name), 'en-GB');
      if (byName) return byName;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function peopleAgencyOptions(people) {
    return {
      agencies: peopleAgencies(people),
      none: (people || []).some((person) => person && !person.account_id),
    };
  }

  function hiddenArchivedCount(people, options) {
    const opts = options || {};
    if (opts.showArchived === true || opts.status === 'archived') return 0;
    const widened = Object.assign({}, opts, { showArchived: true });
    return filterPeople(people, widened).length - filterPeople(people, opts).length;
  }

  function usersSummary({ shown, total, archivedHidden, filtered } = {}) {
    const visible = Number(shown) || 0;
    const all = Number(total) || 0;
    const hidden = Number(archivedHidden) || 0;
    const narrowing = filtered === true;
    if (all === 0) return 'No one to show.';
    if (visible === 0 && hidden > 0 && !narrowing) {
      return hidden === 1 ? '1 archived person is hidden.' : `${hidden} archived people are hidden.`;
    }
    if (visible === 0 && hidden > 0) {
      const extra = hidden === 1 ? '1 archived person is hidden.' : `${hidden} archived people are hidden.`;
      return `No one matches. ${extra}`;
    }
    if (visible === 0) return 'No one matches these filters.';
    const noun = visible === 1 ? '1 person' : `${visible} people`;
    if (hidden > 0) {
      const extra = hidden === 1 ? '1 archived person is hidden.' : `${hidden} archived people are hidden.`;
      return `Showing ${noun}. ${extra}`;
    }
    if (visible !== all) return `Showing ${noun} of ${all}.`;
    return `Showing ${noun}.`;
  }

  function canOpenUsers(me) {
    if (!me || me.superadmin !== true) return false;
    if (me.view_as && me.view_as.id) return false;
    return true;
  }

  function usersDeniedMessage(me) {
    if (me && me.view_as && me.view_as.id) return 'Stop the support view before you manage users.';
    return 'Users is only for a Platform admin.';
  }

  function usersRoute(hash) {
    const text = String(hash || '');
    if (text === '#users' || text.startsWith('#users?')) return { page: 'users' };
    return null;
  }

  function canManageTeam(me) {
    if (!me || me.membership !== 'owner') return false;
    if (me.view_as && me.view_as.id) return false;
    return true;
  }

  // Clear test traffic is for an agency Owner or a platform admin.
  // A support view is read-only, and a Member does not get the button.
  function canClearTestTraffic(me) {
    if (!me || me.role === 'client') return false;
    if (me.view_as && me.view_as.id) return false;
    if (me.superadmin === true) return true;
    if (me.emergency === true) return true;
    return me.membership === 'owner';
  }

  function canOpenTeam(me) {
    if (!me) return false;
    if (me.view_as && me.view_as.id) return false;
    return me.membership === 'owner' || me.membership === 'member';
  }

  function teamDeniedMessage(me) {
    if (me && me.view_as && me.view_as.id) return 'Stop the support view before you open Team.';
    return 'Team is for people in this agency.';
  }

  function teamSame(left, right) {
    return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
  }

  function teamOwners(people, person) {
    const self = String(person && person.id || '').toLowerCase();
    return (people || []).filter((row) => {
      if (!row || row.kind === 'viewer' || row.role !== 'owner') return false;
      return String(row.id).toLowerCase() !== self;
    });
  }

  // The last Owner stays. You cannot remove yourself. A Viewer has no membership.
  function teamRemoveBlock(person, people, selfEmail) {
    if (!person || person.kind === 'viewer') return '';
    if (person.role === 'owner') {
      const others = teamOwners(people, person);
      const activeOthers = others.filter((row) => !row.suspended && !row.archived);
      if (!others.length || (!person.suspended && !person.archived && !activeOthers.length)) {
        return USERS_GUARD_LAST_OWNER;
      }
    }
    if (selfEmail && person.email && teamSame(person.email, selfEmail)) return USERS_GUARD_SELF;
    return '';
  }

  function teamRoleLocked(person, people) {
    if (!person || person.kind === 'viewer' || person.role !== 'owner') return false;
    const others = teamOwners(people, person);
    if (!others.length) return true;
    if (person.suspended || person.archived) return false;
    return !others.some((row) => !row.suspended && !row.archived);
  }

  function teamActions(person, people, selfEmail, canManage) {
    if (!canManage || !person) return { actions: [], reason: '', roleLocked: false };
    if (person.kind === 'viewer') {
      const actions = [];
      if (person.archived) {
        actions.push({ id: 'restore', label: 'Restore' });
      } else {
        actions.push({ id: 'edit', label: 'Edit' });
        actions.push({ id: 'password', label: 'Reset password' });
        if (person.suspended) actions.push({ id: 'unsuspend', label: 'Unsuspend' });
        else actions.push({ id: 'suspend', label: 'Suspend', danger: true });
        actions.push({ id: 'archive', label: 'Archive', danger: true });
      }
      return { actions, reason: '', roleLocked: false };
    }
    const removeBlock = teamRemoveBlock(person, people, selfEmail);
    const roleLocked = teamRoleLocked(person, people);
    const reason = removeBlock || (roleLocked ? USERS_GUARD_LAST_OWNER : '');
    return {
      actions: [{ id: 'remove', label: 'Remove', danger: true, blocked: removeBlock }],
      reason,
      roleLocked,
    };
  }

  function teamConfirm(action, person) {
    const who = personIdentity(person).primary;
    const copy = {
      remove: {
        title: 'Remove from this agency?',
        confirm: 'Remove',
        danger: true,
        body: `Remove ${who} from this agency? Their pivitlab account stays, and any other agency they belong to is left as it is. They lose access here.`,
      },
      suspend: {
        title: 'Suspend this Viewer?',
        confirm: 'Suspend',
        danger: true,
        body: `Suspend sign-in for ${who}? They are signed out straight away and cannot sign in until you allow it again.`,
      },
      unsuspend: {
        title: 'Allow sign-in again?',
        confirm: 'Unsuspend',
        danger: false,
        body: `Allow ${who} to sign in again?`,
      },
      archive: {
        title: 'Archive this Viewer?',
        confirm: 'Archive',
        danger: true,
        body: `Archive ${who}? They disappear from lists in this agency. They can still sign in until you suspend them. You can restore them later.`,
      },
      restore: {
        title: 'Restore this Viewer?',
        confirm: 'Restore',
        danger: false,
        body: `Restore ${who}? They show in lists again.`,
      },
    };
    return copy[action] || null;
  }

  function teamDoneMessage(action) {
    return {
      remove: 'Removed from this agency. Their pivitlab account stays.',
      suspend: 'Viewer sign-in suspended.',
      unsuspend: 'Viewer sign-in allowed again.',
      archive: 'Archived. They stay hidden until you restore them.',
      restore: 'Restored.',
      edit: 'Viewer updated.',
      password: 'Password reset. It is shown once.',
      create: 'Viewer created. The password is shown once.',
      role: 'Role updated.',
    }[action] || '';
  }

  function filterTeamPeople(people, options) {
    const showArchived = !!(options && options.showArchived);
    return (people || []).filter((person) => person && (showArchived || !person.archived));
  }

  function teamSummary({ shown, archivedHidden } = {}) {
    const visible = Number(shown) || 0;
    const hidden = Number(archivedHidden) || 0;
    if (visible === 0 && hidden > 0) {
      return hidden === 1 ? '1 archived person is hidden.' : `${hidden} archived people are hidden.`;
    }
    if (visible === 0) return 'No one to show.';
    const noun = visible === 1 ? '1 person' : `${visible} people`;
    if (hidden > 0) {
      const extra = hidden === 1 ? '1 archived person is hidden.' : `${hidden} archived people are hidden.`;
      return `Showing ${noun}. ${extra}`;
    }
    return `Showing ${noun}.`;
  }

  function teamPeopleHint(canManage) {
    if (canManage) {
      return 'Change a role, or remove someone from this agency. Removing someone does not delete their pivitlab account. Viewers can be edited, suspended, archived or restored here.';
    }
    return 'You can see everyone in this agency. Only an Owner can make changes.';
  }

  function teamStatusNote(person) {
    if (!person || person.kind === 'viewer') return '';
    if (!person.suspended && !person.archived) return '';
    return 'A Platform admin manages their sign-in. You can remove them from this agency.';
  }

  function teamRoute(hash) {
    const text = String(hash || '');
    if (text === '#team' || text.startsWith('#team?')) return { page: 'team' };
    return null;
  }

  function teamFreshMessage(result) {
    const data = result || {};
    if (data.email_error) return String(data.email_error);
    if (data.resent === true) {
      return "We've emailed a new link. It replaces the previous one. The link is shown once.";
    }
    if (data.emailed === true) {
      return "We've emailed the invite. The link is shown once, in case you also want to copy it.";
    }
    return 'The link is shown once. It has not been emailed.';
  }

  function teamSentLabel(row) {
    return row && row.last_sent_at ? 'Emailed' : 'Link only';
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
    roleBadgeLabel,
    membershipWord,
    auditActorLabel,
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
    DOMAIN_IN_USE_WARNING,
    siteChoiceState,
    installCheckLine,
    clientLoginUrl,
    previewExampleUrl,
    shouldShowSignpost,
    isDemoTest,
    demoBadgeHtml,
    splitPillHtml,
    demoRuntimeNote,
    demoPlanHtml,
    AUDIT_PAGE_SIZE,
    auditActionLabel,
    auditDetailText,
    auditRoute,
    auditHash,
    auditQuery,
    auditPageLabel,
    USERS_GUARD_SELF,
    USERS_GUARD_LAST_ADMIN,
    USERS_GUARD_LAST_OWNER,
    personTypes,
    personTypeLabel,
    personStatusKeys,
    personStatusLabel,
    personIdentity,
    personActions,
    personDeleteBlock,
    personConfirm,
    personConfirmPhrase,
    personConfirmReady,
    personAccessPatch,
    personAccessPath,
    personRowKey,
    personDoneMessage,
    filterPeople,
    peopleAgencyOptions,
    hiddenArchivedCount,
    usersSummary,
    canOpenUsers,
    usersDeniedMessage,
    usersRoute,
    canManageTeam,
    canClearTestTraffic,
    canOpenTeam,
    teamDeniedMessage,
    teamRemoveBlock,
    teamRoleLocked,
    teamActions,
    teamConfirm,
    teamDoneMessage,
    filterTeamPeople,
    teamSummary,
    teamPeopleHint,
    teamStatusNote,
    teamRoute,
    teamFreshMessage,
    teamSentLabel,
  };
});
