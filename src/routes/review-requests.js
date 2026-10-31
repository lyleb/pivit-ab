const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { refuseViewOnly } = require('../membership-access');
const { listOpenReviews, decideReview } = require('../review-request');

const router = express.Router();
router.use(requireAuth(['owner']));

// GET /api/review-requests — open client requests for this account.
router.get('/', async (req, res) => {
  try {
    const requests = await listOpenReviews(req.account.id);
    res.set('Cache-Control', 'no-store');
    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/review-requests/:id/decide — the owner has seen it.
// This does not stop the test or reveal a result.
router.post('/:id/decide', async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id FROM review_requests WHERE id = $1 AND account_id = $2`,
      [req.params.id, req.account.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'no review request found with that id' });
    if (refuseViewOnly(req, res)) return;
    const row = await decideReview({
      requestId: req.params.id,
      accountId: req.account.id,
      actor: 'owner',
      ip: req.ip,
    });
    if (!row) return res.status(404).json({ error: 'no review request found with that id' });
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
