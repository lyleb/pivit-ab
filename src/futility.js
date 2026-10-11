// Daily futility check. Traffic is judged first, and that path does not look
// at conversions at all. Only when the projected end is still inside the cap
// do we simulate whether the test is likely to reach a Win or a Loss.
//
// The simulation uses the same verdict rule as src/verdict.js: a challenger
// is a win or a loss when the credible interval on relative uplift excludes
// zero, at the plan's decision level (Bonferroni when there is more than one
// challenger). P(decisive) is the share of runs that end that way. It does
// not say which version is ahead.
//
// Bands:
//   >= 30%                 no flag
//   10% to 30%             amber, owner only ("may end inconclusive")
//   < 10% and a shortfall  "Unlikely to finish in time" for the client
//   < 10% but on time      owner only (the visitors will arrive; the effect
//                          is too small). The client does not see "unlikely".
//   projected end past cap traffic-only, client "unlikely", no posterior
//
// The client still sees "unlikely" only after a second consecutive day.
// That hysteresis lives in headlines.js, not here.

const { sampleBeta } = require('./bayesian');
const { decisionLevel, controlIndex, posteriorPair, intervalExcludesZero } = require('./verdict');
const { hashSeed, mulberry32 } = require('./rng');
const { addDays } = require('./clock');
const { roundProgressBand, readyLabel } = require('./headlines');

const HARD_CAP_DAYS = 16 * 7;
const HORIZON_MULTIPLIER = 1.5;
const DEFAULT_RUNS = 2000;
const DEFAULT_INNER_DRAWS = 250;
const TRAFFIC_LOW_RATIO = 0.7;
const TRAFFIC_LOW_MIN_DAYS = 7;

function sampleBinomial(n, p, random) {
  const trials = Math.max(0, Math.round(Number(n) || 0));
  const rate = Number(p);
  if (trials <= 0 || !(rate > 0)) return 0;
  if (rate >= 1) return trials;
  if (trials > 40) {
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const mean = trials * rate;
    const sd = Math.sqrt(Math.max(trials * rate * (1 - rate), 0));
    return Math.max(0, Math.min(trials, Math.round(mean + z * sd)));
  }
  let hits = 0;
  for (let i = 0; i < trials; i += 1) if (random() < rate) hits += 1;
  return hits;
}

function remainingByVariant(variants, visitorsPerVariant, dailyRate, daysLeft) {
  const weights = variants.map((variant) => Math.max(0, Number(variant.traffic_split) || 0));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const expectedTotal = Math.max(0, Number(dailyRate) || 0) * Math.max(0, Number(daysLeft) || 0);
  const remaining = {};
  variants.forEach((variant, index) => {
    const share = weightTotal > 0 ? weights[index] / weightTotal : 1 / Math.max(variants.length, 1);
    const expected = expectedTotal * share;
    const needed = Math.max(0, (Number(visitorsPerVariant) || 0) - (Number(variant.visitors) || 0));
    const id = variant.variant_id || variant.id;
    remaining[id] = Math.max(0, Math.round(Math.min(needed, expected)));
  });
  return remaining;
}

function decisiveShare({ variants, remaining, plan, runs, innerDraws, random }) {
  const level = decisionLevel(plan);
  const list = variants.map((variant) => ({
    variant_id: variant.variant_id || variant.id,
    variant_name: variant.variant_name || variant.name || '',
    visitors: Number(variant.visitors) || 0,
    conversions: Number(variant.conversions) || 0,
  }));
  let decisive = 0;
  for (let run = 0; run < runs; run += 1) {
    const simulated = list.map((variant) => {
      const extra = Math.max(0, Math.round(remaining[variant.variant_id] || 0));
      const alpha = 1 + variant.conversions;
      const beta = 1 + Math.max(variant.visitors - variant.conversions, 0);
      const rate = sampleBeta(alpha, beta, random);
      const more = sampleBinomial(extra, rate, random);
      const visitors = variant.visitors + extra;
      return {
        variant_id: variant.variant_id,
        variant_name: variant.variant_name,
        visitors,
        conversions: Math.min(visitors, variant.conversions + more),
      };
    });
    const control = simulated[controlIndex(simulated)];
    let called = false;
    for (const challenger of simulated) {
      if (challenger === control) continue;
      if ((Number(challenger.visitors) || 0) <= 0 && (Number(control.visitors) || 0) <= 0) continue;
      const pair = posteriorPair(control, challenger, random, innerDraws);
      const decision = intervalExcludesZero(pair.samples, level);
      if (decision.side === 'win' || decision.side === 'loss') called = true;
    }
    if (called) decisive += 1;
  }
  return runs > 0 ? decisive / runs : null;
}

function bandFor(pDecisive, shortfall) {
  if (pDecisive == null || !Number.isFinite(pDecisive)) return 'none';
  if (pDecisive >= 0.30) return 'none';
  if (pDecisive >= 0.10) return 'amber';
  if (shortfall) return 'unlikely';
  return 'low';
}

function assessFutility(input) {
  const raw = input || {};
  const variants = (raw.variants || []).filter((variant) => variant && variant.enabled !== false);
  const now = raw.now ? new Date(raw.now) : new Date();
  const startedAt = raw.startedAt ? new Date(raw.startedAt) : now;
  const visitors = variants.reduce((sum, variant) => sum + (Number(variant.visitors) || 0), 0);
  const perVariant = Number(raw.visitorsPerVariant) || 0;
  const plannedVisitors = perVariant > 0 ? perVariant * Math.max(variants.length, 1) : 0;
  const dailyRate = Math.max(0, Number(raw.dailyRate) || 0);
  const estimatedDays = Number(raw.estimatedDays) || 0;
  const elapsedDays = Math.max(0, (now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000));
  const horizonDays = estimatedDays > 0
    ? Math.min(Math.ceil(estimatedDays * HORIZON_MULTIPLIER), HARD_CAP_DAYS)
    : HARD_CAP_DAYS;
  const capDate = addDays(startedAt, horizonDays);
  const daysLeft = Math.max(0, (capDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const plannedEnd = estimatedDays > 0 ? addDays(startedAt, estimatedDays) : null;
  const remainingVisitors = Math.max(0, plannedVisitors - visitors);
  const daysNeeded = dailyRate > 0 ? remainingVisitors / dailyRate : Infinity;
  const projectedEnd = Number.isFinite(daysNeeded) ? addDays(now, daysNeeded) : null;
  const pastCap = remainingVisitors > 0 && (!projectedEnd || projectedEnd.getTime() > capDate.getTime());
  const shortfall = remainingVisitors > 0 && (
    plannedEnd
      ? (!projectedEnd || projectedEnd.getTime() > plannedEnd.getTime())
      : pastCap
  );
  const plannedDaily = estimatedDays > 0 && plannedVisitors > 0
    ? plannedVisitors / estimatedDays
    : Math.max(0, Number(raw.plannedDaily) || 0);
  const trafficLow = elapsedDays >= TRAFFIC_LOW_MIN_DAYS
    && plannedDaily > 0
    && dailyRate < plannedDaily * TRAFFIC_LOW_RATIO;
  const progressPct = plannedVisitors > 0 ? (visitors / plannedVisitors) * 100 : 0;

  let pDecisive = null;
  let trafficOnly = false;
  let band = 'none';

  if (raw.skipSimulation) {
    band = 'none';
  } else if (pastCap) {
    trafficOnly = true;
    band = 'unlikely';
  } else if (variants.length >= 2 && remainingVisitors > 0) {
    const runs = raw.runs || DEFAULT_RUNS;
    const innerDraws = raw.innerDraws || DEFAULT_INNER_DRAWS;
    const seed = hashSeed([
      raw.seed || 'futility',
      visitors,
      variants.map((variant) => [
        variant.variant_id || variant.id || '',
        variant.visitors || 0,
        variant.conversions || 0,
      ].join(':')).join('|'),
    ].join('|'));
    const random = raw.random || mulberry32(seed);
    const remaining = remainingByVariant(variants, perVariant, dailyRate, daysLeft);
    pDecisive = decisiveShare({
      variants,
      remaining,
      plan: raw.plan,
      runs,
      innerDraws,
      random,
    });
    band = bandFor(pDecisive, shortfall);
  }

  return {
    band,
    trafficOnly,
    pastCap,
    shortfall,
    pDecisive,
    projectedEnd,
    capDate,
    progressPct,
    progressPctBand: roundProgressBand(progressPct),
    trafficLow,
    visitors,
    plannedVisitors,
    dailyRate,
    daysLeft,
    readyLabel: readyLabel(projectedEnd, now, { unlikely: band === 'unlikely' }),
  };
}

module.exports = {
  HARD_CAP_DAYS,
  HORIZON_MULTIPLIER,
  DEFAULT_RUNS,
  DEFAULT_INNER_DRAWS,
  TRAFFIC_LOW_RATIO,
  sampleBinomial,
  remainingByVariant,
  decisiveShare,
  bandFor,
  assessFutility,
};
