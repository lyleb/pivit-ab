// Demo tests are a separate type. They count test traffic only, use a fixed
// sample, and skip the 14-day minimum runtime. A live plan cannot opt into
// that skip: buildPlan still refuses fewer than 7 days, and the waiver is
// set only here.

const DEMO_VISITORS_PER_VARIANT = 100;

const RUNTIME_NOTE = 'The 14-day minimum runtime is skipped because this is a demo test. That is only allowed for a demo test. A live test still waits at least 14 days.';

const SWITCH_ERROR = 'A demo test cannot be switched to live.';

const PLAN_LOCKED_ERROR = 'A demo test uses a fixed sample of 100 visitors per variant. The plan cannot be changed, and the test cannot be switched to live.';

function isDemo(experiment) {
  if (!experiment) return false;
  if (experiment.test_type === 'demo') return true;
  return !!(experiment.plan && experiment.plan.demo === true && experiment.test_type == null);
}

function normaliseTestType(value) {
  if (value == null || value === '' || value === 'live') return { ok: true, type: 'live' };
  if (value === 'demo') return { ok: true, type: 'demo' };
  return { ok: false, error: 'Test type must be live or demo.' };
}

function typeChangeError(existing, body) {
  if (!existing || !body || typeof body !== 'object') return null;
  if (body.test_type == null && body.demo == null) return null;
  const requested = body.test_type != null
    ? String(body.test_type)
    : (body.demo ? 'demo' : 'live');
  if (requested === existing.test_type) return null;
  if (existing.test_type === 'demo') return SWITCH_ERROR;
  return 'A live test cannot be changed into a demo.';
}

function comparisonsFor(variantCount) {
  const n = Math.max(2, Math.round(Number(variantCount) || 2));
  return { variantCount: n, comparisons: n - 1 };
}

function demoPlan(input) {
  const { variantCount, comparisons } = comparisonsFor(input && input.variantCount);
  const alphaPerComparison = 0.05 / comparisons;
  const percent = +(alphaPerComparison * 100).toFixed(2);
  const percentText = Number.isInteger(percent) ? String(percent) : String(percent);
  const multiple = comparisons > 1
    ? ` There are ${comparisons} challengers against Control. Each comparison uses a stricter ${percentText}% bar (Bonferroni).`
    : '';
  return {
    demo: true,
    runtime_waived: true,
    test_traffic_only: true,
    baseline_rate: null,
    baseline_source: 'demo',
    baseline_label: '',
    relative_effect: null,
    effect_choice: 'demo',
    weekly_traffic: null,
    traffic_source: 'demo',
    traffic_label: '',
    visitors_per_variant: DEMO_VISITORS_PER_VARIANT,
    estimated_days: null,
    estimated_weeks: null,
    min_runtime_days: 0,
    whole_weeks: false,
    power: null,
    alpha: 0.05,
    alpha_per_comparison: +alphaPerComparison.toFixed(6),
    comparisons,
    variant_count: variantCount,
    planned_variants: variantCount,
    weights: null,
    method: 'demo-fixed-sample',
    source: 'demo',
    sentence: `Demo test. ${DEMO_VISITORS_PER_VARIANT} visitors per variant, using test traffic only.`,
    explanation: `This is a demo test on pivitlab. It counts pivit_qa, is_test and v_pt visitors only. Real visitors are ignored and are not bucketed. The planned sample is fixed at ${DEMO_VISITORS_PER_VARIANT} visitors per variant. ${RUNTIME_NOTE} A demo test cannot be switched to live.${multiple}`,
    bonferroni: comparisons > 1,
    runtime_warning: RUNTIME_NOTE,
  };
}

function runtimeWaived(plan) {
  return !!(plan && plan.demo === true && plan.runtime_waived === true);
}

// How this experiment's own events are counted. A demo never mixes in real
// visitors. A live test keeps the previous include-test choice.
function countOptions(experiment, includeTest) {
  if (isDemo(experiment)) return { testOnly: true };
  return { includeTest: !!includeTest };
}

module.exports = {
  DEMO_VISITORS_PER_VARIANT,
  RUNTIME_NOTE,
  SWITCH_ERROR,
  PLAN_LOCKED_ERROR,
  isDemo,
  normaliseTestType,
  typeChangeError,
  demoPlan,
  runtimeWaived,
  countOptions,
};
