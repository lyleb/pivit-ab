const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');
const plan = require('../src/plan');

const bayesLead = {
  total_visitors: 240,
  low_sample_warning: false,
  stats: [
    { variant_name: 'Control', probability_best: 32 },
    { variant_name: 'variant-b', probability_best: 68 },
  ],
};

assert.strictEqual(ui.signalText('draft', null), 'No data yet');
assert.strictEqual(ui.signalText('draft', bayesLead), 'No data yet');
assert.strictEqual(ui.signalText('running', { total_visitors: 0, stats: [] }), 'No data yet');
assert.strictEqual(ui.signalText('running', { total_visitors: 10, low_sample_warning: true, stats: bayesLead.stats }), 'Health check');
assert.strictEqual(ui.signalText('running', bayesLead), 'Health check');
assert.strictEqual(ui.signalText('running', { mode: 'blind', days_elapsed: 3, min_runtime_days: 14 }), 'Health check · 3 of 14 days');
assert.strictEqual(ui.signalText('running', { mode: 'unplanned' }), 'Set a plan');
assert.strictEqual(ui.signalText('running', { mode: 'verdict' }), 'Verdict ready');
assert.strictEqual(ui.signalText('running', { mode: 'peeked' }), 'Peeked · not a verdict');
assert.strictEqual(ui.signalText('running', { mode: 'data_problem' }), 'Data problem');
assert.ok(!ui.signalText('running', bayesLead).includes('prob'));
assert.strictEqual(ui.signalText('paused', { total_visitors: 0, stats: [] }), 'Paused · last: Control');
assert.strictEqual(ui.signalText('paused', bayesLead), 'Paused');
assert.strictEqual(ui.signalText('archived', { total_visitors: 0, stats: [] }), 'No data yet');
assert.strictEqual(ui.signalText('archived', bayesLead), 'Archived');

const planner = ui.plannerShell('wizard');
assert.ok(planner.includes('Small change'));
assert.ok(planner.includes('Medium'));
assert.ok(planner.includes('Big'));
assert.ok(planner.includes('Custom'));
assert.ok(planner.includes('your own figures'));
assert.ok(planner.includes('about 5% relative'));
assert.ok(planner.includes('class="choice-grid"'));
assert.ok(planner.includes('class="choice-label"'));
assert.ok(planner.includes('class="choice-hint"'));
const smallChoice = planner.match(/data-plan-choice="small"[^>]*>[\s\S]*?<\/button>/);
assert.ok(smallChoice);
assert.ok(smallChoice[0].indexOf('choice-label') < smallChoice[0].indexOf('choice-hint'));
assert.ok(smallChoice[0].indexOf('Small change') < smallChoice[0].indexOf('about 5% relative'));
assert.ok(planner.includes('Advanced'));
assert.ok(!planner.includes('MDE'));
assert.ok(planner.includes('id="wizard-plan-sentence"'));
assert.ok(planner.includes('<details class="plan-more">'));
assert.ok(!planner.includes('<details class="plan-more" open'));
assert.ok(planner.includes('>More info</summary>'));
assert.ok(planner.includes('flipping a coin'));
assert.ok(planner.includes('pivitlab reads the result once, at the planned sample'));
assert.ok(!planner.includes('Pivitlab'));
assert.ok(!planner.includes('PivitLab'));
assert.ok(planner.includes('id="wizard-site-examples"'));
assert.ok(planner.includes('Assumed baseline conversion rate'));
assert.ok(planner.includes('not the relative change'));
assert.ok(planner.includes('not the baseline conversion rate'));
assert.ok(!planner.includes('MDE'));
assert.ok(!planner.includes("You'll need about"));

const adminPage = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(adminPage.includes('.choice {'));
assert.ok(adminPage.includes('flex-direction: column'));
assert.ok(adminPage.includes('.choice .choice-label'));
assert.ok(adminPage.includes('.choice .choice-hint'));
assert.ok(adminPage.includes('.choice:focus-visible'));
assert.ok(adminPage.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'));
assert.ok(adminPage.includes('@media (max-width: 720px)'));
assert.ok(adminPage.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
assert.ok(adminPage.includes('@media (max-width: 380px)'));
assert.ok(adminPage.includes('grid-template-columns: minmax(0, 1fr)'));
const planScript = adminPage.indexOf('src="/plan.js"');
const uiScript = adminPage.indexOf('src="/admin-ui.js"');
assert.ok(planScript > -1 && uiScript > planScript);

function assertGuideMatchesEngine(input) {
  const shown = ui.trafficGuideHtml(input);
  assert.ok(shown.includes('250–1,000'));
  assert.ok(!shown.includes('MDE'));
  plan.SITE_SIZE_EXAMPLES.forEach((band) => {
    const direct = plan.buildPlan(Object.assign({}, input, { weekly_traffic: band.weekly_traffic }));
    assert.strictEqual(direct.ok, true, direct.error);
    assert.ok(shown.includes(ui.escapeHtml(direct.plan.sentence)), direct.plan.sentence);
    assert.ok(shown.includes(direct.plan.visitors_per_variant.toLocaleString('en-GB')));
    assert.ok(shown.includes(band.weekly_traffic.toLocaleString('en-GB')));
    const fromEngine = plan.siteDurationExamples(input).find((row) => row.id === band.id);
    assert.strictEqual(fromEngine.visitors_per_variant, direct.plan.visitors_per_variant);
    assert.strictEqual(fromEngine.estimated_weeks, direct.plan.estimated_weeks);
    assert.strictEqual(fromEngine.sentence, direct.plan.sentence);
  });
  return shown;
}

const guideInput = {
  baseline_rate: 0.03,
  relative_effect: 0.1,
  effect_choice: 'medium',
  min_runtime_days: 14,
  variant_count: 2,
};
const mediumGuide = assertGuideMatchesEngine(guideInput);
const biggerChange = assertGuideMatchesEngine(Object.assign({}, guideInput, {
  relative_effect: 0.2,
  effect_choice: 'big',
}));
assert.notStrictEqual(mediumGuide, biggerChange);
const threeGuide = ui.trafficGuideHtml(Object.assign({}, guideInput, { variant_count: 3 }));
const threeDirect = plan.buildPlan(Object.assign({}, guideInput, {
  variant_count: 3,
  weekly_traffic: plan.SITE_SIZE_EXAMPLES[0].weekly_traffic,
}));
assert.ok(threeGuide.includes(ui.escapeHtml(threeDirect.plan.sentence)));
assert.ok(!ui.trafficGuideHtml({ baseline_rate: 0, relative_effect: 0.1 }).includes("You'll need about"));

assert.strictEqual(ui.resultsGated('draft', 0), true);
assert.strictEqual(ui.resultsGated('draft', 12), true);
assert.strictEqual(ui.resultsGated('running', 0), true);
assert.strictEqual(ui.resultsGated('paused', 0), true);
assert.strictEqual(ui.resultsGated('running', 4), false);
assert.strictEqual(ui.resultsGated('paused', 4), false);
assert.strictEqual(ui.resultsGated('archived', 4), false);

assert.strictEqual(ui.overviewBanner('draft', 0).show, true);
assert.strictEqual(ui.overviewBanner('running', 0).show, true);
assert.strictEqual(ui.overviewBanner('running', 8).show, false);
assert.strictEqual(ui.showNextSteps('draft', 20), true);
assert.strictEqual(ui.showNextSteps('running', 0), true);
assert.strictEqual(ui.showNextSteps('running', 3), false);

assert.deepStrictEqual(ui.statusAction('draft'), { label: 'Start experiment', next: 'running' });
assert.deepStrictEqual(ui.statusAction('running'), { label: 'Pause', next: 'paused' });
assert.deepStrictEqual(ui.statusAction('paused'), { label: 'Resume', next: 'running' });
assert.strictEqual(ui.statusAction('archived'), null);
assert.notStrictEqual(ui.statusAction('draft').next, 'archived');
assert.notStrictEqual(ui.statusAction('running').next, 'archived');
assert.notStrictEqual(ui.statusAction('paused').next, 'archived');
assert.strictEqual(ui.displayedStatus('running', null, 10), 'running');
assert.strictEqual(ui.displayedStatus('running', { status: 'paused', at: 200 }, 100), 'paused');
assert.strictEqual(ui.displayedStatus('paused', { status: 'paused', at: 200 }, 100), 'paused');
assert.strictEqual(ui.displayedStatus('running', { status: 'paused', at: 100 }, 200), 'running');
assert.strictEqual(ui.plannerChoice(5), 'small');
assert.strictEqual(ui.plannerChoice(10), 'medium');
assert.strictEqual(ui.plannerChoice(20), 'big');
assert.strictEqual(ui.plannerChoice(15), 'custom');
assert.strictEqual(ui.plannerChoice(''), 'custom');
assert.strictEqual(ui.plannerSelectionAfterEdit('relative', 15), 'custom');
assert.strictEqual(ui.plannerSelectionAfterEdit('relative', 10), 'medium');
assert.strictEqual(ui.plannerSelectionAfterEdit('baseline', 10), 'custom');
assert.strictEqual(ui.plannerSelectionAfterEdit('weekly', 10), 'custom');
assert.strictEqual(ui.plannerSelectionAfterEdit('weeks', 5), 'custom');
assert.strictEqual(ui.showSupportBar({ superadmin: true, viewing: false, otherAccounts: 0 }), false);
assert.strictEqual(ui.showSupportBar({ superadmin: true, viewing: false, otherAccounts: 1 }), true);
assert.strictEqual(ui.showSupportBar({ superadmin: false, viewing: false, otherAccounts: 2 }), false);
assert.strictEqual(ui.showSupportBar({ superadmin: true, viewing: true, otherAccounts: 0 }), true);
assert.strictEqual(
  ui.supportViewCopy(false),
  'Support view: see another agency read-only. Every view is logged.'
);
assert.ok(ui.supportViewCopy(true, '').includes('this agency'));
assert.strictEqual(ui.roleBadgeLabel({ superadmin: true }), 'Platform admin');
assert.strictEqual(ui.roleBadgeLabel({ superadmin: true, membership: 'member' }), 'Platform admin');
assert.strictEqual(ui.roleBadgeLabel({ membership: 'owner' }), 'Owner');
assert.strictEqual(ui.roleBadgeLabel({ membership: 'member' }), 'Member');
assert.strictEqual(ui.roleBadgeLabel({ viewer: true }), 'Viewer');
assert.strictEqual(ui.auditActorLabel('superadmin'), 'Platform admin');
assert.strictEqual(ui.auditActorLabel('client'), 'Viewer');
assert.strictEqual(ui.auditActorLabel('ada@example.co.uk'), 'ada@example.co.uk');
assert.strictEqual(ui.membershipWord('owner'), 'Owner');
assert.strictEqual(ui.membershipWord('member'), 'Member');
assert.ok(ui.supportViewCopy(true, 'Acme').includes('Acme'));
assert.ok(ui.supportViewCopy(true, 'Acme').includes('read-only'));
assert.strictEqual(ui.showOwnerPasswordBanner(true, false), true);
assert.strictEqual(ui.showOwnerPasswordBanner(true, true), false);
assert.strictEqual(ui.showOwnerPasswordBanner(false, false), false);
assert.ok(ui.OWNER_PASSWORD_BANNER.includes('owner password'));
assert.ok(ui.OWNER_PASSWORD_BANNER.includes('info@heclr.com'));
assert.ok(ui.OWNER_PASSWORD_BANNER.includes('fallback'));
assert.ok(!ui.OWNER_PASSWORD_BANNER.includes('emergency'));
assert.ok(!ui.OWNER_PASSWORD_BANNER.includes('Once email sign-in is set up'));

assert.strictEqual(ui.shortVariantLabel('variant-b'), 'B');
assert.strictEqual(ui.shortVariantLabel('Control'), 'Control');
assert.strictEqual(ui.shortVariantLabel('Homepage hero'), 'Homepage hero');
assert.strictEqual(ui.shortUrl('https://cantsaythat.co.uk/about'), 'cantsaythat.co.uk/about');
assert.strictEqual(ui.describeGoal({ type: 'click', selector: '.hero-cta', id: 'CTA click' }), 'CTA click → .hero-cta');
assert.strictEqual(ui.describeGoal({ type: 'click', selector: '.hero-cta', id: 'g_abc', name: 'Buy button' }), 'Buy button → .hero-cta');
assert.strictEqual(ui.describeGoal({ type: 'url', url_match: '/checkout', id: 'g_1', name: 'Checkout', match: 'exact' }), 'Checkout → URL is exactly /checkout');
assert.strictEqual(ui.describeGoal({ type: 'url', url_match: '/thanks', id: 'thanks' }), 'thanks → URL contains /thanks');
assert.strictEqual(ui.describeGoal({ type: 'element', selector: '#step-confirmation', name: 'Confirmation' }), 'Confirmation → element appears #step-confirmation');
assert.strictEqual(
  ui.goalResultLabel({ type: 'element', label: 'Confirmation', detail: '#step-confirmation', key: 'done' }),
  'Confirmation · Element appears #step-confirmation'
);
assert.strictEqual(
  ui.goalResultLabel({ type: 'custom', label: 'Paid', detail: 'payment_complete', key: 'paid' }),
  'Paid · Custom event payment_complete'
);
assert.strictEqual(
  ui.goalResultLabel({
    type: 'custom',
    label: 'Paid',
    detail: 'checkout_step',
    when: [{ key: 'step_name', value: 'confirmation' }],
  }),
  'Paid · Custom event checkout_step where step_name = confirmation'
);
assert.strictEqual(
  ui.goalResultLabel({
    type: 'custom',
    label: 'Paid',
    detail: 'checkout_step',
    when: [{ key: 'step_name', value: 'confirmation' }, { key: 'step', value: '4' }],
  }),
  'Paid · Custom event checkout_step where step_name = confirmation and step = 4'
);
assert.strictEqual(ui.goalResultLabel({ type: 'custom', label: 'Custom event', detail: 'payment_complete' }), 'Custom event payment_complete');
assert.strictEqual(ui.describeGoal({ type: 'custom', name: 'Paid', event: 'payment_complete' }), 'Paid → custom event payment_complete');
assert.strictEqual(ui.describeGoal({ type: 'custom', name: 'Details', event: 'checkout_step', step: 2 }), 'Details → custom event checkout_step · funnel step 2');
const funnelHtml = ui.renderFunnel({
  activation_delays: true,
  baseline_step: 3,
  steps: [
    { step: 1, key: 'basket', label: 'Basket' },
    { step: 2, key: 'details', label: 'Details' },
    { step: 3, key: 'payment', label: 'Payment' },
  ],
  variants: [{
    variant_name: 'Control',
    steps: [
      { step: 1, label: 'Basket', visitors: null, unmeasured: true, rate_of_step_1: null, drop_off: null },
      { step: 2, label: 'Details', visitors: null, unmeasured: true, rate_of_step_1: null, drop_off: null },
      { step: 3, label: 'Payment', visitors: 4, unmeasured: false, rate_of_step_1: 100, drop_off: null },
    ],
  }],
}, { kind: 'owner' });
assert.ok(funnelHtml.includes('No variant data'));
assert.ok(funnelHtml.includes('Details'));
assert.ok(funnelHtml.includes('Not counted. Visitors were not in a variant yet.'));
assert.ok(funnelHtml.includes('Include test traffic'));
assert.ok(funnelHtml.includes('of step 3'));
assert.ok(!funnelHtml.includes('100% drop-off'));
assert.strictEqual(ui.renderFunnel({ steps: [] }, { kind: 'viewer' }), '');
assert.strictEqual(
  ui.describeGoal({
    type: 'custom',
    name: 'Paid',
    event: 'checkout_step',
    when: [{ key: 'step_name', value: 'confirmation' }],
  }),
  'Paid → custom event checkout_step where step_name = confirmation'
);
assert.ok(ui.CUSTOM_GOAL_HELP.includes('Only when…'));
assert.ok(ui.CUSTOM_GOAL_HELP.includes('step_name'));
assert.ok(ui.CUSTOM_GOAL_HELP.includes('pivitlab'));
assert.ok(ui.CUSTOM_GOAL_HELP.includes('payment_complete'));
assert.ok(ui.CUSTOM_GOAL_HELP.includes('window.pivit = window.pivit || []'));
assert.ok(!ui.CUSTOM_GOAL_HELP.includes('Pivitlab'));
assert.strictEqual(ui.auditActionLabel('datalayer_events'), 'Updated dataLayer events');
assert.strictEqual(ui.goalResultLabel({ type: 'click', label: 'Buy button', detail: '.buy' }), 'Buy button · Click .buy');
assert.strictEqual(ui.goalResultLabel({ type: 'url', label: 'Thanks', detail: '/thanks' }), 'Thanks · Visited a URL /thanks');
assert.ok(ui.ELEMENT_GOAL_HELP.includes('pivitlab'));
assert.ok(ui.ELEMENT_GOAL_HELP.includes('#step-confirmation'));
assert.ok(ui.ELEMENT_GOAL_HELP.includes('The address does not have to change.'));
assert.ok(!ui.ELEMENT_GOAL_HELP.includes('Pivitlab'));

assert.strictEqual(ui.canAddVariant(2), true);
assert.strictEqual(ui.canAddVariant(3), false);
assert.strictEqual(ui.canAddVariant(4), false);
assert.strictEqual(ui.variantCapMessage(2), '');
assert.strictEqual(ui.variantCapMessage(3), 'A test can have at most 3 variants, including Control.');
assert.ok(ui.variantCapMessage(5).includes('still run'));

const healthHtml = ui.renderHealth({
  show: true,
  checks: [
    { state: 'green', title: 'Traffic split', detail: 'The traffic split matches the weights you set.' },
    { state: 'red', title: 'Goals', detail: 'These variants do not measure the same goals.' },
  ],
});
assert.ok(healthHtml.includes('health-card green'));
assert.ok(healthHtml.includes('health-card red'));
assert.ok(healthHtml.includes('The traffic split matches the weights you set.'));
assert.strictEqual(ui.renderHealth({ show: false, checks: [] }), '');
assert.strictEqual(ui.escapeHtml(`<b class="x">'`), '&lt;b class=&quot;x&quot;&gt;&#39;');

const here = 'https://pivit.click';
assert.strictEqual(ui.displayOrigin('https://pivitlab.com', here), 'https://pivitlab.com');
assert.strictEqual(ui.displayOrigin('https://pivitlab.com/', here), 'https://pivitlab.com');
assert.strictEqual(ui.displayOrigin('  https://pivitlab.com///  ', here), 'https://pivitlab.com');
assert.strictEqual(ui.displayOrigin(null, here), here);
assert.strictEqual(ui.displayOrigin(undefined, here), here);
assert.strictEqual(ui.displayOrigin('', here), here);
assert.strictEqual(ui.displayOrigin('   ', here), here);
assert.strictEqual(ui.displayOrigin('https://pivitlab.com/snippet', here), here);
assert.strictEqual(ui.displayOrigin('https://user:pass@pivitlab.com', here), here);
assert.strictEqual(ui.displayOrigin('javascript:alert(1)', here), here);
assert.strictEqual(ui.displayOrigin('pivitlab.com', here), here);
assert.strictEqual(ui.displayOrigin('https://evil.com"', here), here);
assert.strictEqual(ui.displayOrigin('https://pivitlab.com:443', here), 'https://pivitlab.com');
assert.strictEqual(ui.displayOrigin('http://localhost:3000/', here), 'http://localhost:3000');

assert.strictEqual(
  ui.snippetTag(ui.displayOrigin('https://pivitlab.com', here)),
  '<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com"></script>'
);
assert.strictEqual(
  ui.snippetTag(ui.displayOrigin(null, here)),
  '<script src="https://pivit.click/snippet/ab.js" data-api="https://pivit.click"></script>'
);
assert.strictEqual(
  ui.clientLoginUrl(ui.displayOrigin('https://pivitlab.com/', here)),
  'https://pivitlab.com/login.html?role=client'
);
assert.strictEqual(
  ui.clientLoginUrl(ui.displayOrigin(null, here)),
  'https://pivit.click/login.html?role=client'
);

assert.strictEqual(ui.shouldShowSignpost(true, null), true);
assert.strictEqual(ui.shouldShowSignpost(true, ''), true);
assert.strictEqual(ui.shouldShowSignpost(true, '0'), true);
assert.strictEqual(ui.shouldShowSignpost(true, '1'), false);
assert.strictEqual(ui.shouldShowSignpost(false, null), false);
assert.strictEqual(ui.shouldShowSignpost(false, '1'), false);

const fernhill = [
  { id: 'site2', domains: ['site2-spa.netlify.app'] },
  { id: 'site3', domains: ['site3-checkout.netlify.app'] },
];
assert.strictEqual(ui.wizardSiteValue(fernhill, ''), '');
assert.strictEqual(ui.wizardSiteValue(fernhill, 'site3'), 'site3');
assert.strictEqual(ui.wizardSiteValue([{ id: 'only' }], ''), 'only');
assert.strictEqual(ui.wizardSiteValue(fernhill, 'missing'), '');
const mismatch = ui.domainMismatchMessage(
  'https://site2-spa.netlify.app/shop',
  ['site3-checkout.netlify.app']
);
assert.ok(mismatch.includes('site2-spa.netlify.app'));
assert.ok(mismatch.includes('site3-checkout.netlify.app'));
assert.ok(mismatch.includes('Choose the site'));
const lockedMismatch = ui.domainMismatchMessage(
  'https://site2-spa.netlify.app/',
  ['site3-checkout.netlify.app'],
  { locked: true }
);
assert.ok(lockedMismatch.includes('Create it again'));
assert.ok(!lockedMismatch.includes('Choose the site that owns'));
assert.strictEqual(ui.domainMismatchMessage('https://www.site3-checkout.netlify.app/play', ['site3-checkout.netlify.app']), '');
assert.strictEqual(ui.domainMismatchMessage('/play', ['site3-checkout.netlify.app']), '');
assert.strictEqual(ui.wizardContinueDecision({ step: 1, busy: true }, 1000).ok, false);
assert.strictEqual(ui.wizardContinueDecision({ step: 1, busy: false, advancedAt: 1000 }, 1200).reason, 'guard');
const forward = ui.wizardContinueDecision({ step: 1, busy: false, advancedAt: 0 }, 5000);
assert.strictEqual(forward.ok, true);
assert.strictEqual(forward.step, 2);
assert.strictEqual(forward.step - forward.from, 1);
assert.strictEqual(ui.wizardContinueDecision({ step: 2, busy: false }, 0).step, 3);
assert.strictEqual(ui.wizardContinueDecision({ step: 4, busy: false }, 0).step, 5);
assert.strictEqual(ui.wizardContinueDecision({ step: 5, busy: false }, 0).reason, 'save');
assert.strictEqual(ui.wizardContinueDecision({ step: 5, busy: false }, 0).step, 5);
const dashboard = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.strictEqual(dashboard.split("getElementById('wizard-next').addEventListener").length - 1, 1);
assert.ok(dashboard.includes('stopImmediatePropagation'));
assert.ok(dashboard.includes('wizardContinueDecision'));
assert.ok(dashboard.includes('id="wizard-site-mismatch"'));
assert.ok(dashboard.includes('id="settings-site-mismatch"'));
assert.ok(dashboard.includes("next.textContent = 'Save as draft'"));
assert.ok(!dashboard.includes("next.textContent = 'Save plan'"));
assert.ok(dashboard.includes('>Save sample-size plan</button>'));
assert.ok(!dashboard.includes('>Save plan</button>'));

console.log('admin-ui tests passed');
