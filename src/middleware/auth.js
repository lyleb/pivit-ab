const { resolveSessionAccount } = require('../tenant');

// Role check, then the account on the session. Owner requests with no account
// id yet (a session from before accounts existed) use the legacy account, so
// the shared password keeps working. A client session is tied to that client's
// account. Missing either one is the same 401 as being signed out.
function requireAuth(allowedRoles) {
  return async (req, res, next) => {
    if (!(req.session && req.session.role && allowedRoles.includes(req.session.role))) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    try {
      const account = await resolveSessionAccount(req);
      if (!account) return res.status(401).json({ error: 'not authenticated' });
      req.account = account;
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

module.exports = { requireAuth };
