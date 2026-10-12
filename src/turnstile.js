// Cloudflare Turnstile stays off unless both keys are set. With either one
// missing, sign-in and the access-request form skip the check and the pages
// do not load the Turnstile script.

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function turnstileKeys() {
  const siteKey = String(process.env.TURNSTILE_SITE_KEY || '').trim();
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  return { siteKey, secret, enabled: Boolean(siteKey && secret) };
}

function turnstilePublicConfig() {
  const keys = turnstileKeys();
  if (!keys.enabled) return { enabled: false };
  return { enabled: true, siteKey: keys.siteKey };
}

// Null means the browser must not load the Cloudflare script.
function turnstileScriptUrl(config) {
  const enabled = config ? config.enabled === true && config.siteKey : turnstileKeys().enabled;
  if (!enabled) return null;
  return SCRIPT_URL;
}

async function turnstileOk(req, fetchImpl) {
  const keys = turnstileKeys();
  if (!keys.enabled) return true;
  const token = req && req.body && req.body.turnstile_token;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', keys.secret);
  body.set('response', String(token));
  if (req.ip) body.set('remoteip', String(req.ip));
  try {
    const response = await (fetchImpl || fetch)(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json().catch(() => ({}));
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] verify failed', err);
    return false;
  }
}

module.exports = {
  SCRIPT_URL,
  VERIFY_URL,
  turnstileKeys,
  turnstilePublicConfig,
  turnstileScriptUrl,
  turnstileOk,
};
