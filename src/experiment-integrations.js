// Per-experiment ticks for Send to GA4 and Count dataLayer events.
// Omitted on create means on, matching the column default, so an older
// client keeps today's behaviour. The snippet still needs the site switch.

const NOTHING_ERROR = 'Nothing to save.';
const GA4_TYPE_ERROR = 'Say whether this test sends to GA4.';
const DATALAYER_TYPE_ERROR = 'Say whether this test counts dataLayer events.';

function readFlag(body, key, error) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, present: false };
  if (typeof body[key] !== 'boolean') return { ok: false, status: 400, error };
  return { ok: true, present: true, value: body[key] };
}

function parseCreateIntegrationFlags(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const ga4 = readFlag(source, 'ga4_enabled', GA4_TYPE_ERROR);
  if (!ga4.ok) return ga4;
  const layer = readFlag(source, 'datalayer_events', DATALAYER_TYPE_ERROR);
  if (!layer.ok) return layer;
  return {
    ok: true,
    ga4_enabled: ga4.present ? ga4.value : true,
    datalayer_events: layer.present ? layer.value : true,
  };
}

function parseExperimentIntegrations(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: NOTHING_ERROR };
  }
  const ga4 = readFlag(body, 'ga4_enabled', GA4_TYPE_ERROR);
  if (!ga4.ok) return ga4;
  const layer = readFlag(body, 'datalayer_events', DATALAYER_TYPE_ERROR);
  if (!layer.ok) return layer;
  if (!ga4.present && !layer.present) return { ok: false, status: 400, error: NOTHING_ERROR };
  const parsed = { ok: true };
  if (ga4.present) parsed.ga4_enabled = ga4.value;
  if (layer.present) parsed.datalayer_events = layer.value;
  return parsed;
}

module.exports = {
  NOTHING_ERROR,
  GA4_TYPE_ERROR,
  DATALAYER_TYPE_ERROR,
  parseCreateIntegrationFlags,
  parseExperimentIntegrations,
};
