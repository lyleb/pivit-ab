// Cloudflare Turnstile is ready and switched off. It runs only when
// TURNSTILE_SECRET_KEY is set. Invite-only sign-up leaves that unset.

async function turnstileOk(req) {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return true;
  const token = req && req.body && req.body.turnstile_token;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', String(token));
  if (req.ip) body.set('remoteip', String(req.ip));
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  return data.success === true;
}

module.exports = { turnstileOk };
