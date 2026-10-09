const { resolveSessionAccount, sessionActor } = require('../tenant');

const SAFE = new Set(['GET', 'HEAD']);

// Role check, then the account on the session. Owner requests with no account
// id yet (a session from before accounts existed) use the legacy account, so
// the shared password keeps working. A client session is tied to that client's
// account. Missing either one is the same 401 as being signed out.
// Superadmin "view as" is read-only: a change is refused here, before the route.
function requireAuth(allowedRoles) {
  return async (req, res, next) => {
    if (!(req.session && req.session.role && allowedRoles.includes(req.session.role))) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    try {
      const account = await resolveSessionAccount(req);
      if (!account) return res.status(401).json({ error: 'not authenticated' });
      req.account = account;
      if (account.readOnly && !SAFE.has(req.method)) {
        return res.status(403).json({ error: 'View as is read-only.' });
      }
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

// Superadmin-only routes. Anyone else gets 404, the same answer as a missing
// record, so the route does not advertise itself. View as cannot manage invites.
function requireSuperadmin(req, res, next) {
  sessionActor(req).then((actor) => {
    if (!actor || actor.is_superadmin !== true) return res.status(404).json({ error: 'not found' });
    if (req.session && req.session.viewAsAccountId) {
      return res.status(403).json({ error: 'View as is read-only.' });
    }
    req.superadmin = actor;
    return next();
  }).catch((err) => {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  });
}

module.exports = { requireAuth, requireSuperadmin };
