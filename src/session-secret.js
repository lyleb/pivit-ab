// SESSION_SECRET signs session cookies and the short-lived edit/preview tokens.
// Production must refuse to boot without a real secret. A 32-character secret
// of any character set is enough — the production value is not hex or base64
// and must not be rotated just to satisfy a format check.

const MIN_SECRET_LENGTH = 32;
const DEV_FALLBACK = 'dev-only-session-secret-not-for-production';

let cached = null;

function resolveSessionSecret(env, exit, log) {
  const raw = env && env.SESSION_SECRET;
  const secret = raw == null ? '' : String(raw).trim();
  const production = env && env.NODE_ENV === 'production';

  if (secret.length >= MIN_SECRET_LENGTH) return secret;

  if (production) {
    const message = '[session] Refusing to start. NODE_ENV=production and SESSION_SECRET is missing or shorter than 32 characters. ' +
      'Set SESSION_SECRET to a string of at least 32 characters — any characters, not necessarily hex or base64 — and restart. ' +
      'The server will not boot until this is set. Do not rotate an existing production secret that is already 32 characters or longer.';
    log.error(message);
    exit(1);
    throw new Error(message);
  }

  log.warn(
    '[session] SESSION_SECRET is missing or shorter than 32 characters. Using a dev-only fallback. ' +
    'Sessions and preview links will not match a production secret. Do not run this fallback when NODE_ENV=production.'
  );
  return DEV_FALLBACK;
}

// Overrides are for tests. The process-wide call (no argument) is cached so a
// missing secret warns once rather than on every signed token.
function getSessionSecret(overrides) {
  if (!overrides && cached) return cached;
  const env = (overrides && overrides.env) || process.env;
  const exit = (overrides && overrides.exit) || process.exit;
  const log = (overrides && overrides.log) || console;
  const secret = resolveSessionSecret(env, exit, log);
  if (!overrides) cached = secret;
  return secret;
}

function clearSessionSecretCache() {
  cached = null;
}

module.exports = {
  MIN_SECRET_LENGTH,
  DEV_FALLBACK,
  getSessionSecret,
  clearSessionSecretCache,
};
