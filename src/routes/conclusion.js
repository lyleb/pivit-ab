const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ownedExperiment } = require('../tenant');
const { refuseViewOnly } = require('../membership-access');
const {
  MISSING,
  conclusionStatus,
  draftConclusion,
  releaseConclusion,
  ownerPdf,
  listNotices,
  markNoticeRead,
  deliverPdf,
} = require('../conclusion');

const ownerRouter = express.Router();
const ownerOnly = requireAuth(['owner']);

function actor(req) {
  return {
    actor: 'owner',
    userId: req.session && req.session.userId,
    ip: req.ip,
    accountId: req.account.id,
    experimentId: req.params.id,
  };
}

ownerRouter.get('/:id/conclusion', ownerOnly, async (req, res) => {
  try {
    const status = await conclusionStatus(req.account.id, req.params.id);
    if (!status) return res.status(404).json({ error: MISSING });
    res.set('Cache-Control', 'no-store');
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

ownerRouter.post('/:id/conclusion', ownerOnly, async (req, res) => {
  try {
    const existing = await ownedExperiment(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: MISSING });
    if (refuseViewOnly(req, res)) return;
    const result = await draftConclusion(actor(req));
    if (result.error === 'missing') return res.status(404).json({ error: MISSING });
    if (result.error === 'unavailable') return res.status(400).json({ error: result.message });
    if (result.error === 'released') return res.status(409).json({ error: result.message });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

ownerRouter.post('/:id/conclusion/release', ownerOnly, async (req, res) => {
  try {
    const existing = await ownedExperiment(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: MISSING });
    if (refuseViewOnly(req, res)) return;
    const result = await releaseConclusion(actor(req));
    if (result.error === 'missing') return res.status(404).json({ error: MISSING });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

ownerRouter.get('/:id/conclusion.pdf', ownerOnly, async (req, res) => {
  try {
    const file = await ownerPdf(req.account.id, req.params.id, 'conclusion');
    if (!deliverPdf(res, file)) return res.status(404).json({ error: MISSING });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

ownerRouter.get('/:id/approval.pdf', ownerOnly, async (req, res) => {
  try {
    const file = await ownerPdf(req.account.id, req.params.id, 'approval');
    if (!deliverPdf(res, file)) return res.status(404).json({ error: MISSING });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

const noticesRouter = express.Router();
noticesRouter.use(requireAuth(['owner']));

noticesRouter.get('/', async (req, res) => {
  try {
    const notices = await listNotices(req.account.id);
    res.set('Cache-Control', 'no-store');
    res.json({ notices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

noticesRouter.post('/:id/read', async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id FROM owner_notices WHERE id = $1 AND account_id = $2`,
      [req.params.id, req.account.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'no notice found with that id' });
    if (refuseViewOnly(req, res)) return;
    const row = await markNoticeRead(req.account.id, req.params.id);
    if (!row) return res.status(404).json({ error: 'no notice found with that id' });
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = { ownerRouter, noticesRouter };
