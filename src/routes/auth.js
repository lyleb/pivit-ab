const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// Basic brute-force throttle: an in-memory counter per (ip + purpose), reset on
// success. Keyed separately for owner vs client logins so a burst of one doesn't
// lock out the other from the same IP (e.g. you testing both from your own
// machine). Intentionally simple, not a full rate-limiter — resets on server
// restart and doesn't share state across multiple instances. For a small tool
// behind one Railway service, that's an acceptable trade-off; it stops casual
// guessing without adding new infrastructure.
const failedAttempts = new Map(); // "ip:purpose" -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

function checkThrottle(key) {
  const record = failedAttempts.get(key);
  if (record && record.lockedUntil > Date.now()) {
    return Math.ceil((record.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function recordFailure(key) {
  const record = failedAttempts.get(key);
  const attempts = (record ? record.count : 0) + 1;
  const lockedUntil = attempts >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
  failedAttempts.set(key, { count: attempts, lockedUntil });
}
function clearThrottle(key) {
  failedAttempts.delete(key);
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Lengths almost always differ trivially for a wrong guess; compare against a
  // fixed-length buffer first so the length check itself isn't a timing signal.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing consistent with the equal-length path
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// POST /api/auth/login  { password }  — owner login
router.post('/login', (req, res) => {
  const key = `${req.ip}:owner`;
  const secondsLeft = checkThrottle(key);
  if (secondsLeft) return res.status(429).json({ error: `too many attempts — try again in ${secondsLeft}s` });

  const { password } = req.body;
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    console.error('[auth] ADMIN_API_KEY is not set — refusing all logins.');
    return res.status(500).json({ error: 'server misconfigured: ADMIN_API_KEY not set' });
  }

  if (!password || !timingSafeStringEqual(password, expected)) {
    recordFailure(key);
    return res.status(401).json({ error: 'incorrect password' });
  }

  clearThrottle(key);
  req.session.role = 'owner';
  req.session.save((err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'internal error', detail: err.message });
    }
    res.json({ role: 'owner' });
  });
});

// POST /api/auth/client-login  { username, password }
router.post('/client-login', async (req, res) => {
  const key = `${req.ip}:client`;
  const secondsLeft = checkThrottle(key);
  if (secondsLeft) return res.status(429).json({ error: `too many attempts — try again in ${secondsLeft}s` });

  try {
    const { username, password } = req.body;
    if (!username || !password) {
      recordFailure(key);
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    const { rows } = await db.query(`SELECT * FROM clients WHERE lower(username) = lower($1)`, [username]);
    const client = rows[0];
    // Compare against a real hash either way (a dummy one if no such user), so a
    // nonexistent username doesn't respond measurably faster than a wrong password.
    const hashToCheck = client ? client.password_hash : '$2a$10$NkmxwflYhEay0SNGZxbNS.eqI/bFwsaaO5tgi9FByvHT4vbyApUJ.';
    const passwordOk = await bcrypt.compare(password, hashToCheck);

    if (!client || !passwordOk) {
      recordFailure(key);
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    clearThrottle(key);
    req.session.role = 'client';
    req.session.clientId = client.id;
    req.session.clientName = client.name;
    req.session.save((err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'internal error', detail: err.message });
      }
      res.json({ role: 'client', client: { id: client.id, name: client.name } });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/auth/logout — works for either role
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'internal error', detail: err.message });
    }
    res.clearCookie('pivit.sid');
    res.status(204).end();
  });
});

// GET /api/auth/me — lets the dashboard/client page check login state on load
// without storing anything itself; the session cookie (if any) does the work.
router.get('/me', (req, res) => {
  const role = (req.session && req.session.role) || null;
  const client = role === 'client' ? { id: req.session.clientId, name: req.session.clientName } : null;
  res.json({ role, client });
});

module.exports = router;
