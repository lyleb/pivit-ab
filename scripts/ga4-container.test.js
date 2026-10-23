// The Tag Manager import file is an export-format version 2 container.
// It carries the five Data Layer Variables, one Custom Event trigger, and
// one GA4 Event tag. It does not add a Google tag.
const assert = require('assert');
const {
  EVENT_NAME,
  TAG_NAME,
  PLACEHOLDER_VARIABLE,
  PLACEHOLDER_VALUE,
  FIELDS,
  buildGtmContainer,
} = require('../src/ga4-container');

function param(entity, key) {
  return (entity.parameter || []).find((item) => item.key === key);
}

function layerKey(variable) {
  const name = param(variable, 'name');
  return name ? name.value : '';
}

const stamped = buildGtmContainer('g-test1234', new Date('2026-10-23T14:05:06Z'));
assert.strictEqual(stamped.exportFormatVersion, 2);
assert.strictEqual(stamped.exportTime, '2026-10-23 14:05:06');
assert.ok(stamped.containerVersion);
assert.deepStrictEqual(stamped.containerVersion.container.usageContext, ['WEB']);
assert.strictEqual(stamped.containerVersion.container.name, 'pivitlab');
assert.ok(!JSON.stringify(stamped).includes('Pivitlab'));

const version = stamped.containerVersion;
assert.strictEqual(version.tag.length, 1);
assert.strictEqual(version.trigger.length, 1);
assert.strictEqual(version.variable.length, FIELDS.length);
assert.ok(!version.tag.some((tag) => tag.type === 'googtag' || tag.type === 'gaawc'));
assert.ok(!JSON.stringify(version.tag).includes('"type":"googtag"'));

const variables = version.variable;
assert.deepStrictEqual(variables.map((item) => item.name), FIELDS);
variables.forEach((variable) => {
  assert.strictEqual(variable.type, 'v');
  assert.strictEqual(param(variable, 'dataLayerVersion').type, 'INTEGER');
  assert.strictEqual(param(variable, 'dataLayerVersion').value, '2');
  assert.strictEqual(param(variable, 'name').type, 'TEMPLATE');
  assert.strictEqual(layerKey(variable), variable.name);
});
assert.ok(!variables.some((item) => item.name === PLACEHOLDER_VARIABLE));

const trigger = version.trigger[0];
assert.strictEqual(trigger.type, 'CUSTOM_EVENT');
assert.strictEqual(trigger.customEventFilter[0].type, 'EQUALS');
const filter = trigger.customEventFilter[0].parameter;
assert.strictEqual(filter[0].value, '{{_event}}');
assert.strictEqual(filter[1].value, EVENT_NAME);

const tag = version.tag[0];
assert.strictEqual(tag.name, TAG_NAME);
assert.strictEqual(tag.type, 'gaawe');
assert.strictEqual(tag.tagFiringOption, 'ONCE_PER_EVENT');
assert.deepStrictEqual(tag.firingTriggerId, [trigger.triggerId]);
assert.strictEqual(param(tag, 'eventName').value, EVENT_NAME);
assert.strictEqual(param(tag, 'measurementIdOverride').type, 'TEMPLATE');
assert.strictEqual(param(tag, 'measurementIdOverride').value, 'G-TEST1234');
assert.notStrictEqual(param(tag, 'measurementIdOverride').value, '');
const table = param(tag, 'eventSettingsTable');
assert.strictEqual(table.type, 'LIST');
const mapped = table.list.map((row) => {
  const name = row.map.find((item) => item.key === 'parameter').value;
  const value = row.map.find((item) => item.key === 'parameterValue').value;
  return [name, value];
});
assert.deepStrictEqual(mapped, FIELDS.map((name) => [name, `{{${name}}}`]));

const empty = buildGtmContainer('', new Date('2026-10-23T14:05:06Z'));
const blank = buildGtmContainer('UA-123', new Date('2026-10-23T14:05:06Z'));
for (const file of [empty, blank]) {
  const holder = file.containerVersion.variable.find((item) => item.type === 'c');
  assert.ok(holder, 'missing placeholder variable');
  assert.strictEqual(holder.name, PLACEHOLDER_VARIABLE);
  assert.strictEqual(param(holder, 'value').value, PLACEHOLDER_VALUE);
  const eventTag = file.containerVersion.tag[0];
  assert.strictEqual(param(eventTag, 'measurementIdOverride').value, `{{${PLACEHOLDER_VARIABLE}}}`);
  assert.ok(param(eventTag, 'measurementIdOverride').value.length > 0);
  assert.strictEqual(file.containerVersion.tag.length, 1);
  assert.ok(!file.containerVersion.tag.some((item) => item.type === 'googtag' || item.type === 'gaawc'));
}

console.log('ga4 container tests passed');
