// Public request-access form. Off unless ACCESS_REQUESTS_ENABLED is a
// truthy word. The privacy page is still a placeholder, so the default
// is off and the landing page shows a mailto instead of the form.

function accessRequestsEnabled() {
  const raw = String(process.env.ACCESS_REQUESTS_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

module.exports = { accessRequestsEnabled };
