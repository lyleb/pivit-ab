const express = require('express');
const db = require('../db');
const { isLikelyBot, isRateLimited } = require('../bot-filter');
const { checkHost, originHostFromRequest, hostScopingMode } = require('../host-scope');
const { scheduleEventDrop } = require('../event-drops');
const { requestIsTestTraffic } = require('../test-traffic');
const { publicScope } = require('../tenant');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dropLogged = new Set();

function warnDrop(experimentId, host, reason) {
  const key = `${experimentId}|${host || ''}|${reason}`;
  if (dropLogged.has(key)) return;
  if (dropLogged.size > 2000) dropLogged.clear();
  dropLogged.add(key);
  console.warn(`[host-scope] dropped event for ${experimentId} (${reason}) host=${host || 'unknown'}`);
}

// POST /api/event
// body: { experiment_id, variant_id, visitor_id, event_type, goal_id?, is_test? }
//
// is_test is optional. Omit it for a real visitor (the same body as before).
// Send is_test: true, header X-Pivit-Test: 1, or ?pivit_qa=1 to mark the row.
// A visitor id starting with v_pt is always test traffic. The snippet sends
// the JSON field, not the header: sendBeacon cannot set headers.
router.post('/', async (req, res) => {
  const { experiment_id, variant_id, visitor_id, event_type, goal_id } = req.body;

  if (!experiment_id || !variant_id || !visitor_id || !event_type) {
    return res.status(400).json({ error: 'experiment_id, variant_id, visitor_id, event_type are required' });
  }
  if (!['view', 'click', 'convert'].includes(event_type)) {
    return res.status(400).json({ error: 'event_type must be view, click, or convert' });
  }
  if (!UUID_RE.test(experiment_id) || !UUID_RE.test(variant_id)) {
    return res.status(400).json({ error: 'experiment_id and variant_id must be UUIDs' });
  }

  // Basic bot/abuse filtering — dropped silently (still 204) rather than
  // erroring, since a sendBeacon caller never looks at the response anyway and
  // there's no reason to reveal to a bot that it was filtered. The drop is
  // counted for the owner health panel. A counter failure must not change
  // this response. See src/bot-filter.js and src/event-drops.js.
  const bot = isLikelyBot(req.get('user-agent'));
  const limited = !bot && isRateLimited(req.ip);
  if (bot || limited) {
    scheduleEventDrop(experiment_id, bot ? 'bot' : 'rate_limited');
    return res.status(204).end();
  }

  try {
    const scope = await publicScope(req.body && req.body.site);
    const { rows } = await db.query(
      `SELECT e.allowed_hosts, e.account_id, e.site_id
       FROM variants v
       JOIN experiments e ON e.id = v.experiment_id
       WHERE v.id = $1 AND v.experiment_id = $2`,
      [variant_id, experiment_id]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'variant does not belong to experiment' });
    }

    // A site key reaches only that site. A tag with no key reaches only the
    // legacy account, using the same host rules as before. A bad or unknown
    // key does not fall back to the legacy account. The drop is silent, same
    // as a host that is not on the list.
    const row = rows[0];
    const wrongAccount = !scope.ok
      || (scope.legacy ? row.account_id !== scope.accountId : row.site_id !== scope.siteId);
    if (wrongAccount) {
      warnDrop(experiment_id, originHostFromRequest(req), scope.ok ? 'account' : 'site-key');
      scheduleEventDrop(experiment_id, 'host');
      return res.status(204).end();
    }

    // Origin/Referer only. A known host outside the list is dropped. An
    // unknown host on a scoped experiment is still stored (the beacon often
    // has no page URL). Unscoped experiments are dropped only in enforce.
    // Status is not checked here — that is PIV-017.
    const pageHost = originHostFromRequest(req);
    const decision = checkHost(rows[0].allowed_hosts, pageHost, hostScopingMode());
    const drop = !decision.serve && decision.reason !== 'host-unknown';
    if (drop) {
      warnDrop(experiment_id, pageHost, decision.reason);
      scheduleEventDrop(experiment_id, 'host');
      return res.status(204).end();
    }

    const isTest = requestIsTestTraffic(req);
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id, is_test)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [experiment_id, variant_id, visitor_id, event_type, goal_id ?? null, isTest]
    );
    // 204 keeps the beacon call cheap — no body needed on the client.
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
