// Scoped, short-lived tokens for the visual editor. The editor runs on the
// CLIENT's domain (e.g. cantsaythat.co.uk), not pivit.click, so the normal
// session cookie (sameSite: 'lax', deliberately never sent cross-site) can't
// authenticate it. Instead, clicking "Make Edits" mints a token good for
// exactly one variant, for a limited time — not a login, just a scoped
// capability. This also sets up cleanly for a future restricted client-side
// version: same mechanism, just issued to a client instead of the owner.
//
// Reuses SESSION_SECRET rather than introducing a second secret to configure —
// it's already a securely generated random value used for a similar signing
// purpose (session cookies).

const crypto = require('crypto');
const { getSessionSecret } = require('./session-secret');

function getSecret() {
  return getSessionSecret();
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * @param {string} variantId
 * @param {number} expiresInMs - default 1 hour
 * @returns {string} opaque token, safe to put in a URL
 */
function createEditToken(variantId, expiresInMs = 60 * 60 * 1000) {
  const exp = Date.now() + expiresInMs;
  const payload = `${variantId}.${exp}`;
  const sig = sign(payload);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

/**
 * @param {string} token
 * @param {string} variantId - the variant this request claims to be for
 * @returns {boolean}
 */
function verifyEditToken(token, variantId) {
  if (!token || typeof token !== 'string' || !variantId) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch (e) {
    return false;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  const payloadParts = payload.split('.');
  if (payloadParts.length !== 2) return false;
  const [tokenVariantId, expStr] = payloadParts;

  if (tokenVariantId !== variantId) return false;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  return true;
}

module.exports = { createEditToken, verifyEditToken };
