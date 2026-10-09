const express = require('express');
const db = require('../db');
const { publicServerError } = require('../public-error');
const { snippetSiteKey, resolveSessionAccount, legacyAccount } = require('../tenant');
const { timingSafeStringEqual } = require('../timing');
const { loginLocked, loginFailure, loginSuccess } = require('../rate-limit');
const { recordAudit, endUserSessions, endClientSessions } = require('../audit');
const {
  CUSTOMER_SESSION_MS,
  SUPERADMIN_SESSION_MS,
} = require('../session-lifetime');
const { turnstileOk } = require('../turnstile');
const {
  LINK_SENT,
  normaliseEmail,
  customerHost,
  requestSignIn,
  requestSignup,
  consumeLink,
  consumeCode,
} = require('../auth-flow');

const router = express.Router();

function startSession(req, fields) {
  return new Promise((resolve, reject) => {
    const apply = () => {
      req.session.role = fields.role;
      req.session.userId = fields.userId || null;
      req.session.accountId = fields.accountId || null;
      req.session.superadmin = fields.superadmin === true;
      req.session.customer = fields.customer === true;
      req.session.emergency = fields.emergency === true;
      req.session.signedInAt = Date.now();
      req.session.viewAsAccountId = null;
      if (fields.clientId) {
        req.session.clientId = fields.clientId;
        req.session.clientName = fields.clientName || null;
      }
      if (req.session.cookie && fields.maxAge) req.session.cookie.maxAge = fields.maxAge;
      if (typeof req.session.save === 'function') {
        req.session.save((err) => (err ? reject(err) : resolve()));
      } else resolve();
    };
    if (req.session && typeof req.session.regenerate === 'function') {
      req.session.regenerate((err) => (err ? reject(err) : apply()));
    } else apply();
  });
}

async function ownerFromPassword(req) {
  const legacy = await legacyAccount();
  const fields = {
    role: 'owner',
    emergency: true,
    customer: false,
    superadmin: false,
    maxAge: SUPERADMIN_SESSION_MS,
  };
  if (legacy) {
    fields.accountId = legacy.id;
    if (legacy.user_id) {
      fields.userId = legacy.user_id;
      const { rows } = await db.query(`SELECT is_superadmin FROM users WHERE id = $1`, [legacy.user_id]);
      fields.superadmin = !!(rows[0] && rows[0].is_superadmin);
    }
  }
  await startSession(req, fields);
  await recordAudit(db, {
    accountId: fields.accountId,
    userId: fields.userId,
    actorLabel: 'emergency',
    action: 'emergency_signin',
    ip: req.ip,
  });
}

// POST /api/auth/login  { password }  — emergency owner login
router.post('/login', async (req, res) => {
  const bucket = `login:owner:${req.ip || 'unknown'}`;
  try {
    const secondsLeft = await loginLocked(bucket);
    if (secondsLeft) return res.status(429).json({ error: `too many attempts — try again in ${secondsLeft}s` });

    const { password } = req.body || {};
    const expected = process.env.ADMIN_API_KEY;
    if (!expected) {
      console.error('[auth] ADMIN_API_KEY is not set — refusing all logins.');
      return res.status(500).json({ error: "Sign-in isn't available right now. Please try again later." });
    }

    if (!password || !timingSafeStringEqual(password, expected)) {
      await loginFailure(bucket);
      return res.status(401).json({ error: 'incorrect password' });
    }

    await loginSuccess(bucket);
    await ownerFromPassword(req);
    res.json({ role: 'owner' });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// POST /api/auth/client-login  { username, password }
router.post('/client-login', async (req, res) => {
  const bucket = `login:client:${req.ip || 'unknown'}`;
  try {
    const secondsLeft = await loginLocked(bucket);
    if (secondsLeft) return res.status(429).json({ error: `too many attempts — try again in ${secondsLeft}s` });

    const { username, password } = req.body || {};
    if (!username || !password) {
      await loginFailure(bucket);
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    const { rows } = await db.query(`SELECT * FROM clients WHERE lower(username) = lower($1)`, [username]);
    const client = rows[0];
    const bcrypt = require('bcryptjs');
    const hashToCheck = client ? client.password_hash : '$2a$10$NkmxwflYhEay0SNGZxbNS.eqI/bFwsaaO5tgi9FByvHT4vbyApUJ.';
    const passwordOk = await bcrypt.compare(password, hashToCheck);

    if (!client || !passwordOk) {
      await loginFailure(bucket);
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    await loginSuccess(bucket);
    await startSession(req, {
      role: 'client',
      clientId: client.id,
      clientName: client.name,
      accountId: client.account_id || null,
      customer: true,
      maxAge: CUSTOMER_SESSION_MS,
    });
    res.json({ role: 'client', client: { id: client.id, name: client.name } });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/email', async (req, res) => {
  try {
    if (!(await turnstileOk(req))) return res.status(400).json({ error: 'Please try again.' });
    const email = normaliseEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'Enter your work email.' });
    const result = await requestSignIn(email, req);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, message: result.message || LINK_SENT, email });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/signup', async (req, res) => {
  try {
    if (!(await turnstileOk(req))) return res.status(400).json({ error: 'Please try again.' });
    const email = normaliseEmail(req.body && req.body.email);
    const website = customerHost(req.body && req.body.website);
    const inviteCode = req.body && req.body.invite_code;
    if (!email) return res.status(400).json({ error: 'Enter your work email.' });
    if (!website) return res.status(400).json({ error: 'Enter your website, such as example.co.uk.' });
    const result = await requestSignup({ email, website, inviteCode, req });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, message: result.message || LINK_SENT, email });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

async function beginUserSession(req, result) {
  await startSession(req, {
    role: 'owner',
    userId: result.userId,
    accountId: result.accountId,
    superadmin: result.superadmin === true,
    customer: result.superadmin !== true,
    emergency: false,
    maxAge: result.superadmin ? SUPERADMIN_SESSION_MS : CUSTOMER_SESSION_MS,
  });
}

router.post('/magic', async (req, res) => {
  try {
    const result = await consumeLink(req.body && req.body.token, req);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    await beginUserSession(req, result);
    res.json({ role: 'owner' });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/code', async (req, res) => {
  try {
    const email = normaliseEmail(req.body && req.body.email);
    if (!email) return res.status(401).json({ error: 'That code is not valid, or it has expired.' });
    const result = await consumeCode(email, req.body && req.body.code, req);
    if (!result.ok) return res.status(result.status || 401).json({ error: result.error });
    await beginUserSession(req, result);
    res.json({ role: 'owner' });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/logout', (req, res) => {
  if (!req.session || typeof req.session.destroy !== 'function') {
    return res.status(204).end();
  }
  req.session.destroy((err) => {
    if (err) return res.status(500).json(publicServerError(err));
    res.clearCookie('pivit.sid');
    res.status(204).end();
  });
});

router.post('/logout-all', async (req, res) => {
  try {
    if (req.session && req.session.userId) await endUserSessions(req.session.userId);
    else if (req.session && req.session.clientId) await endClientSessions(req.session.clientId);
    if (!req.session || typeof req.session.destroy !== 'function') {
      res.clearCookie('pivit.sid');
      return res.status(204).end();
    }
    req.session.destroy((err) => {
      if (err) return res.status(500).json(publicServerError(err));
      res.clearCookie('pivit.sid');
      res.status(204).end();
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/view-as', async (req, res) => {
  try {
    const account = await resolveSessionAccount(req);
    if (!account || !account.superadmin || account.viewAs) {
      return res.status(404).json({ error: 'not found' });
    }
    const accountId = req.body && req.body.account_id;
    if (!accountId || accountId === account.id) {
      return res.status(400).json({ error: 'Choose a different account.' });
    }
    const { rows } = await db.query(`SELECT id, name FROM accounts WHERE id = $1`, [accountId]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    req.session.viewAsAccountId = rows[0].id;
    await recordAudit(db, {
      accountId: rows[0].id,
      userId: account.userId,
      actorLabel: 'superadmin',
      action: 'view_as',
      targetType: 'account',
      targetId: rows[0].id,
      detail: { name: rows[0].name },
      ip: req.ip,
    });
    if (typeof req.session.save === 'function') {
      req.session.save((err) => {
        if (err) return res.status(500).json(publicServerError(err));
        res.json({ view_as: { id: rows[0].id, name: rows[0].name } });
      });
      return;
    }
    res.json({ view_as: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

router.post('/view-as/stop', async (req, res) => {
  try {
    const account = await resolveSessionAccount(req);
    if (!account) return res.status(401).json({ error: 'not authenticated' });
    const viewed = req.session.viewAsAccountId || null;
    req.session.viewAsAccountId = null;
    if (viewed) {
      await recordAudit(db, {
        accountId: viewed,
        userId: account.userId,
        actorLabel: 'superadmin',
        action: 'view_as_stop',
        targetType: 'account',
        targetId: viewed,
        ip: req.ip,
      });
    }
    if (typeof req.session.save === 'function') {
      req.session.save((err) => {
        if (err) return res.status(500).json(publicServerError(err));
        res.json({ view_as: null });
      });
      return;
    }
    res.json({ view_as: null });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/auth/me — lets the dashboard/client page check login state on load
// without storing anything itself; the session cookie (if any) does the work.
router.get('/me', async (req, res) => {
  const role = (req.session && req.session.role) || null;
  const client = role === 'client' ? { id: req.session.clientId, name: req.session.clientName } : null;
  const body = { role, client };
  if (role === 'owner') {
    try {
      const account = await resolveSessionAccount(req);
      if (account) {
        body.account = { id: account.id, name: account.name };
        body.superadmin = account.superadmin === true;
        body.emergency = req.session.emergency === true;
        body.view_as = account.viewAs ? { id: account.id, name: account.name } : null;
        body.snippet_site_key = await snippetSiteKey(account.id);
        if (account.userId) {
          const user = await db.query(`SELECT email FROM users WHERE id = $1`, [account.userId]);
          if (user.rows[0]) body.email = user.rows[0].email;
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.json(body);
});

module.exports = router;
