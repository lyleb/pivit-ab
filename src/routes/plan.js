const express = require('express');
const { suggest, savePlan, loadReading, readingPayload } = require('../experiment-plan');
const { buildPlan } = require('../plan');

const router = express.Router({ mergeParams: true });

// GET /api/experiments/:id/plan
// Stored plan, plus a pre-filled suggestion the owner can accept unchanged.
router.get('/', async (req, res) => {
  try {
    const suggestion = await suggest(req.params.id, undefined, req.account.id);
    if (!suggestion) return res.status(404).json({ error: 'no experiment found with that id' });
    const loaded = await loadReading(req.params.id, { includeTest: false, accountId: req.account.id });
    const variants = (suggestion.variants || []).filter((variant) => variant.enabled);
    const weights = variants.length >= 2 ? variants.map((variant) => variant.traffic_split) : null;
    const draft = buildPlan({
      baseline_rate: suggestion.baseline_rate,
      baseline_source: suggestion.baseline_source,
      baseline_label: suggestion.baseline_label,
      relative_effect: 0.1,
      effect_choice: 'medium',
      weekly_traffic: suggestion.weekly_traffic,
      traffic_source: suggestion.traffic_source,
      traffic_label: suggestion.traffic_label,
      min_runtime_days: 14,
      variant_count: Math.max(variants.length, 2),
      weights,
      source: 'auto',
    });
    res.json({
      plan: loaded && loaded.experiment.plan ? loaded.experiment.plan : null,
      suggestion: {
        baseline_rate: suggestion.baseline_rate,
        baseline_source: suggestion.baseline_source,
        baseline_label: suggestion.baseline_label,
        weekly_traffic: suggestion.weekly_traffic,
        traffic_source: suggestion.traffic_source,
        traffic_label: suggestion.traffic_label,
        variant_count: variants.length,
      },
      preview: draft.ok ? draft.plan : null,
      reading: readingPayload(loaded),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/experiments/:id/plan/preview
// Calculates the sentence without saving.
router.post('/preview', async (req, res) => {
  try {
    const suggestion = await suggest(req.params.id, undefined, req.account.id);
    if (!suggestion) return res.status(404).json({ error: 'no experiment found with that id' });
    const variants = (suggestion.variants || []).filter((variant) => variant.enabled);
    const body = req.body || {};
    const built = buildPlan({
      baseline_rate: body.baseline_rate != null ? body.baseline_rate : suggestion.baseline_rate,
      baseline_source: body.baseline_source || suggestion.baseline_source,
      baseline_label: body.baseline_label || suggestion.baseline_label,
      relative_effect: body.relative_effect,
      effect_choice: body.effect_choice || 'medium',
      weekly_traffic: body.weekly_traffic != null ? body.weekly_traffic : suggestion.weekly_traffic,
      traffic_source: body.traffic_source || suggestion.traffic_source,
      traffic_label: body.traffic_label || suggestion.traffic_label,
      min_runtime_days: body.min_runtime_days,
      variant_count: variants.length || suggestion.variant_count || 2,
      weights: variants.length >= 2 ? variants.map((variant) => variant.traffic_split) : null,
      source: body.source === 'auto' ? 'auto' : 'owner',
    });
    if (!built.ok) return res.status(400).json({ error: built.error });
    res.json({ plan: built.plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PUT /api/experiments/:id/plan
router.put('/', async (req, res) => {
  try {
    const result = await savePlan(req.params.id, req.body || {}, undefined, req.account.id);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json({ plan: result.plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
