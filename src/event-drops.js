// Daily counts of events the public endpoint accepted and then dropped.
// Same shape as the host-hit counter: one upsert per day, not one row per
// event. A failure here must never fail POST /api/event — the response stays
// 204, which is what the snippet already expects.

const db = require('./db');
const { utcDay } = require('./host-hits');

const UPSERT_SQL = `INSERT INTO event_drops (day, experiment_id, reason, drop_count)
  VALUES ($1::date, $2::uuid, $3, 1)
  ON CONFLICT (day, experiment_id, reason)
  DO UPDATE SET drop_count = event_drops.drop_count + 1`;

const REASONS = ['rate_limited', 'bot', 'host'];

function scheduleEventDrop(experimentId, reason, queryFn = db.query.bind(db), now = new Date()) {
  try {
    if (!experimentId || !REASONS.includes(reason)) return Promise.resolve();
    return Promise.resolve(queryFn(UPSERT_SQL, [utcDay(now), experimentId, reason])).catch((err) => {
      // A made-up experiment id fails the foreign key. That is not a fault.
      if (err && err.code === '23503') return;
      console.error('[event-drops] counter failed:', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('[event-drops] counter failed:', err && err.message ? err.message : err);
    return Promise.resolve();
  }
}

module.exports = {
  UPSERT_SQL,
  REASONS,
  scheduleEventDrop,
};
