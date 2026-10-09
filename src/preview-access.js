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

function createPreviewToken(variantId, expiresInMs = PREVIEW_TTL_MS, now = Date.now(), scope) {
  if (!variantId) throw new Error('variantId is required');
  const exp = now + expiresInMs;
  let payload = `preview.${variantId}.${exp}`;
  if (scope && scope.accountId) payload += `.${scope.accountId}.${scope.siteId || '-'}`;
  return Buffer.from(payload).toString('base64url') + '.' + sign(payload);
}

function inspectPreviewToken(token, variantId, now = Date.now()) {
  if (!token || typeof token !== 'string' || !variantId) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch (err) {
    return null;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const payloadParts = payload.split('.');
  if (payloadParts.length !== 3 && payloadParts.length !== 5) return null;
  const [kind, tokenVariantId, expStr] = payloadParts;
  if (kind !== 'preview' || tokenVariantId !== String(variantId)) return null;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || now > exp) return null;

  let accountId = null;
  let siteId = null;
  if (payloadParts.length === 5) {
    accountId = payloadParts[3] || null;
    siteId = payloadParts[4] && payloadParts[4] !== '-' ? payloadParts[4] : null;
  }
  return { variantId: String(variantId), accountId, siteId };
}

function verifyPreviewToken(token, variantId, now = Date.now()) {
  return !!inspectPreviewToken(token, variantId, now);
}

// preview=1 on its own is ignored. Both the variant id and a token that was
// signed for that exact variant are required.
function authorisePreview({ preview, previewVariant, previewToken, now } = {}) {
  const on = preview === '1' || preview === 'true' || preview === true;
  if (!on || !previewVariant || !previewToken) return { ok: false };
  const claims = inspectPreviewToken(String(previewToken), String(previewVariant), now);
  if (!claims) return { ok: false };
  return {
    ok: true,
    variantId: claims.variantId,
    accountId: claims.accountId,
    siteId: claims.siteId,
  };
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
    // Empty for a test whose goals still differ per variant. The snippet
    // then uses each variant's own list. Older snippets ignore this field.
    goals: Array.isArray(exp.goals) ? exp.goals : [],
    variants: (byExperiment.get(exp.id) || [])
      .filter((variant) => variant.enabled !== false)
      .map(publicVariant),
  }));

  let preview = null;
  if (previewExperiment && previewVariantId) {
    const owned = byExperiment.get(previewExperiment.id) || [];
    const forced = owned.find((variant) => variant.id === previewVariantId);
    if (forced) {
      preview = { variant_id: previewVariantId, experiment_id: previewExperiment.id };
      let exp = experiments.find((item) => item.id === previewExperiment.id);
      if (!exp) {
        exp = {
          id: previewExperiment.id,
          name: previewExperiment.name,
          url_match: previewExperiment.url_match,
          goals: Array.isArray(previewExperiment.goals) ? previewExperiment.goals : [],
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

// A page URL copied from an earlier preview or edit still carries ab_preview,
// ab_preview_token, ab_edit and token. Appending another pair leaves the old
// values first, and the snippet used to read the first one. Strip ours, then
// set the new pair. A site's own ?token= is removed only when it was sitting
// next to ab_edit (that token is the edit link). The hash stays on the URL.
function withPivitParams(pageUrl, entries) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch (err) {
    const sep = String(pageUrl).includes('?') ? '&' : '?';
    const extra = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    return `${pageUrl}${sep}${extra}`;
  }
  const hadEdit = url.searchParams.has('ab_edit');
  url.searchParams.delete('ab_preview');
  url.searchParams.delete('ab_preview_token');
  url.searchParams.delete('ab_edit');
  if (hadEdit) url.searchParams.delete('token');
  for (const [key, value] of entries) url.searchParams.set(key, value);
  return url.toString();
}

function previewUrl(pageUrl, variantId, token) {
  return withPivitParams(pageUrl, [
    ['ab_preview', variantId],
    ['ab_preview_token', token],
  ]);
}

function editUrl(pageUrl, variantId, token) {
  return withPivitParams(pageUrl, [
    ['ab_edit', variantId],
    ['token', token],
  ]);
}

// Live GET /api/experiments is left uncached-by-us (no Cache-Control change).
// A preview response is tied to one variant and must not be reused for the next.
function cacheControlForExperimentsQuery(query) {
  const preview = query && (query.preview === '1' || query.preview === 'true' || query.preview === true);
  return preview ? 'no-store' : null;
}

module.exports = {
  PREVIEW_TTL_MS,
  createPreviewToken,
  verifyPreviewToken,
  inspectPreviewToken,
  authorisePreview,
  buildPublicExperimentList,
  previewUrl,
  editUrl,
  cacheControlForExperimentsQuery,
};
