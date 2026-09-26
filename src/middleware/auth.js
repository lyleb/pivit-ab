// Role-based session check. Only 'owner' exists today; this shape (a list of
// allowed roles) exists so adding a 'client' role later — read-only, scoped to
// their own experiments — is a new route + requireAuth(['client']), not a rework
// of how auth itself works.
function requireAuth(allowedRoles) {
  return (req, res, next) => {
    if (req.session && req.session.role && allowedRoles.includes(req.session.role)) {
      return next();
    }
    res.status(401).json({ error: 'not authenticated' });
  };
}

module.exports = { requireAuth };
