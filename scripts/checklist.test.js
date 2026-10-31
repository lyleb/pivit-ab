// The first-run checklist ticks from real account data, and the dashboard
// keeps the experiments list on screen while the owner is still learning.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checklistFromFacts, STEP_IDS } = require('../src/checklist');
const ui = require('../public/admin-ui.js');

const empty = checklistFromFacts({});
assert.deepStrictEqual(empty.steps.map((step) => step.id), STEP_IDS);
assert.ok(empty.steps.every((step) => step.done === false));
assert.strictEqual(empty.complete, false);
assert.strictEqual(empty.dismissed, false);
assert.strictEqual(empty.visible, true);

const partial = checklistFromFacts({ hasSite: true, snippetSeen: true, hasTest: true });
assert.strictEqual(partial.visible, true);
assert.strictEqual(partial.complete, false);
assert.strictEqual(partial.steps.find((step) => step.id === 'preview').done, false);

const done = checklistFromFacts({
  hasSite: true,
  snippetSeen: true,
  hasTest: true,
  previewSeen: true,
  started: true,
});
assert.strictEqual(done.complete, true);
assert.strictEqual(done.visible, false);

const startedEarly = checklistFromFacts({ hasSite: true, hasTest: true, started: true });
assert.strictEqual(startedEarly.complete, false);
assert.strictEqual(startedEarly.visible, false);

const dismissed = checklistFromFacts({ hasSite: true, dismissed: true });
assert.strictEqual(dismissed.complete, false);
assert.strictEqual(dismissed.dismissed, true);
assert.strictEqual(dismissed.visible, false);

const both = checklistFromFacts({
  hasSite: true,
  snippetSeen: true,
  hasTest: true,
  previewSeen: true,
  started: true,
  dismissed: true,
});
assert.strictEqual(both.visible, false);

assert.strictEqual(ui.previewExampleUrl('example.co.uk'), 'https://example.co.uk/?pivit_qa=1');
assert.strictEqual(ui.previewExampleUrl('WWW.Example.co.uk'), 'https://example.co.uk/?pivit_qa=1');
assert.strictEqual(ui.previewExampleUrl(''), 'https://example.co.uk/?pivit_qa=1');
assert.strictEqual(ui.previewExampleUrl('javascript:alert(1)'), 'https://example.co.uk/?pivit_qa=1');
assert.strictEqual(ui.previewExampleUrl('example.co.uk/"><script>'), 'https://example.co.uk/?pivit_qa=1');

const dashboard = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const cardStart = dashboard.indexOf('id="first-run"');
const cardEnd = dashboard.indexOf('id="review-requests-card"');
assert.ok(cardStart > 0 && cardEnd > cardStart);
const card = dashboard.slice(cardStart, cardEnd);
for (const phrase of [
  'Start here',
  'Add a site and install the snippet',
  'Check it\'s been seen',
  'Create your first test',
  'Preview it',
  'Start it',
  '?pivit_qa=1',
  '?pivit_qa=0',
  'Hide checklist',
  'help.html#your-first-test',
  'You have a test saved. It stays a draft until you start it.',
  'You have a test, and it has been started.',
  'UI.installCheckLine',
  'UI.previewExampleUrl',
  'UI.gettingStartedState',
  'checklist.visible',
  '/api/setup/dismiss',
  'data-owner-step',
  'setup-wait',
  'is-waiting',
]) {
  assert.ok(dashboard.includes(phrase), phrase);
}
const fresh = ui.gettingStartedState({ steps: [] }, true);
assert.strictEqual(fresh.find((step) => step.id === 'site').waiting, '');
assert.strictEqual(fresh.find((step) => step.id === 'snippet').waiting, 'Available once you have added a site');
assert.strictEqual(fresh.find((step) => step.id === 'preview').waiting, 'Available once you have created a test');
assert.strictEqual(fresh.find((step) => step.id === 'started').href, '#status');
const afterSite = ui.gettingStartedState({
  steps: [
    { id: 'site', done: true },
    { id: 'snippet', done: false },
    { id: 'test', done: true },
    { id: 'preview', done: false },
    { id: 'started', done: false },
  ],
}, true);
assert.strictEqual(afterSite.find((step) => step.id === 'preview').waiting, 'Available once your snippet has been seen');
assert.strictEqual(afterSite.find((step) => step.id === 'started').waiting, 'Available once your snippet has been seen');
assert.strictEqual(afterSite.find((step) => step.id === 'test').waiting, '');
const memberSteps = ui.gettingStartedState({ steps: [{ id: 'site', done: true }] }, false);
assert.strictEqual(memberSteps.find((step) => step.id === 'site').hidden, true);
assert.strictEqual(memberSteps.find((step) => step.id === 'test').hidden, true);
assert.strictEqual(memberSteps.find((step) => step.id === 'started').hidden, true);
assert.strictEqual(memberSteps.find((step) => step.id === 'preview').hidden, false);
assert.strictEqual(memberSteps.find((step) => step.id === 'snippet').hidden, false);
assert.ok(card.includes('pivitlab'));
assert.ok(!card.includes('Pivit'));
assert.ok(!card.includes('behavior'));
assert.ok(!dashboard.includes('list.hidden = show'));
assert.ok(!dashboard.includes('id="step-check"'));

console.log('checklist tests passed');
