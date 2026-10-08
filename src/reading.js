// What the owner and the client are allowed to see.
//
// A stored plan that is not finished yet is blind: health, progress and the
// traffic split, unless the owner has used Reveal early.
// No stored plan is not a lock. The numbers stay visible, with a nudge to
// adopt a plan. That is how already-running tests keep their results.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysElapsed(startedAt, now) {
  if (!startedAt) return 0;
  const ms = new Date(now).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

function planProgress({ plan, startedAt, now, variants }) {
  if (!plan) {
    return {
      has_plan: false,
      days_elapsed: daysElapsed(startedAt, now),
      min_runtime_days: null,
      runtime_met: false,
      sample_met: false,
      plan_met: false,
      variants: (variants || []).map((variant) => ({
        variant_id: variant.variant_id || variant.id,
        variant_name: variant.variant_name || variant.name,
        visitors: Number(variant.visitors) || 0,
        target: null,
        traffic_split: variant.traffic_split,
        enabled: variant.enabled !== false,
        sample_met: false,
      })),
    };
  }
  const target = Number(plan.visitors_per_variant) || 0;
  const minDays = Number(plan.min_runtime_days) || 0;
  const elapsed = daysElapsed(startedAt, now || new Date());
  const rows = (variants || []).map((variant) => {
    const visitors = Number(variant.visitors) || 0;
    return {
      variant_id: variant.variant_id || variant.id,
      variant_name: variant.variant_name || variant.name,
      visitors,
      target,
      traffic_split: variant.traffic_split,
      enabled: variant.enabled !== false,
      sample_met: target > 0 && visitors >= target,
    };
  });
  const gating = rows.filter((row) => row.enabled);
  const sampleMet = target > 0 && gating.length > 0 && gating.every((row) => row.sample_met);
  const runtimeMet = minDays > 0 && elapsed >= minDays;
  return {
    has_plan: true,
    days_elapsed: elapsed,
    min_runtime_days: minDays,
    runtime_met: runtimeMet,
    sample_met: sampleMet,
    plan_met: sampleMet && runtimeMet,
    variants: rows,
  };
}

function describeReading({ status, plan, peekedAt, progress, srmDetected }) {
  const peeked = !!peekedAt;
  const hasPlan = !!(plan && plan.visitors_per_variant);
  if (status === 'draft') {
    return { mode: 'draft', outcome_visible: false, peeked: false, plan_met: false, has_plan: hasPlan };
  }
  if (!hasPlan) {
    return { mode: 'unplanned', outcome_visible: true, peeked, plan_met: false, has_plan: false };
  }
  const planMet = !!(progress && progress.plan_met);
  if (planMet && srmDetected) {
    return { mode: 'data_problem', outcome_visible: true, peeked, plan_met: true, has_plan: true };
  }
  if (planMet) {
    return { mode: 'verdict', outcome_visible: true, peeked, plan_met: true, has_plan: true };
  }
  if (peeked) {
    return { mode: 'peeked', outcome_visible: true, peeked: true, plan_met: false, has_plan: true };
  }
  return { mode: 'blind', outcome_visible: false, peeked: false, plan_met: false, has_plan: true };
}

function hideOutcomeRow(row) {
  return {
    variant_id: row.variant_id,
    variant_name: row.variant_name,
    visitors: row.visitors,
    new_visitors: row.new_visitors,
    returning_visitors: row.returning_visitors,
    traffic_split: row.traffic_split,
  };
}

function publicPlan(plan) {
  if (!plan) return null;
  return {
    source: plan.source || 'owner',
    sentence: plan.sentence || '',
    explanation: plan.explanation || '',
    baseline_rate: plan.baseline_rate,
    baseline_source: plan.baseline_source || '',
    baseline_label: plan.baseline_label || '',
    relative_effect: plan.relative_effect,
    effect_choice: plan.effect_choice || 'custom',
    weekly_traffic: plan.weekly_traffic,
    traffic_source: plan.traffic_source || '',
    traffic_label: plan.traffic_label || '',
    visitors_per_variant: plan.visitors_per_variant,
    estimated_days: plan.estimated_days,
    estimated_weeks: plan.estimated_weeks,
    min_runtime_days: plan.min_runtime_days,
    comparisons: plan.comparisons,
    variant_count: plan.variant_count,
    bonferroni: !!plan.bonferroni,
    alpha: plan.alpha,
    alpha_per_comparison: plan.alpha_per_comparison,
    power: plan.power,
    runtime_warning: plan.runtime_warning || '',
    method: plan.method || '',
  };
}

function listSignal(status, reading) {
  if (status === 'draft') return 'No data yet';
  const mode = reading && reading.mode;
  const days = reading ? Number(reading.days_elapsed) || 0 : 0;
  const min = reading ? Number(reading.min_runtime_days) || 0 : 0;
  if (mode === 'unplanned') {
    if (status === 'paused') return 'Paused · set a plan';
    if (status === 'archived') return 'Set a plan';
    return 'Set a plan';
  }
  if (mode === 'data_problem') return status === 'paused' ? 'Paused · data problem' : 'Data problem';
  if (mode === 'verdict') return status === 'paused' ? 'Paused · verdict ready' : 'Verdict ready';
  if (mode === 'peeked') return 'Peeked · not a verdict';
  if (mode === 'blind' || status === 'running' || status === 'paused') {
    const head = status === 'paused' ? 'Paused · health check' : 'Health check';
    if (min) return `${head} · ${days} of ${min} days`;
    if (status === 'running' || status === 'paused') return head;
  }
  if (reading && Number(reading.total_visitors) > 0) return 'Health check';
  return 'No data yet';
}

module.exports = {
  daysElapsed,
  planProgress,
  describeReading,
  hideOutcomeRow,
  publicPlan,
  listSignal,
};
