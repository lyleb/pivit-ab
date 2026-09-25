// Simple API key check for admin-only routes.
// The public routes the snippet calls (GET /api/experiments, POST /api/event)
// are NOT protected by this — they need to be reachable from any visitor's browser.
// Everything that creates/edits/reads-sensitive data (creating experiments, adding
// variants, changing status, viewing results) goes through this.

function requireApiKey(req, res, next) {
  const provided = req.get('x-api-key');
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    // Fails closed: if you forget to set the key in your env, admin routes
    // refuse everything rather than silently running with no protection.
    console.error('[auth] ADMIN_API_KEY is not set — refusing admin requests.');
    return res.status(500).json({ error: 'server misconfigured: ADMIN_API_KEY not set' });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized — missing or invalid x-api-key header' });
  }

  next();
}

module.exports = { requireApiKey };
