// A Google Tag Manager container export (export format version 2) for one
// site. Import it with Merge. It adds the Data Layer Variables, the Custom
// Event trigger, and one GA4 Event tag. It does not add a Google tag.
//
// Parameter types and the trigger type are the uppercase form GTM writes
// into an export. Tag and variable types stay as the template codes
// (gaawe, v, c), which is how an export distinguishes them.

const { normaliseMeasurementId } = require('./ga4');

const EVENT_NAME = 'experience_impression';
const TAG_NAME = 'pivitlab - experience_impression';
const PLACEHOLDER_VARIABLE = 'pivitlab - GA4 measurement ID';
const PLACEHOLDER_VALUE = 'G-XXXXXXXXXX';
const FIELDS = [
  'exp_variant_string',
  'experiment_id',
  'experiment_name',
  'variant_id',
  'variant_name',
];

function exportStamp(date) {
  const when = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`;
}

function parameter(type, key, value) {
  return { type, key, value };
}

function dataLayerVariable(variableId, name) {
  return {
    accountId: '0',
    containerId: '0',
    variableId: String(variableId),
    name,
    type: 'v',
    parameter: [
      parameter('INTEGER', 'dataLayerVersion', '2'),
      parameter('BOOLEAN', 'setDefaultValue', 'false'),
      parameter('TEMPLATE', 'name', name),
    ],
    fingerprint: '0',
  };
}

function placeholderVariable(variableId) {
  return {
    accountId: '0',
    containerId: '0',
    variableId: String(variableId),
    name: PLACEHOLDER_VARIABLE,
    type: 'c',
    parameter: [
      parameter('TEMPLATE', 'value', PLACEHOLDER_VALUE),
    ],
    fingerprint: '0',
  };
}

function customEventTrigger(triggerId) {
  return {
    accountId: '0',
    containerId: '0',
    triggerId: String(triggerId),
    name: EVENT_NAME,
    type: 'CUSTOM_EVENT',
    customEventFilter: [
      {
        type: 'EQUALS',
        parameter: [
          parameter('TEMPLATE', 'arg0', '{{_event}}'),
          parameter('TEMPLATE', 'arg1', EVENT_NAME),
        ],
      },
    ],
    fingerprint: '0',
  };
}

function eventParameter(name) {
  return {
    type: 'MAP',
    map: [
      parameter('TEMPLATE', 'parameter', name),
      parameter('TEMPLATE', 'parameterValue', `{{${name}}}`),
    ],
  };
}

function ga4EventTag(tagId, triggerId, measurementId) {
  return {
    accountId: '0',
    containerId: '0',
    tagId: String(tagId),
    name: TAG_NAME,
    type: 'gaawe',
    parameter: [
      parameter('BOOLEAN', 'sendEcommerceData', 'false'),
      {
        type: 'LIST',
        key: 'eventSettingsTable',
        list: FIELDS.map(eventParameter),
      },
      parameter('TEMPLATE', 'eventName', EVENT_NAME),
      parameter('TEMPLATE', 'measurementIdOverride', measurementId),
    ],
    firingTriggerId: [String(triggerId)],
    tagFiringOption: 'ONCE_PER_EVENT',
    fingerprint: '0',
    monitoringMetadata: { type: 'MAP' },
    consentSettings: { consentStatus: 'NOT_SET' },
  };
}

function buildGtmContainer(measurementId, date) {
  const saved = normaliseMeasurementId(measurementId);
  const variables = FIELDS.map((name, index) => dataLayerVariable(index + 1, name));
  let measurement = saved;
  if (!saved) {
    variables.push(placeholderVariable(variables.length + 1));
    measurement = `{{${PLACEHOLDER_VARIABLE}}}`;
  }
  const triggerId = String(variables.length + 1);
  const tagId = String(variables.length + 2);
  return {
    exportFormatVersion: 2,
    exportTime: exportStamp(date),
    containerVersion: {
      path: 'accounts/0/containers/0/versions/0',
      accountId: '0',
      containerId: '0',
      containerVersionId: '0',
      name: 'pivitlab experience_impression',
      container: {
        path: 'accounts/0/containers/0',
        accountId: '0',
        containerId: '0',
        name: 'pivitlab',
        publicId: 'GTM-XXXXXXX',
        usageContext: ['WEB'],
        fingerprint: '0',
        tagManagerUrl: 'https://tagmanager.google.com/',
      },
      tag: [ga4EventTag(tagId, triggerId, measurement)],
      trigger: [customEventTrigger(triggerId)],
      variable: variables,
      fingerprint: '0',
      tagManagerUrl: 'https://tagmanager.google.com/',
    },
  };
}

module.exports = {
  EVENT_NAME,
  TAG_NAME,
  PLACEHOLDER_VARIABLE,
  PLACEHOLDER_VALUE,
  FIELDS,
  buildGtmContainer,
};
