const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { windowStartDay, summariseHostHits } = require('../host-hits');
const router = express.Router();

router.use(requireAuth(['owner']));

// GET /api/host-hits?days=30
// Owner-only. Last 30 days of snippet and public API hits, grouped by the
// request host (pivit.click, pivitlab.com, …) and the customer-site origin.
router.get('/', async (req, res) => {
  try {
    const { days, start } = windowStartDay(req.query.days);
    const { rows } = await db.query(
      `SELECT day::text AS day, host, referrer_origin, hit_count
       FROM host_hits
       WHERE day >= $1::date
       ORDER BY day DESC, hit_count DESC, host, referrer_origin`,
      [start]
    );
    const normalised = rows.map((row) => ({
      day: row.day,
      host: row.host,
      referrer_origin: row.referrer_origin,
      hit_count: Number(row.hit_count) || 0,
    }));
    res.json({ days, start, rows: normalised, by_host: summariseHostHits(normalised) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
