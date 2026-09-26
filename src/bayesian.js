// Bayesian analysis for A/B results, using a Beta-Binomial conjugate model.
//
// For each variant we treat its true (unknown) conversion rate as a random
// variable with a Beta(1,1) prior (uniform — "no assumption before seeing data")
// updated by the observed conversions/visitors into a Beta(1+conversions,
// 1+non-conversions) posterior. That gives a distribution over the plausible
// true rate, not just a single number — which is the point: a raw percentage
// treats "3 conversions from 5 visitors" the same as "300 from 500," when the
// second is far more trustworthy.
//
// "Probability this variant is best" has no clean closed-form for more than two
// variants, so it's computed the standard way: draw a random sample from each
// variant's posterior many times, and count how often each variant's sample was
// the highest. This is a well-established technique (used by tools like Google
// Optimize's early Bayesian model), not a shortcut — it converges to the exact
// answer as the sample count grows, and 20,000 draws is already stable to
// within about +/-1 percentage point.

function gaussianRandom() {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia & Tsang (2000) method for sampling Gamma(shape, 1).
function sampleGamma(shape) {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = gaussianRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Beta(alpha, beta) via the standard Gamma-ratio construction: if X ~ Gamma(a)
// and Y ~ Gamma(b), then X/(X+Y) ~ Beta(a, b).
function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/**
 * @param {Array<{variant_id, variant_name, visitors, conversions}>} variantData
 * @param {number} numSamples - Monte Carlo draws per variant (default 20,000)
 * @returns {Array<{variant_id, variant_name, visitors, conversions, posterior_mean, ci_low, ci_high, probability_best}>}
 */
function computeBayesianStats(variantData, numSamples = 20000) {
  if (variantData.length === 0) return [];

  // One full posterior sample set per variant, drawn together so the
  // "probability of being best" comparison below is apples-to-apples per draw.
  const samples = variantData.map((v) => {
    const alpha = 1 + v.conversions;
    const beta = 1 + Math.max(v.visitors - v.conversions, 0);
    const draws = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) draws[i] = sampleBeta(alpha, beta);
    return draws;
  });

  const wins = new Array(variantData.length).fill(0);
  for (let i = 0; i < numSamples; i++) {
    let bestIdx = 0;
    for (let j = 1; j < variantData.length; j++) {
      if (samples[j][i] > samples[bestIdx][i]) bestIdx = j;
    }
    wins[bestIdx]++;
  }

  return variantData.map((v, idx) => {
    const sorted = [...samples[idx]].sort((a, b) => a - b);
    const ciLowIdx = Math.floor(numSamples * 0.025);
    const ciHighIdx = Math.floor(numSamples * 0.975);
    const mean = sorted.reduce((sum, x) => sum + x, 0) / numSamples;

    return {
      variant_id: v.variant_id,
      variant_name: v.variant_name,
      visitors: v.visitors,
      conversions: v.conversions,
      posterior_mean: +(mean * 100).toFixed(2),
      ci_low: +(sorted[ciLowIdx] * 100).toFixed(2),
      ci_high: +(sorted[ciHighIdx] * 100).toFixed(2),
      probability_best: +((wins[idx] / numSamples) * 100).toFixed(1),
    };
  });
}

module.exports = { computeBayesianStats, sampleBeta, sampleGamma };
