// Optional public origin for URLs the admin UI shows (snippet tag, client login).
// APP_ORIGIN is a feature flag: unset or invalid means the UI keeps using
// location.origin. This does not change which host serves traffic.
//
// The same rules live in public/admin-ui.js (displayOrigin) so the page can
// ignore a bad payload on its own. null fallback makes that return null here.

const { displayOrigin } = require('../public/admin-ui');

function normaliseAppOrigin(raw) {
  if (raw == null) return null;
  return displayOrigin(String(raw), null);
}

function configuredAppOrigin() {
  return normaliseAppOrigin(process.env.APP_ORIGIN);
}

function sendPublicConfig(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ appOrigin: configuredAppOrigin() });
}

module.exports = {
  normaliseAppOrigin,
  configuredAppOrigin,
  sendPublicConfig,
};
