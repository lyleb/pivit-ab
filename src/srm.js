// Sample Ratio Mismatch (SRM) detection.
//
// If an experiment is configured as a 50/50 split but actual traffic comes in
// at, say, 65/35, that's usually a sign something is wrong — a bug in
// assignment, bot contamination skewing one variant, or a caching/redirect
// issue — rather than normal random variance. This is a standard rigor check
// in serious A/B testing tools (Microsoft, Optimizely, VWO all run some form
// of it), and an SRM flag means: don't trust the results above it until this
// is understood, regardless of how convincing the conversion-rate difference
// looks — a biased split can fully explain an apparent "winner" on its own.
//
// Method: a chi-square goodness-of-fit test comparing observed visitor counts
// per variant against the expected counts implied by configured traffic_split.
// A very strict p-value threshold (0.001, not the usual 0.05) is standard
// practice here specifically to avoid false alarms — SRM checks are meant to
// catch "something is clearly broken," not ordinary statistical noise.

const SRM_P_VALUE_THRESHOLD = 0.001;

// log(Gamma(x)) via the Lanczos approximation — a standard, well-tested method.
function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Regularized lower incomplete gamma function P(a, x), via series expansion
// (for x < a+1) or a continued fraction (for x >= a+1) — the standard
// Numerical-Recipes-style split for numerical stability across the full range.
function lowerIncompleteGammaRegularized(a, x) {
  if (x <= 0) return 0;

  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    let n = a;
    for (let i = 0; i < 200; i++) {
      n += 1;
      term *= x / n;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }

  // Continued fraction for Q(a,x) = 1 - P(a,x)
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  const Q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return 1 - Q;
}

// P(chi-square >= observed value) with the given degrees of freedom.
function chiSquarePValue(chiSquare, degreesOfFreedom) {
  if (chiSquare <= 0) return 1;
  const p = 1 - lowerIncompleteGammaRegularized(degreesOfFreedom / 2, chiSquare / 2);
  return Math.max(0, Math.min(1, p));
}

/**
 * @param {Array<{name, visitors, traffic_split}>} variants
 * @returns {{applicable, chi_square, degrees_of_freedom, p_value, srm_detected, threshold} }
 */
function detectSRM(variants) {
  const totalVisitors = variants.reduce((sum, v) => sum + v.visitors, 0);
  const totalSplit = variants.reduce((sum, v) => sum + (v.traffic_split || 0), 0);

  // Not enough to say anything meaningful yet.
  if (variants.length < 2 || totalVisitors === 0 || totalSplit === 0) {
    return { applicable: false, chi_square: null, degrees_of_freedom: null, p_value: null, srm_detected: false, threshold: SRM_P_VALUE_THRESHOLD };
  }

  let chiSquare = 0;
  variants.forEach((v) => {
    const expected = totalVisitors * ((v.traffic_split || 0) / totalSplit);
    if (expected > 0) {
      chiSquare += Math.pow(v.visitors - expected, 2) / expected;
    }
  });

  const degreesOfFreedom = variants.length - 1;
  const pValue = chiSquarePValue(chiSquare, degreesOfFreedom);

  return {
    applicable: true,
    chi_square: +chiSquare.toFixed(4),
    degrees_of_freedom: degreesOfFreedom,
    p_value: pValue,
    srm_detected: pValue < SRM_P_VALUE_THRESHOLD,
    threshold: SRM_P_VALUE_THRESHOLD,
  };
}

module.exports = { detectSRM, chiSquarePValue, SRM_P_VALUE_THRESHOLD };
