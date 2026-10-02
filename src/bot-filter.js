// Basic, heuristic protection for the public POST /api/event endpoint — not a
// full bot-detection system (nothing simple is), just enough to stop obvious
// crawlers and casual flooding from quietly polluting real results. Matched
// requests are dropped silently (the endpoint still returns 204, since
// sendBeacon callers never check the response anyway) rather than erroring,
// so nothing about the response reveals that filtering happened.

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

// Simple sliding-window per-IP rate limit — in-memory, resets on restart, not
// shared across multiple instances. That's an acceptable trade-off here: the
// goal is catching an obvious scripted flood, not building a production rate
// limiter. The threshold is generous (60/min) so it never affects a real
// visitor's browser, which doesn't generate anywhere near that many events.
const WINDOW_MS = 60 * 1000;
const MAX_EVENTS_PER_WINDOW = 60;
const requestCounts = new Map(); // ip -> { count, windowStart }

function isRateLimited(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  record.count += 1;
  return record.count > MAX_EVENTS_PER_WINDOW;
}

module.exports = { isLikelyBot, isRateLimited };
