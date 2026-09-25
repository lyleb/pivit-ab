const express = require('express');
const db = require('../db');
const { requireApiKey } = require('../middleware/auth');
const router = express.Router();

router.use(requireApiKey); // results are for your eyes only, not the public snippet

// GET /api/results/:experimentId
// Returns per-variant counts: unique visitors, views, clicks, conversions, conversion rate.
router.get('/:experimentId', async (req, res) => {
  const { experimentId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'click') AS clicks,
         COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name
       ORDER BY v.name`,
      [experimentId]
    );

    const results = rows.map((r) => ({
      ...r,
      visitors: Number(r.visitors),
      clicks: Number(r.clicks),
      conversions: Number(r.conversions),
      conversion_rate: r.visitors > 0 ? +(r.conversions / r.visitors * 100).toFixed(2) : 0,
    }));

    res.json({ experiment_id: experimentId, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
