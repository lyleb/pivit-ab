// The steps note is plain text on the variant. Empty stays off the public
// payload. A sentence is shown as "Steps: …" in a preview.
const assert = require('assert');
const { STEPS_NOTE_MAX, normaliseStepsNote } = require('../src/steps-note');
const { buildPublicExperimentList } = require('../src/preview-access');
const runtime = require('../snippet/ab.js');

assert.strictEqual(STEPS_NOTE_MAX, 280);
assert.deepStrictEqual(normaliseStepsNote(undefined), { ok: true, omitted: true, value: '' });
assert.deepStrictEqual(normaliseStepsNote(null), { ok: true, omitted: false, value: '' });
assert.deepStrictEqual(normaliseStepsNote('  Click   Continue twice  '), {
  ok: true,
  omitted: false,
  value: 'Click Continue twice',
});
assert.strictEqual(normaliseStepsNote(12).ok, false);
assert.strictEqual(normaliseStepsNote('x'.repeat(281)).ok, false);
assert.strictEqual(normaliseStepsNote('x'.repeat(280)).ok, true);

const experiment = { id: 'e', name: 'Checkout', url_match: '/play', goals: [] };
function listed(note) {
  return buildPublicExperimentList({
    running: [experiment],
    variants: [{
      id: 'v',
      experiment_id: 'e',
      name: 'Offer',
      traffic_split: 100,
      enabled: true,
      changes: [],
      goals: [],
      steps_note: note,
    }],
  }).experiments[0].variants[0];
}

assert.strictEqual(listed('Click Continue twice').steps_note, 'Click Continue twice');
assert.strictEqual(listed('  Click   Continue twice ').steps_note, 'Click Continue twice');
assert.strictEqual(Object.prototype.hasOwnProperty.call(listed(''), 'steps_note'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(listed('   '), 'steps_note'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(listed(null), 'steps_note'), false);

assert.strictEqual(runtime.stepsNoteLabel('  Click Continue twice '), 'Steps: Click Continue twice');
assert.strictEqual(runtime.stepsNoteLabel(''), '');
assert.strictEqual(runtime.stepsNoteLabel(null), '');

const ids = {};
function makeEl(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    textContent: '',
    setAttribute(name, value) {
      if (name === 'id') node.id = String(value);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
  };
  let id = '';
  Object.defineProperty(node, 'id', {
    configurable: true,
    get() { return id; },
    set(value) {
      id = value || '';
      if (id) ids[id] = node;
    },
  });
  return node;
}
const body = makeEl('body');
const doc = {
  body,
  createElement: makeEl,
  getElementById(id) { return ids[id] || null; },
};
const mounted = runtime.mountStepsNote(doc, 'Click Continue twice');
assert.strictEqual(mounted.textContent, 'Steps: Click Continue twice');
assert.strictEqual(doc.getElementById('pivit-steps-note'), mounted);
runtime.mountStepsNote(doc, 'Click Continue twice');
assert.strictEqual(body.children.length, 1);
assert.strictEqual(runtime.mountStepsNote(doc, '  '), null);

console.log('steps-note.test.js ok');
