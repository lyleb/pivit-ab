// Whole-page CSS and JavaScript are accepted change types. Element HTML,
// CSS (stylesheet) and JS stay on the list they already used.
const assert = require('assert');
const { CHANGE_TYPES, validateChanges } = require('../src/changes');

const elementChanges = [
  { selector: '#cta', type: 'text', value: 'Buy' },
  { selector: '#cta', type: 'html', value: '<b>Buy</b>' },
  { selector: '#cta', type: 'hide' },
  { selector: '#cta', type: 'show' },
  { selector: '#cta', type: 'style', value: { color: 'red' } },
  { selector: 'a.buy', type: 'attr', attr: 'href', value: '/checkout' },
  { selector: '#cta', type: 'js', value: 'el.dataset.ready = "1"' },
  { selector: '#cta', type: 'remove' },
  { selector: '#cta', type: 'duplicate' },
  { selector: '#cta', type: 'insert_before', value: '<p>Above</p>' },
  { selector: '#cta', type: 'insert_after', value: '<p>Below</p>' },
  { selector: '#cta', type: 'replace', value: '<a id="cta">Buy</a>' },
  { selector: '#cta', type: 'stylesheet', value: '#cta{color:red}' },
];

assert.strictEqual(validateChanges(elementChanges), null);
assert.strictEqual(validateChanges([
  ...elementChanges,
  { type: 'page_css', value: 'body{margin:0}' },
  { type: 'page_js', value: 'document.documentElement.classList.add("pivit-offer")' },
]), null);
assert.strictEqual(validateChanges(undefined), null);
assert.strictEqual(validateChanges(null), null);
assert.strictEqual(validateChanges([]), null);
assert.strictEqual(validateChanges('nope'), 'changes must be an array');
assert.strictEqual(validateChanges([null]), 'each change must be an object');
assert.strictEqual(validateChanges([{ type: 'made_up' }]), 'unknown change type "made_up"');
assert.ok(CHANGE_TYPES.indexOf('page_css') !== -1);
assert.ok(CHANGE_TYPES.indexOf('page_js') !== -1);
assert.ok(CHANGE_TYPES.indexOf('html') !== -1);
assert.ok(CHANGE_TYPES.indexOf('js') !== -1);
assert.ok(CHANGE_TYPES.indexOf('stylesheet') !== -1);

console.log('page-changes.test.js ok');
