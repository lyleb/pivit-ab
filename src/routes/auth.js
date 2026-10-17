const express = require('express');
const db = require('../db');
const { publicServerError } = require('../public-error');
const { snippetSiteKey, resolveSessionAccount, legacyAccount } = require('../tenant');
const { timingSafeStringEqual } = require('../timing');
const { loginLocked, loginFailure, loginSuccess, tooMany } = require('../rate-limit');
const { recordAudit, endUserSessions, endClientSessions } = require('../audit');
const { clearSessionCookie } = require('../session-cookie');
const { stampSessionLifetime } = require('../session-lifetime');
const { turnstileOk, turnstilePublicConfig } = require('../turnstile');
const {
  LINK_SENT,
  normaliseEmail,
  customerHost,
  requestSignIn,
  requestSignup,
  consumeLink,
  consumeCode,
} = require('../auth-flow');
const { previewAccountInvite, acceptAccountInvite } = require('../account-invite');
const { SIGN_IN_CLOSED, personClosed, refuseClosedSession } = require('../person-state');

const router = express.Router();

const SESSION_KEYS = [
  'role',
  'userId',
  'accountId',
  'superadmin',
  'customer',
  'emergency',
  'emergencyKeyId',
  'signedInAt',
  'lastSeenAt',
  'absoluteExpiresAt',
  'clientId',
  'clientName',
  'viewAsAccountId',
];

function snapshotSession(session) {
  const data = {};
  if (!session) return data;
  for (const key of SESSION_KEYS) {
    if (session[key] !== undefined) data[key] = session[key];
  }
  if (session.cookie && session.cookie.originalMaxAge) data._maxAge = session.cookie.originalMaxAge;
  return data;
}

function applySnapshot(session, data, mutate) {
  for (const key of SESSION_KEYS) {
    if (data[key] !== undefined) session[key] = data[key];
  }
  // Restore the previous lifetime first so sign-in can replace it, and so
  // view-as keeps the clock that was already running.
  if (data._maxAge && session.cookie) session.cookie.maxAge = data._maxAge;
  if (typeof mutate === 'function') mutate(session);
}

// New session id, same person. Used at sign-in and when view-as changes
// what the session is allowed to see.
function rotateSession(req, mutate) {
  return new Promise((resolve, reject) => {
    if (!req.session) return reject(new Error('no session'));
    const data = snapshotSession(req.session);
    const finish = () => {
      applySnapshot(req.session, data, mutate);
      if (typeof req.session.save === 'function') {
        req.session.save((err) => (err ? reject(err) : resolve()));
      } else resolve();
    };
    if (typeof req.session.regenerate === 'function') {
      req.session.regenerate((err) => (err ? reject(err) : finish()));
    } else finish();
  });
}

function startSession(req, fields) {
  return rotateSession(req, (session) => {
    session.role = fields.role;
    session.userId = fields.userId || null;
    session.accountId = fields.accountId || null;
    session.superadmin = fields.superadmin === true;
    session.customer = fields.customer === true;
    session.emergency = fields.emergency === true;
    session.viewAsAccountId = null;
    if (fields.clientId) {
      session.clientId = fields.clientId;
      session.clientName = fields.clientName || null;
    } else {
      delete session.clientId;
      delete session.clientName;
    }
    stampSessionLifetime(session);
  });
}

async function ownerFromPassword(req) {
  const legacy = await legacyAccount();
  const fields = {
    role: 'owner',
    emergency: true,
    customer: false,
    superadmin: false,
  };
  if (legacy) {
    fields.accountId = legacy.id;
    if (legacy.user_id) {
      fields.userId = legacy.user_id;
      const { rows } = await db.query(
        `SELECT is_superadmin, suspended_at, deleted_at FROM users WHERE id = $1`,
        [legacy.user_id]
      );
      if (personClosed(rows[0])) return { closed: true };
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
  return { closed: false };
}

function sendFlowResult(res, result) {
  if (result.ok) return false;
  if (result.status === 429) {
    tooMany(res, result.retryAfter);
    return true;
  }
  res.status(result.status || 400).json({ error: result.error });
  return true;
}

// Public widget config. The secret is never included. Enabled only when both
// Turnstile keys are set; otherwise the pages do not load the script.
router.get('/turnstile', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(turnstilePublicConfig());
});

// POST /api/auth/login  { password }  — emergency owner login
router.post('/login', async (req, res) => {
  const bucket = `login:owner:${req.ip || 'unknown'}`;
  try {
    if (!(await turnstileOk(req))) return res.status(400).json({ error: 'Please try again.' });
    const secondsLeft = await loginLocked(bucket);
    if (secondsLeft) return tooMany(res, secondsLeft);

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
    const started = await ownerFromPassword(req);
    if (started && started.closed) {
      return res.status(401).json({ error: SIGN_IN_CLOSED });
    }
    res.json({ role: 'owner' });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// POST /api/auth/client-login  { username, password }
router.post('/client-login', async (req, res) => {
  const bucket = `login:client:${req.ip || 'unknown'}`;
  try {
    if (!(await turnstileOk(req))) return res.status(400).json({ error: 'Please try again.' });
    const secondsLeft = await loginLocked(bucket);
    if (secondsLeft) return tooMany(res, secondsLeft);

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
    if (personClosed(client)) {
      await loginSuccess(bucket);
      return res.status(401).json({ error: SIGN_IN_CLOSED });
    }

    await loginSuccess(bucket);
    await startSession(req, {
      role: 'client',
      clientId: client.id,
      clientName: client.name,
      accountId: client.account_id || null,
      customer: true,
    });
    await recordAudit(db, {
      accountId: client.account_id || null,
      actorLabel: client.username,
      action: 'signin',
      targetType: 'client',
      targetId: client.id,
      detail: { via: 'client_password' },
      ip: req.ip,
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
    if (sendFlowResult(res, result)) return;
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
    if (sendFlowResult(res, result)) return;
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
  });
}

router.get('/join', async (req, res) => {
  try {
    const result = await previewAccountInvite(req.query && req.query.token, req);
    if (sendFlowResult(res, result)) return;
    res.set('Cache-Control', 'no-store');
    res.json({
      agency_name: result.agencyName,
      role: result.role,
      email: result.email,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/join', async (req, res) => {
  try {
    const result = await acceptAccountInvite(req.body && req.body.token, req);
    if (sendFlowResult(res, result)) return;
    await beginUserSession(req, result);
    res.json({ role: 'owner' });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

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
    clearSessionCookie(res);
    res.status(204).end();
  });
});

router.post('/logout-all', async (req, res) => {
  try {
    const session = req.session || {};
    const userId = session.userId || null;
    const clientId = session.clientId || null;
    if (userId || clientId) {
      await recordAudit(db, {
        accountId: session.accountId || null,
        userId,
        actorLabel: userId ? null : (session.clientName || 'client'),
        action: 'signout_everywhere',
        targetType: clientId && !userId ? 'client' : 'user',
        targetId: userId || clientId,
        ip: req.ip,
      });
      if (userId) await endUserSessions(userId);
      if (clientId) await endClientSessions(clientId);
    }
    if (!req.session || typeof req.session.destroy !== 'function') {
      clearSessionCookie(res);
      return res.status(204).end();
    }
    req.session.destroy((err) => {
      if (err) return res.status(500).json(publicServerError(err));
      clearSessionCookie(res);
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
      return res.status(400).json({ error: 'Choose a different agency.' });
    }
    const { rows } = await db.query(`SELECT id, name FROM accounts WHERE id = $1`, [accountId]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    const viewed = rows[0];
    await rotateSession(req, (session) => {
      session.viewAsAccountId = viewed.id;
    });
    await recordAudit(db, {
      accountId: viewed.id,
      userId: account.userId,
      actorLabel: 'superadmin',
      action: 'view_as',
      targetType: 'account',
      targetId: viewed.id,
      detail: { name: viewed.name },
      ip: req.ip,
    });
    res.json({ view_as: { id: viewed.id, name: viewed.name } });
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
    await rotateSession(req, (session) => {
      session.viewAsAccountId = null;
    });
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
    res.json({ view_as: null });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/auth/me — lets the dashboard/client page check login state on load
// without storing anything itself; the session cookie (if any) does the work.
router.get('/me', async (req, res) => {
  try {
    if (await refuseClosedSession(req, res)) return;
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
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
          const user = await db.query(
            `SELECT u.email, m.role
             FROM users u
             LEFT JOIN memberships m
               ON m.user_id = u.id AND m.account_id = $2 AND m.removed_at IS NULL
             WHERE u.id = $1`,
            [account.userId, account.id]
          );
          if (user.rows[0]) {
            body.email = user.rows[0].email;
            if (user.rows[0].role) body.membership = user.rows[0].role;
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.json(body);
});

module.exports = router;
