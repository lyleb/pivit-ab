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
  'Set up your first test',
  'Add your site',
  'Install the snippet',
  'Create your first test',
  'Preview with ?pivit_qa=1',
  'Start the test',
  '?pivit_qa=0',
  'Hide checklist',
  'You have a test saved. It stays a draft until you start it.',
  'You have a test, and it has been started.',
  'UI.installCheckLine',
  'UI.previewExampleUrl',
  'checklist.visible',
  '/api/setup/dismiss',
]) {
  assert.ok(dashboard.includes(phrase), phrase);
}
assert.ok(card.includes('pivitlab'));
assert.ok(!card.includes('Pivit'));
assert.ok(!card.includes('behavior'));
assert.ok(!dashboard.includes('list.hidden = show'));
assert.ok(!dashboard.includes('id="step-check"'));

console.log('checklist tests passed');
