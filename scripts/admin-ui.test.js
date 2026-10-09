const assert = require('assert');
const ui = require('../public/admin-ui.js');

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
assert.ok(planner.includes('Advanced'));
assert.ok(!planner.includes('MDE'));
assert.ok(planner.includes('id="wizard-plan-sentence"'));

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
  'Support view: see another customer\'s account read-only. Every view is logged.'
);
assert.ok(ui.supportViewCopy(true, 'Acme').includes('Acme'));
assert.ok(ui.supportViewCopy(true, 'Acme').includes('read-only'));
assert.strictEqual(ui.showOwnerPasswordBanner(true, false), true);
assert.strictEqual(ui.showOwnerPasswordBanner(true, true), false);
assert.strictEqual(ui.showOwnerPasswordBanner(false, false), false);
assert.ok(ui.OWNER_PASSWORD_BANNER.includes('owner password'));
assert.ok(!ui.OWNER_PASSWORD_BANNER.includes('emergency'));

assert.strictEqual(ui.shortVariantLabel('variant-b'), 'B');
assert.strictEqual(ui.shortVariantLabel('Control'), 'Control');
assert.strictEqual(ui.shortVariantLabel('Homepage hero'), 'Homepage hero');
assert.strictEqual(ui.shortUrl('https://cantsaythat.co.uk/about'), 'cantsaythat.co.uk/about');
assert.strictEqual(ui.describeGoal({ type: 'click', selector: '.hero-cta', id: 'CTA click' }), 'CTA click → .hero-cta');
assert.strictEqual(ui.describeGoal({ type: 'click', selector: '.hero-cta', id: 'g_abc', name: 'Buy button' }), 'Buy button → .hero-cta');
assert.strictEqual(ui.describeGoal({ type: 'url', url_match: '/checkout', id: 'g_1', name: 'Checkout', match: 'exact' }), 'Checkout → URL is exactly /checkout');
assert.strictEqual(ui.describeGoal({ type: 'url', url_match: '/thanks', id: 'thanks' }), 'thanks → URL contains /thanks');

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

console.log('admin-ui tests passed');
