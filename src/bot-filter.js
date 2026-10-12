// Basic, heuristic protection for the public POST /api/event endpoint — not a
// full bot-detection system (nothing simple is), just enough to stop obvious
// crawlers from quietly polluting real results. Matched requests are dropped
// silently (the endpoint still returns 204, since sendBeacon callers never
// check the response anyway) rather than erroring, so nothing about the
// response reveals that filtering happened. The per-IP event cap lives in
// Postgres (src/rate-limit.js) so it is shared across instances.

// Known crawler/bot/monitoring User-Agent signatures. Deliberately does NOT
// flag "headless" on its own — some legitimate automation uses a headless
// browser — only names actually known to be bots/crawlers/monitors.
const BOT_UA_PATTERNS = [
  /bot/i, /spider/i, /crawl/i, /slurp/i,
  /facebookexternalhit/i, /pingdom/i, /uptimerobot/i,
  /ahrefsbot/i, /semrushbot/i, /mj12bot/i, /dotbot/i, /petalbot/i,
  /phantomjs/i, /headlesschrome/i,
];

function isLikelyBot(userAgent) {
  if (!userAgent) return true; // a real browser always sends one
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

module.exports = { isLikelyBot };
