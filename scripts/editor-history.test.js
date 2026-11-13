// Undo and redo for the visual editor. The stack lives in snippet/editor.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEditorHistory } = require('../src/editor-history');

const editor = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
assert.ok(editor.includes('function createEditorHistory'));
assert.ok(editor.includes('pivit-undo'));
assert.ok(editor.includes('pivit-redo'));
assert.ok(editor.includes('Reset this variant'));
assert.ok(editor.includes('Remove all changes'));
assert.ok(editor.includes('event.metaKey || event.ctrlKey'));
assert.ok(editor.includes('event.shiftKey'));
assert.ok(editor.includes('This will change the live test for visitors now.'));
assert.ok(editor.includes('Unsaved changes'));
assert.ok(editor.includes('Saving…'));
assert.ok(editor.includes('Save failed'));
assert.ok(editor.includes('pivit-save-retry'));
assert.ok(editor.includes('localStorage'));
assert.ok(editor.includes("return 'Live'"));
assert.ok(editor.includes("return 'Draft'"));

const text = { selector: 'h1', type: 'text', value: 'Pay now' };
const style = { selector: 'h1', type: 'style', value: 'color: red' };
const inserted = { selector: 'h1', type: 'insert_after', value: '<p>Hello</p>' };

const history = createEditorHistory({ changes: [], goals: [] });
assert.strictEqual(history.canUndo(), false);
assert.strictEqual(history.canRedo(), false);
assert.strictEqual(history.push({ changes: [], goals: [] }), false);

assert.strictEqual(history.push({ changes: [text], goals: [] }), true);
assert.strictEqual(history.push({ changes: [text, style], goals: [] }), true);
assert.strictEqual(history.push({ changes: [text, style, inserted], goals: [] }), true);
assert.strictEqual(history.canUndo(), true);

const undone = history.undo();
assert.deepStrictEqual(undone.changes.map((change) => change.type), ['text', 'style']);
assert.strictEqual(history.canRedo(), true);
const redone = history.redo();
assert.deepStrictEqual(redone.changes.map((change) => change.type), ['text', 'style', 'insert_after']);

history.undo();
assert.strictEqual(history.push({ changes: [text], goals: [{ id: 'g', type: 'click' }] }), true);
assert.strictEqual(history.canRedo(), false);
assert.strictEqual(history.current().goals[0].id, 'g');

const saved = history.toJSON();
const restored = createEditorHistory(null, saved);
assert.deepStrictEqual(restored.current(), history.current());
assert.strictEqual(restored.canUndo(), true);
restored.undo();
assert.deepStrictEqual(restored.current().changes.map((change) => change.type), ['text', 'style']);

const capped = createEditorHistory({ changes: [], goals: [] });
for (let i = 0; i < 60; i += 1) {
  capped.push({ changes: [{ type: 'text', value: String(i) }], goals: [] });
}
let steps = 0;
while (capped.canUndo()) {
  capped.undo();
  steps += 1;
}
assert.strictEqual(steps, 50);
assert.strictEqual(capped.current().changes[0].value, '9');

console.log('editor history tests passed');
