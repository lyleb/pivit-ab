const express = require('express');
const db = require('../db');
const { timingSafeStringEqual } = require('../timing');
const { recordAudit } = require('../audit');
const { publicServerError } = require('../public-error');

const router = express.Router();

// Optional. Postmark calls this only when POSTMARK_WEBHOOK_TOKEN is set and
// the same value is configured as a custom header on the webhook. Until then
// the route is not there. API send failures are logged in src/mailer.js.
router.post('/postmark', async (req, res) => {
  const expected = String(process.env.POSTMARK_WEBHOOK_TOKEN || '').trim();
  if (!expected) return res.status(404).json({ error: 'not found' });
  const got = req.get('x-postmark-token') || '';
  if (!timingSafeStringEqual(got, expected)) return res.status(401).json({ error: 'not authorised' });
  try {
    const record = req.body || {};
    const type = String(record.RecordType || '').toLowerCase();
    if (type === 'bounce' || type === 'spamcomplaint') {
      console.log('[email] postmark', type, record.Type || '', record.Email || '');
      await recordAudit(db, {
        action: 'email_bounce',
        actorLabel: 'postmark',
        targetType: 'email',
        targetId: String(record.Email || '').slice(0, 200),
        detail: {
          record_type: type,
          type: String(record.Type || '').slice(0, 80),
          description: String(record.Description || record.Name || '').slice(0, 300),
        },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
