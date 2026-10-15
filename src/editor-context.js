// Copy and links for the visual editor. The editor runs on the customer's
// site, so an archived test has to say which test the variant belongs to and
// link back to that test in pivitlab. Status is already on the experiment, so
// this does not need a new column.

const { configuredAppOrigin } = require('./app-origin');

const STATUS_LABELS = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  archived: 'Archived',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusLabel(status) {
  return STATUS_LABELS[status] || '';
}

function plainName(name) {
  return String(name || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function quotedName(name) {
  const text = plainName(name);
  return text ? `"${text}"` : 'This test';
}

function archivedEditMessage(name) {
  return `${quotedName(name)} is archived, so this variant can't be edited.`;
}

function expiredEditMessage(name) {
  return `This edit link has expired. ${quotedName(name)} is archived.`;
}

function expiredPreviewMessage(name) {
  return `This preview link has expired. ${quotedName(name)} is archived.`;
}

function archivedPreviewMessage(name) {
  return `${quotedName(name)} is archived, so it can't be previewed.`;
}

function runningEditWarning() {
  return 'This test is running. Saves go live to visitors straight away.';
}

function linkLabel(name) {
  const text = plainName(name);
  return text ? `Open ${text} in pivitlab` : 'Open the test in pivitlab';
}

function editorFields(status) {
  return {
    experiment_status_label: statusLabel(status),
    edit_warning: status === 'running' ? runningEditWarning() : '',
  };
}

function testPageUrl(req, experimentId) {
  const id = String(experimentId || '');
  if (!UUID_RE.test(id)) return '';
  const configured = configuredAppOrigin();
  let origin = configured;
  if (!origin && req) {
    const host = typeof req.get === 'function' ? req.get('host') : '';
    if (host) origin = `${req.protocol || 'http'}://${host}`;
  }
  if (!origin) return '';
  return `${String(origin).replace(/\/$/, '')}/index.html#experiment/${id}`;
}

// message is the sentence the owner reads. test.url is the link to the test
// this variant actually belongs to.
function archivedBody(req, experiment, message) {
  const name = plainName(experiment && experiment.name);
  const id = experiment && experiment.id ? String(experiment.id) : '';
  return {
    error: message,
    message,
    code: 'archived',
    test: {
      id: id || null,
      name,
      status: 'archived',
      status_label: 'Archived',
      url: testPageUrl(req, id),
      link_label: linkLabel(name),
    },
    variant: {
      id: experiment && experiment.variantId ? String(experiment.variantId) : null,
      name: plainName(experiment && experiment.variantName),
    },
  };
}

module.exports = {
  STATUS_LABELS,
  statusLabel,
  plainName,
  archivedEditMessage,
  expiredEditMessage,
  expiredPreviewMessage,
  archivedPreviewMessage,
  runningEditWarning,
  linkLabel,
  editorFields,
  testPageUrl,
  archivedBody,
};
