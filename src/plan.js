// Fixed-horizon sample size for a binary conversion rate.
//
// Equal visitors per variant, 80% power, two-sided 5% by default.
// The formula is the usual two-proportion calculation: the null standard
// error uses the pooled rate, and the alternative uses each arm's own
// variance. That is the sample size that actually has about 80% power.
//
// With more than one challenger, alpha is divided by the number of
// comparisons (Bonferroni). Three variants means Control plus two
// challengers, so each comparison uses 2.5% instead of 5%.

const POWER = 0.8;
const ALPHA = 0.05;
const DEFAULT_BASELINE = 0.03;
const DEFAULT_RELATIVE = 0.1;
const DEFAULT_MIN_RUNTIME_DAYS = 14;
const MIN_RUNTIME_DAYS = 7;
const MIN_BASELINE_VISITORS = 100;

const EFFECT_CHOICES = [
  { id: 'small', relative: 0.05, label: 'Small change', hint: 'about 5% relative' },
  { id: 'medium', relative: 0.1, label: 'Medium', hint: 'about 10% relative' },
  { id: 'big', relative: 0.2, label: 'Big', hint: 'about 20% relative' },
];

function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error('probability out of range');
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function choiceById(id) {
  return EFFECT_CHOICES.find((choice) => choice.id === id) || null;
}

function comparisonsFor(variantCount) {
  const n = Math.max(2, Math.round(Number(variantCount) || 2));
  return { variantCount: n, comparisons: n - 1 };
}

// Visitors required in ONE variant. alpha is the two-sided level for this
// comparison (already Bonferroni-adjusted when there is more than one).
function sampleSizePerVariant({ baseline, relativeEffect, alpha = ALPHA, power = POWER }) {
  const p1 = baseline;
  const p2 = p1 * (1 + relativeEffect);
  if (!(p1 > 0 && p1 < 1) || !(p2 > p1) || !(p2 < 1)) return null;
  const delta = p2 - p1;
  const pBar = (p1 + p2) / 2;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const term = zAlpha * Math.sqrt(2 * pBar * (1 - pBar))
    + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((term / delta) ** 2);
}

function slowestWeeklyShare(weeklyTraffic, variantCount, weights) {
  const traffic = Number(weeklyTraffic);
  if (!(traffic > 0)) return null;
  const n = Math.max(2, Math.round(Number(variantCount) || 2));
  let shares;
  if (Array.isArray(weights) && weights.length >= 2) {
    const cleaned = weights.map((value) => Math.max(0, Number(value) || 0));
    const total = cleaned.reduce((sum, value) => sum + value, 0);
    if (total > 0) shares = cleaned.map((value) => value / total);
  }
  if (!shares) shares = Array.from({ length: n }, () => 1 / n);
  const slowest = Math.min(...shares.filter((share) => share > 0));
  if (!(slowest > 0)) return null;
  return traffic * slowest;
}

function formatCount(value) {
  return Math.round(value).toLocaleString('en-GB');
}

function planSentence({ visitorsPerVariant, estimatedWeeks }) {
  const visitors = formatCount(visitorsPerVariant);
  if (estimatedWeeks) {
    const weekWord = estimatedWeeks === 1 ? 'week' : 'weeks';
    return `You'll need about ${visitors} visitors per variant, roughly ${estimatedWeeks} ${weekWord} at your current traffic.`;
  }
  return `You'll need about ${visitors} visitors per variant. Add weekly traffic to estimate how long that takes.`;
}

function explanation({ comparisons, alphaPerComparison, minRuntimeDays, assumedPair }) {
  const base = 'This plans an 80% chance of detecting that change, with a 5% chance of calling a difference that is not there (two-sided). The result is read once, when the plan is reached, which is what makes that 5% hold.';
  const weeks = minRuntimeDays / 7;
  const runtime = minRuntimeDays < 14
    ? ` Minimum runtime is ${minRuntimeDays} days. One week can miss a weekday pattern. Two weeks is the usual minimum.`
    : ` Minimum runtime is ${weeks} weeks, so the test covers more than one weekly cycle.`;
  let multiple = '';
  if (comparisons > 1) {
    const percent = +(alphaPerComparison * 100).toFixed(2);
    const percentText = Number.isInteger(percent) ? String(percent) : String(percent);
    multiple = ` There ${comparisons === 1 ? 'is' : 'are'} ${comparisons} challengers against Control. Each comparison uses a stricter ${percentText}% bar (Bonferroni), so the chance of a false win across all of them stays near 5%.`;
  }
  const assumed = assumedPair
    ? ' The figure assumes Control and one challenger.'
    : '';
  return `${base}${multiple}${runtime}${assumed}`;
}

function parseRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1 && n < 100) return n / 100;
  if (n > 0 && n < 1) return n;
  return null;
}

function parseRelative(value, effectChoice) {
  if (effectChoice && effectChoice !== 'custom') {
    const choice = choiceById(effectChoice);
    if (choice) return choice.relative;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1 && n <= 300) return n / 100;
  if (n > 0 && n <= 3) return n;
  return null;
}

function parseMinRuntime(value) {
  if (value == null || value === '') return DEFAULT_MIN_RUNTIME_DAYS;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n < MIN_RUNTIME_DAYS) return null;
  return n;
}

function buildPlan(input) {
  const raw = input || {};
  const baseline = parseRate(raw.baseline_rate);
  if (baseline == null) {
    return { ok: false, error: 'Enter a baseline conversion rate between 0.1% and 99%.' };
  }
  const effectChoice = raw.effect_choice || 'custom';
  const relative = parseRelative(raw.relative_effect, effectChoice);
  if (relative == null) {
    return { ok: false, error: 'Enter a relative change greater than 0.' };
  }
  if (baseline * (1 + relative) >= 1) {
    return { ok: false, error: 'That change would push the rate over 100%. Choose a smaller change or a lower baseline.' };
  }
  const minRuntimeDays = parseMinRuntime(raw.min_runtime_days);
  if (minRuntimeDays == null) {
    return { ok: false, error: 'Minimum runtime is at least 7 days (one week).' };
  }

  const requestedVariants = Math.round(Number(raw.variant_count) || 2);
  const assumedPair = requestedVariants < 2;
  const { variantCount, comparisons } = comparisonsFor(Math.max(requestedVariants, 2));
  const alphaPerComparison = ALPHA / comparisons;
  const visitors = sampleSizePerVariant({
    baseline,
    relativeEffect: relative,
    alpha: alphaPerComparison,
    power: POWER,
  });
  if (!visitors) {
    return { ok: false, error: 'Could not calculate a sample size for those inputs.' };
  }

  let weekly = raw.weekly_traffic == null || raw.weekly_traffic === ''
    ? null
    : Math.round(Number(raw.weekly_traffic));
  if (weekly != null && (!Number.isFinite(weekly) || weekly < 0)) {
    return { ok: false, error: 'Weekly traffic needs to be zero or a positive number of visitors.' };
  }
  if (weekly === 0) weekly = null;

  const perWeek = slowestWeeklyShare(weekly, variantCount, raw.weights);
  let estimatedDays = null;
  let estimatedWeeks = null;
  if (perWeek) {
    estimatedDays = Math.ceil(visitors / (perWeek / 7));
    estimatedWeeks = Math.max(1, Math.ceil(estimatedDays / 7));
  }

  const matched = choiceById(effectChoice);
  const sentence = planSentence({ visitorsPerVariant: visitors, estimatedWeeks });
  const plan = {
    baseline_rate: +baseline.toFixed(6),
    baseline_source: raw.baseline_source || 'owner',
    baseline_label: raw.baseline_label || '',
    relative_effect: +relative.toFixed(6),
    effect_choice: matched ? matched.id : 'custom',
    weekly_traffic: weekly,
    traffic_source: raw.traffic_source || (weekly ? 'owner' : 'unknown'),
    traffic_label: raw.traffic_label || '',
    visitors_per_variant: visitors,
    estimated_days: estimatedDays,
    estimated_weeks: estimatedWeeks,
    min_runtime_days: minRuntimeDays,
    whole_weeks: minRuntimeDays % 7 === 0,
    power: POWER,
    alpha: ALPHA,
    alpha_per_comparison: +alphaPerComparison.toFixed(6),
    comparisons,
    variant_count: assumedPair ? requestedVariants : variantCount,
    planned_variants: variantCount,
    weights: Array.isArray(raw.weights) ? raw.weights.map((value) => Number(value) || 0) : null,
    method: 'two-proportion-fixed-horizon',
    source: raw.source === 'auto' ? 'auto' : 'owner',
    sentence,
    explanation: explanation({
      comparisons,
      alphaPerComparison,
      minRuntimeDays,
      assumedPair,
    }),
    bonferroni: comparisons > 1,
    runtime_warning: minRuntimeDays < 14
      ? 'One week can miss a weekday pattern. Two weeks is the usual minimum.'
      : '',
  };
  return { ok: true, plan };
}

function autoPlanInput(suggestion, variants) {
  const weights = (variants || [])
    .filter((variant) => variant.enabled !== false)
    .map((variant) => Number(variant.traffic_split) || 0);
  const enabled = weights.length;
  return {
    baseline_rate: suggestion && suggestion.baseline_rate != null ? suggestion.baseline_rate : DEFAULT_BASELINE,
    baseline_source: (suggestion && suggestion.baseline_source) || 'default',
    baseline_label: (suggestion && suggestion.baseline_label) || '',
    relative_effect: DEFAULT_RELATIVE,
    effect_choice: 'medium',
    weekly_traffic: suggestion && suggestion.weekly_traffic != null ? suggestion.weekly_traffic : null,
    traffic_source: (suggestion && suggestion.traffic_source) || 'unknown',
    traffic_label: (suggestion && suggestion.traffic_label) || '',
    min_runtime_days: DEFAULT_MIN_RUNTIME_DAYS,
    variant_count: Math.max(enabled, 2),
    weights: enabled >= 2 ? weights : null,
    source: 'auto',
  };
}

module.exports = {
  POWER,
  ALPHA,
  DEFAULT_BASELINE,
  DEFAULT_RELATIVE,
  DEFAULT_MIN_RUNTIME_DAYS,
  MIN_RUNTIME_DAYS,
  MIN_BASELINE_VISITORS,
  EFFECT_CHOICES,
  normalQuantile,
  sampleSizePerVariant,
  comparisonsFor,
  planSentence,
  buildPlan,
  autoPlanInput,
  parseRate,
  slowestWeeklyShare,
};
