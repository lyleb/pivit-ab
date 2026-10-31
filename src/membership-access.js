// A Member can read the agency. Changes belong to an Owner.
// A platform admin keeps the access they already have. View as is refused
// earlier, as a read-only support view. Another agency's id is still missing:
// callers check that the row is in this account before asking here, so a
// Member does not get a different answer for an id they cannot see.

const VIEW_ONLY_MESSAGE = 'You have view-only access. Ask an Owner to make changes.';

function isViewOnlyMember(account) {
  if (!account || account.role !== 'member') return false;
  if (account.superadmin === true) return false;
  return true;
}

function refuseViewOnly(req, res) {
  if (!isViewOnlyMember(req && req.account)) return false;
  res.status(403).json({ error: VIEW_ONLY_MESSAGE });
  return true;
}

module.exports = { VIEW_ONLY_MESSAGE, isViewOnlyMember, refuseViewOnly };
