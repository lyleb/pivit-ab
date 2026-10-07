// Preview links open on the customer's site, a different origin from pivitlab,
// so the owner session cookie (SameSite=Lax) is not sent. A signed, expiring
// token in the preview URL is the capability, same idea as the visual editor.
// Without a valid token, draft and paused experiments are not served.

const crypto = require('crypto');
const { getSessionSecret } = require('./session-secret');

const PREVIEW_TTL_MS = 60 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

function createPreviewToken(variantId, expiresInMs = PREVIEW_TTL_MS, now = Date.now()) {
  if (!variantId) throw new Error('variantId is required');
  const exp = now + expiresInMs;
  const payload = `preview.${variantId}.${exp}`;
  return Buffer.from(payload).toString('base64url') + '.' + sign(payload);
}

function verifyPreviewToken(token, variantId, now = Date.now()) {
  if (!token || typeof token !== 'string' || !variantId) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch (err) {
    return false;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  const payloadParts = payload.split('.');
  if (payloadParts.length !== 3) return false;
  const [kind, tokenVariantId, expStr] = payloadParts;
  if (kind !== 'preview' || tokenVariantId !== String(variantId)) return false;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || now > exp) return false;
  return true;
}

// preview=1 on its own is ignored. Both the variant id and a token that was
// signed for that exact variant are required.
function authorisePreview({ preview, previewVariant, previewToken, now } = {}) {
  const on = preview === '1' || preview === 'true' || preview === true;
  if (!on || !previewVariant || !previewToken) return { ok: false };
  if (!verifyPreviewToken(String(previewToken), String(previewVariant), now)) return { ok: false };
  return { ok: true, variantId: String(previewVariant) };
}

function publicVariant(variant) {
  return {
    id: variant.id,
    experiment_id: variant.experiment_id,
    name: variant.name,
    traffic_split: variant.traffic_split,
    changes: variant.changes,
    goals: variant.goals,
  };
}

// running: host-scoped experiments that are already status=running.
// previewExperiment: the single experiment that owns the token's variant,
// already url-matched and host-scoped, or null when that check failed.
// Disabled variants are omitted except the one being previewed.
function buildPublicExperimentList({ running, variants, previewExperiment, previewVariantId } = {}) {
  const byExperiment = new Map();
  for (const variant of variants || []) {
    if (!byExperiment.has(variant.experiment_id)) byExperiment.set(variant.experiment_id, []);
    byExperiment.get(variant.experiment_id).push(variant);
  }

  const experiments = (running || []).map((exp) => ({
    id: exp.id,
    name: exp.name,
    url_match: exp.url_match,
    variants: (byExperiment.get(exp.id) || [])
      .filter((variant) => variant.enabled !== false)
      .map(publicVariant),
  }));

  let preview = null;
  if (previewExperiment && previewVariantId) {
    const owned = byExperiment.get(previewExperiment.id) || [];
    const forced = owned.find((variant) => variant.id === previewVariantId);
    if (forced) {
      preview = { variant_id: previewVariantId };
      let exp = experiments.find((item) => item.id === previewExperiment.id);
      if (!exp) {
        exp = {
          id: previewExperiment.id,
          name: previewExperiment.name,
          url_match: previewExperiment.url_match,
          variants: [],
        };
        experiments.push(exp);
      }
      if (!exp.variants.some((variant) => variant.id === forced.id)) {
        exp.variants.push(publicVariant(forced));
      }
    }
  }

  return { experiments, preview };
}

function previewUrl(pageUrl, variantId, token) {
  const sep = String(pageUrl).includes('?') ? '&' : '?';
  return `${pageUrl}${sep}ab_preview=${encodeURIComponent(variantId)}&ab_preview_token=${encodeURIComponent(token)}`;
}

module.exports = {
  PREVIEW_TTL_MS,
  createPreviewToken,
  verifyPreviewToken,
  authorisePreview,
  buildPublicExperimentList,
  previewUrl,
};
