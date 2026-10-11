// Public landing page at /. Logged-in owners and customers go to the
// dashboard. Client sessions go to the client portal. Logged-out visitors
// get this page. The dashboard file stays at /index.html.

const fs = require('fs');
const path = require('path');
const { applyCanonical, canonicalUrl } = require('./app-origin');
const { accessRequestsEnabled } = require('./access-flag');

const HTML = fs.readFileSync(path.join(__dirname, 'pages', 'landing.html'), 'utf8');
const OFF = '<!--ACCESS_OFF-->';
const ON = '<!--ACCESS_ON-->';
const END = '<!--ACCESS_END-->';

function landingTarget(session) {
  const role = session && session.role;
  if (role === 'client') return '/client.html';
  if (role === 'owner') return '/index.html';
  return null;
}

function landingHtml() {
  const offAt = HTML.indexOf(OFF);
  const onAt = HTML.indexOf(ON);
  const endAt = HTML.indexOf(END);
  if (offAt < 0 || onAt < offAt || endAt < onAt) {
    throw new Error('landing page access markers are missing');
  }
  const before = HTML.slice(0, offAt);
  const offBlock = HTML.slice(offAt + OFF.length, onAt);
  const onBlock = HTML.slice(onAt + ON.length, endAt);
  const after = HTML.slice(endAt + END.length);
  const block = accessRequestsEnabled() ? onBlock : offBlock;
  return applyCanonical(before + block + after, canonicalUrl('/'));
}

function sendLandingPage(req, res) {
  const target = landingTarget(req.session);
  res.set('Cache-Control', 'private, no-store');
  if (target) {
    res.redirect(302, target);
    return;
  }
  res.type('html').send(landingHtml());
}

module.exports = {
  sendLandingPage,
  landingTarget,
  landingHtml,
};
