// The undo stack lives in snippet/editor.js so the editor does not need a
// second script. Tests load that same block.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../snippet/editor.js'), 'utf8');
const start = src.indexOf('function cloneEditorState(');
const end = src.indexOf('/* end editor history */');
if (start < 0 || end < start) {
  throw new Error('editor history block missing from snippet/editor.js');
}

const sandbox = { JSON, Number, Array, Object };
vm.runInNewContext(
  `${src.slice(start, end)}\nthis.api = { cloneEditorState, sameEditorState, createEditorHistory };`,
  sandbox,
  { filename: 'editor-history.js' }
);

module.exports = sandbox.api;
