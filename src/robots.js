// X-Robots-Tag on every response. This app is the dashboard, the client
// portal and the snippet — there are no pages that should be indexed.
// The header covers HTML, static files, /snippet, /api and /health.
// It does not set Cache-Control or CORS headers.

const ROBOTS_TAG = 'noindex, nofollow';

function robotsTagMiddleware(req, res, next) {
  res.setHeader('X-Robots-Tag', ROBOTS_TAG);
  next();
}

// Leave the HTML pages crawlable so Google can fetch them and see the
// noindex (this header, and the robots meta on the pages). Disallow: /
// would stop that, so the pages could stay in the index only by accident.
// /api and /snippet are not documents anyone should crawl.
const ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /api/',
  'Disallow: /snippet/',
  '',
].join('\n');

function sendRobotsTxt(req, res) {
  res.type('text/plain');
  res.send(ROBOTS_TXT);
}

module.exports = {
  ROBOTS_TAG,
  ROBOTS_TXT,
  robotsTagMiddleware,
  sendRobotsTxt,
};
