// Fixed-horizon verdict. Read once, when the plan is met.
//
// Each challenger is compared with Control. Win, loss or inconclusive comes
// from the credible interval on the relative uplift (challenger − control) /
// control. A 95% interval is always reported. With more than one challenger
// the decision uses the Bonferroni interval stored on the plan, so a false
// win across every comparison stays near 5%.
//
// A broken traffic split blocks the call. The label is then "Data problem".

const { sampleBeta, computeBayesianStats } = require('./bayesian');
const { hashSeed, mulberry32 } = require('./rng');

const DEFAULT_DRAWS = 8000;

function percentLabel(fraction, signed) {
  if (!Number.isFinite(fraction)) return '';
  const pct = fraction * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const abs = Math.abs(rounded);
  const text = Number.isInteger(abs) ? String(abs) : String(abs);
  if (!signed) return `${text}%`;
  if (rounded > 0) return `+${text}%`;
  if (rounded < 0) return `-${text}%`;
  return '0%';
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function ruleOutLine(low, high) {
  const up = percentLabel(high, true);
  if (high <= 0) {
    return `Any uplift is unlikely. A drop bigger than ${percentLabel(Math.abs(low), false)} is unlikely.`;
  }
  if (low >= 0) {
    return `An uplift smaller than ${percentLabel(low, true)} is unlikely. An uplift bigger than ${up} is unlikely.`;
  }
  return `An uplift bigger than ${up} is unlikely.`;
}

function isControlName(name) {
  return /^control$/i.test(String(name || '').trim());
}

function controlIndex(variants) {
  const idx = (variants || []).findIndex((variant) => isControlName(variant.variant_name || variant.name));
  return idx >= 0 ? idx : 0;
}

function posteriorPair(control, challenger, random, draws) {
  const cAlpha = 1 + (Number(control.conversions) || 0);
  const cBeta = 1 + Math.max((Number(control.visitors) || 0) - (Number(control.conversions) || 0), 0);
  const bAlpha = 1 + (Number(challenger.conversions) || 0);
  const bBeta = 1 + Math.max((Number(challenger.visitors) || 0) - (Number(challenger.conversions) || 0), 0);
  const relative = [];
  for (let i = 0; i < draws; i++) {
    const c = sampleBeta(cAlpha, cBeta, random);
    const b = sampleBeta(bAlpha, bBeta, random);
    if (c > 1e-8) relative.push((b - c) / c);
  }
  if (!relative.length) {
    return { mean: null, low95: null, high95: null, samples: [] };
  }
  relative.sort((a, b) => a - b);
  const mean = relative.reduce((sum, value) => sum + value, 0) / relative.length;
  return {
    mean,
    low95: quantile(relative, 0.025),
    high95: quantile(relative, 0.975),
    samples: relative,
  };
}

function intervalExcludesZero(samples, level) {
  const tail = (1 - level) / 2;
  const low = quantile(samples, tail);
  const high = quantile(samples, 1 - tail);
  if (low == null || high == null) return { low, high, excludes: false, side: 'inconclusive' };
  if (low > 0) return { low, high, excludes: true, side: 'win' };
  if (high < 0) return { low, high, excludes: true, side: 'loss' };
  return { low, high, excludes: false, side: 'inconclusive' };
}

function decisionLevel(plan) {
  if (plan && plan.alpha_per_comparison) {
    const level = 1 - Number(plan.alpha_per_comparison);
    if (level > 0.5 && level < 1) return level;
  }
  const comparisons = plan && plan.comparisons ? Number(plan.comparisons) : 1;
  const alpha = 0.05 / Math.max(1, comparisons);
  return 1 - alpha;
}

function seedFor(variants, plan) {
  const parts = (variants || []).map((variant) => [
    variant.variant_id || '',
    variant.variant_name || '',
    variant.visitors || 0,
    variant.conversions || 0,
  ].join(':'));
  parts.push(plan && plan.visitors_per_variant ? String(plan.visitors_per_variant) : '');
  return hashSeed(parts.join('|'));
}

/**
 * @param {{variants: Array, plan?: object, srmDetected?: boolean, draws?: number, random?: function}} input
 */
function buildVerdict(input) {
  const variants = (input && input.variants) || [];
  const plan = input && input.plan;
  if (input && input.srmDetected) {
    return {
      ready: true,
      verdict: 'data_problem',
      label: 'Data problem',
      summary: 'The traffic split does not match the weights you set, so this is not a win, a loss, or inconclusive. Treat the numbers with caution until the split is understood.',
      challengers: [],
      probability_best: [],
    };
  }
  if (variants.length < 2) {
    return {
      ready: false,
      verdict: null,
      label: '',
      summary: 'Add a challenger before a verdict can be read.',
      challengers: [],
      probability_best: [],
    };
  }

  const draws = input.draws || DEFAULT_DRAWS;
  const random = input.random || mulberry32(seedFor(variants, plan));
  const level = decisionLevel(plan);
  const control = variants[controlIndex(variants)];
  const challengers = variants.filter((variant) => variant !== control).map((variant) => {
    const pair = posteriorPair(control, variant, random, draws);
    const decision = intervalExcludesZero(pair.samples, level);
    const call = decision.side === 'win' ? 'win' : decision.side === 'loss' ? 'loss' : 'inconclusive';
    const label = call === 'win' ? 'Win' : call === 'loss' ? 'Loss' : 'Inconclusive';
    const rule = pair.low95 == null
      ? 'Control has no conversions to compare against, so the uplift is not shown.'
      : ruleOutLine(pair.low95, pair.high95);
    return {
      variant_id: variant.variant_id,
      variant_name: variant.variant_name,
      control_name: control.variant_name,
      verdict: call,
      label,
      uplift: pair.mean,
      uplift_label: percentLabel(pair.mean, true),
      ci_low: pair.low95,
      ci_high: pair.high95,
      ci_low_label: percentLabel(pair.low95, true),
      ci_high_label: percentLabel(pair.high95, true),
      rule_out: rule,
      decision_level: level,
    };
  });

  const stats = computeBayesianStats(variants, Math.min(draws, 4000), { random });
  const summary = challengers.length === 1
    ? `${challengers[0].label} for ${challengers[0].variant_name} against ${control.variant_name}.`
    : challengers.map((row) => `${row.variant_name}: ${row.label}`).join(' · ');

  return {
    ready: true,
    verdict: 'compared',
    label: challengers.length === 1 ? challengers[0].label : 'Verdict',
    summary,
    control_name: control.variant_name,
    challengers,
    probability_best: stats.map((row) => ({
      variant_id: row.variant_id,
      variant_name: row.variant_name,
      probability_best: row.probability_best,
    })),
  };
}

module.exports = {
  DEFAULT_DRAWS,
  percentLabel,
  ruleOutLine,
  controlIndex,
  buildVerdict,
  decisionLevel,
};
