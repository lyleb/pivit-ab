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
function scopedPayload(base, scope) {
  if (!scope || !scope.accountId) return base;
  return `${base}.${scope.accountId}.${scope.siteId || '-'}`;
}

function createEditToken(variantId, expiresInMs = 60 * 60 * 1000, scope) {
  const exp = Date.now() + expiresInMs;
  const payload = scopedPayload(`${variantId}.${exp}`, scope);
  const sig = sign(payload);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

// null when the token is missing, forged, for another variant, or expired.
// accountId and siteId are null on tokens minted before accounts existed;
// those still verify until they expire.
function inspectEditToken(token, variantId, now = Date.now()) {
  if (!token || typeof token !== 'string' || !variantId) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch (e) {
    return null;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const payloadParts = payload.split('.');
  if (payloadParts.length !== 2 && payloadParts.length !== 4) return null;
  const tokenVariantId = payloadParts[0];
  const expStr = payloadParts[1];
  if (tokenVariantId !== variantId) return null;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || now > exp) return null;

  let accountId = null;
  let siteId = null;
  if (payloadParts.length === 4) {
    accountId = payloadParts[2] || null;
    siteId = payloadParts[3] && payloadParts[3] !== '-' ? payloadParts[3] : null;
  }
  return { variantId: tokenVariantId, accountId, siteId };
}

function verifyEditToken(token, variantId) {
  return !!inspectEditToken(token, variantId);
}

module.exports = { createEditToken, verifyEditToken, inspectEditToken };
