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
assert.strictEqual(ui.signalText('running', { total_visitors: 10, low_sample_warning: true, stats: bayesLead.stats }), 'Collecting data');
assert.strictEqual(ui.signalText('running', bayesLead), 'B leading · 68% prob. best');
assert.strictEqual(ui.signalText('paused', { total_visitors: 0, stats: [] }), 'Paused · last: Control');
assert.strictEqual(ui.signalText('paused', bayesLead), 'Paused · last: variant-b');
assert.strictEqual(ui.signalText('archived', { total_visitors: 0, stats: [] }), 'No data yet');
assert.strictEqual(ui.signalText('archived', bayesLead), 'Archived · last: variant-b');

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
