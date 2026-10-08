// Seeded A/A and power checks for the fixed-horizon verdict.
// The fast path is what npm test runs. A longer run can use more draws.

const { buildPlan } = require('./plan');
const { buildVerdict } = require('./verdict');
const { mulberry32 } = require('./rng');

function normalDraw(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function binomial(n, p, random) {
  if (!(n > 0) || !(p > 0)) return 0;
  if (p >= 1) return n;
  // Exact for the sizes the fast test uses. A normal draw is only a fallback
  // for a much larger optional run.
  if (n <= 5000) {
    let hits = 0;
    for (let i = 0; i < n; i++) if (random() < p) hits += 1;
    return hits;
  }
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  return Math.max(0, Math.min(n, Math.round(mean + sd * normalDraw(random))));
}

function plannedN(baseline, relative, variantCount) {
  const built = buildPlan({
    baseline_rate: baseline,
    relative_effect: relative,
    effect_choice: 'custom',
    weekly_traffic: 100000,
    min_runtime_days: 14,
    variant_count: variantCount,
    source: 'owner',
  });
  if (!built.ok) throw new Error(built.error);
  return built.plan;
}

function arm(name, visitors, conversions) {
  return { variant_id: name, variant_name: name, visitors, conversions };
}

function oneTest({ plan, rates, random, draws }) {
  const names = rates.length === 2 ? ['Control', 'Challenger'] : ['Control', 'Challenger A', 'Challenger B'];
  const variants = rates.map((rate, index) => arm(
    names[index] || `Variant ${index}`,
    plan.visitors_per_variant,
    binomial(plan.visitors_per_variant, rate, random)
  ));
  return buildVerdict({
    variants,
    plan,
    srmDetected: false,
    draws,
    random,
  });
}

function falseCall(verdict) {
  return (verdict.challengers || []).some((row) => row.verdict === 'win' || row.verdict === 'loss');
}

function summarise(runs, hits) {
  return {
    runs,
    hits,
    rate: runs ? hits / runs : 0,
  };
}

function runSimulation({
  baseline = 0.1,
  relative = 0.5,
  variantCount = 2,
  runs = 80,
  draws = 1500,
  seed = 20261008,
  kind = 'aa',
} = {}) {
  const plan = plannedN(baseline, relative, variantCount);
  const random = mulberry32(seed + variantCount * 1000 + (kind === 'power' ? 17 : 0));
  const p1 = baseline;
  const p2 = kind === 'power' ? baseline * (1 + relative) : baseline;
  const rates = [p1];
  for (let i = 1; i < variantCount; i++) rates.push(p2);
  let hits = 0;
  for (let i = 0; i < runs; i++) {
    const verdict = oneTest({ plan, rates, random, draws });
    if (kind === 'power') {
      if (verdict.challengers[0] && verdict.challengers[0].verdict === 'win') hits += 1;
    } else if (falseCall(verdict)) {
      hits += 1;
    }
  }
  return {
    kind,
    baseline,
    relative,
    variantCount,
    visitors_per_variant: plan.visitors_per_variant,
    alpha_per_comparison: plan.alpha_per_comparison,
    comparisons: plan.comparisons,
    runs,
    draws,
    seed,
    ...summarise(runs, hits),
  };
}

module.exports = {
  binomial,
  plannedN,
  runSimulation,
};
