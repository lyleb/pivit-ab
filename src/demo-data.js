const crypto = require('crypto');

// Generates a plausible-looking set of view/convert events for a demo — spread
// across `days` with some day-to-day noise, at roughly `visitorsPerDay` total
// (split across variants by their traffic_split), each variant converting at
// roughly its target rate. Pure function (no DB access) so the shape and
// randomness can be tested directly.
//
// @param {Array<{id, traffic_split}>} variants
// @param {Object} rates - { [variantId]: targetRatePercent }
// @param {number} days
// @param {number} visitorsPerDay
// @returns {Array<{variant_id, visitor_id, event_type, created_at}>}
function generateDemoEvents(variants, rates, days, visitorsPerDay) {
  const events = [];
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
    const dayStart = now - dayOffset * DAY_MS;

    variants.forEach((v) => {
      const share = (v.traffic_split || 0) / 100;
      // +/-30% day-to-day noise so it doesn't look like a perfectly flat robot-generated line.
      const noiseFactor = 1 + (Math.random() - 0.5) * 0.6;
      const count = Math.max(0, Math.round(visitorsPerDay * share * noiseFactor));
      const rate = Math.min(Math.max((rates[v.id] ?? 5) / 100, 0), 1);

      for (let i = 0; i < count; i++) {
        const visitorId = 'demo_' + crypto.randomBytes(6).toString('hex');
        // Cap at `now` so today's events can't land in the future — a random
        // pick anywhere in "today's 24h window" would otherwise overshoot.
        const viewTime = new Date(Math.min(dayStart + Math.random() * DAY_MS, now));
        events.push({ variant_id: v.id, visitor_id: visitorId, event_type: 'view', created_at: viewTime });

        if (Math.random() < rate) {
          // Conversion happens sometime shortly after the view, same day, also capped at `now`.
          const convertTime = new Date(Math.min(viewTime.getTime() + Math.random() * 60 * 60 * 1000, now));
          events.push({ variant_id: v.id, visitor_id: visitorId, event_type: 'convert', created_at: convertTime });
        }
      }
    });
  }

  return events;
}

module.exports = { generateDemoEvents };
