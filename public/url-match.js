// URL goal matching. Contains is the historical behaviour (substring of the
// full address) and is left unchanged. Exact and starts-with ignore one
// trailing "?" and one trailing "/" so a copied address is not stricter than
// the page visitors actually land on. Regular expressions are rejected when
// they are nested or otherwise expensive to run.
//
// The live snippet carries its own copy of matchUrlGoal / isSafeRegex.
// scripts/goals.test.js checks the two copies agree.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PivitUrl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MATCH_TYPES = ['contains', 'exact', 'starts_with', 'regex'];
  const MAX_REGEX = 200;

  function stripEdge(value) {
    let s = String(value || '').trim();
    let strippedQuery = false;
    if (s.endsWith('?')) {
      s = s.slice(0, -1);
      strippedQuery = true;
    }
    if (s.length > 1 && s.endsWith('/') && !s.endsWith('://')) s = s.slice(0, -1);
    return { value: s, strippedQuery: strippedQuery };
  }

  function urlCandidates(href) {
    const raw = String(href || '').trim();
    const out = [];
    function add(value) {
      if (value && out.indexOf(value) === -1) out.push(value);
    }
    add(raw);
    try {
      const u = new URL(raw, 'https://placeholder.invalid');
      if (/^https?:\/\//i.test(raw) || raw.charAt(0) === '/') {
        add(u.pathname + u.search + u.hash);
        add(u.origin + u.pathname + u.search + u.hash);
        if (!u.search) {
          add(u.pathname);
          add(u.origin + u.pathname);
        }
      }
    } catch (err) { /* keep the raw string only */ }
    return out;
  }

  function pathOnly(value) {
    const q = value.indexOf('?');
    const h = value.indexOf('#');
    let end = value.length;
    if (q !== -1) end = Math.min(end, q);
    if (h !== -1 && (q === -1 || h < q)) end = h;
    return value.slice(0, end);
  }

  function sameEdge(left, right) {
    if (right.value === left.value) return true;
    if (!left.strippedQuery) return false;
    return stripEdge(pathOnly(right.value)).value === left.value;
  }

  function startsEdge(left, right) {
    if (!left.value) return false;
    if (right.value.indexOf(left.value) === 0) return true;
    if (!left.strippedQuery) return false;
    return stripEdge(pathOnly(right.value)).value.indexOf(left.value) === 0;
  }

  // {2} and {1,} repeat. {1} and {0,1} do not — they cannot nest into a bomb.
  function readQuantifier(source, i) {
    const c = source.charAt(i);
    if (c !== '+' && c !== '*' && c !== '?' && c !== '{') {
      return { quantified: false, repeating: false, next: i };
    }
    if (c !== '{') {
      let next = i + 1;
      if (source.charAt(next) === '?' || source.charAt(next) === '+') next += 1;
      return { quantified: true, repeating: c === '+' || c === '*', next: next };
    }
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (!m) return { quantified: false, repeating: false, next: i };
    let next = i + m[0].length;
    if (source.charAt(next) === '?' || source.charAt(next) === '+') next += 1;
    const min = Number(m[1]);
    const max = m[2] == null ? min : (m[3] === '' ? Infinity : Number(m[3]));
    return { quantified: true, repeating: max > 1, next: next };
  }

  // 0 = no repeat, 1 = one repeat, 2+ = a repeat inside a repeat (rejected).
  // -1 = the pattern could not be read. Alternation inside a repeating group
  // is treated as unsafe even at height 1: (a|aa)+ is a classic slow case.
  function starHeight(source) {
    let i = 0;
    const n = source.length;
    const frames = [{ alt: 0, max: 0, last: 0, altUsed: false }];
    function frame() { return frames[frames.length - 1]; }

    while (i < n) {
      const c = source.charAt(i);
      if (c === '\\') {
        if (i + 1 >= n) return -1;
        frame().last = 0;
        i += 2;
        continue;
      }
      if (c === '[') {
        i += 1;
        if (source.charAt(i) === '^') i += 1;
        if (source.charAt(i) === ']') i += 1;
        let closed = false;
        while (i < n) {
          if (source.charAt(i) === '\\') { i += 2; continue; }
          if (source.charAt(i) === ']') { closed = true; i += 1; break; }
          i += 1;
        }
        if (!closed) return -1;
        frame().last = 0;
        continue;
      }
      if (c === '(') {
        frames.push({ alt: 0, max: 0, last: 0, altUsed: false });
        i += 1;
        if (source.charAt(i) === '?') {
          i += 1;
          if (source.charAt(i) === '<') i += 1;
          while (i < n && source.charAt(i) !== ':' && source.charAt(i) !== ')') i += 1;
          if (source.charAt(i) === ':') i += 1;
        }
        continue;
      }
      if (c === ')') {
        if (frames.length < 2) return -1;
        const done = frames.pop();
        const h = Math.max(done.max, done.alt, done.last);
        i += 1;
        const q = readQuantifier(source, i);
        const f = frame();
        const repeating = q.quantified && q.repeating;
        if (done.altUsed && repeating) return 99;
        f.last = repeating ? h + 1 : h;
        if (f.last > f.alt) f.alt = f.last;
        if (q.quantified) i = q.next;
        continue;
      }
      if (c === '|') {
        const f = frame();
        f.altUsed = true;
        if (f.alt > f.max) f.max = f.alt;
        if (f.last > f.max) f.max = f.last;
        f.alt = 0;
        f.last = 0;
        i += 1;
        continue;
      }
      if (c === '+' || c === '*' || c === '?' || c === '{') {
        const q = readQuantifier(source, i);
        if (!q.quantified) { frame().last = 0; i += 1; continue; }
        const f = frame();
        if (q.repeating) {
          f.last += 1;
          if (f.last > f.alt) f.alt = f.last;
        }
        i = q.next;
        continue;
      }
      frame().last = 0;
      i += 1;
    }
    if (frames.length !== 1) return -1;
    const top = frames[0];
    return Math.max(top.max, top.alt, top.last);
  }

  function isSafeRegex(pattern) {
    if (typeof pattern !== 'string') return false;
    if (pattern.length < 1 || pattern.length > MAX_REGEX) return false;
    if (/\\[1-9]/.test(pattern)) return false;
    try { new RegExp(pattern); } catch (err) { return false; }
    const height = starHeight(pattern);
    return height >= 0 && height <= 1;
  }

  function matchUrlGoal(pattern, href, matchType) {
    const type = matchType || 'contains';
    const pat = String(pattern || '');
    const url = String(href || '');
    if (!pat) return false;
    if (type === 'contains') return url.indexOf(pat) !== -1;
    if (type === 'regex') {
      if (!isSafeRegex(pat)) return false;
      try { return new RegExp(pat).test(url.slice(0, 2000)); } catch (err) { return false; }
    }
    if (type !== 'exact' && type !== 'starts_with') return false;
    const left = stripEdge(pat);
    const candidates = urlCandidates(url);
    for (let i = 0; i < candidates.length; i++) {
      const right = stripEdge(candidates[i]);
      if (type === 'exact' && sameEdge(left, right)) return true;
      if (type === 'starts_with' && startsEdge(left, right)) return true;
    }
    return false;
  }

  // Page targeting. Goal matching above is unchanged.
  // Exact for a page ignores the query string, the hash and one trailing
  // slash, so https://example.com/ and https://example.com/?utm=1#sale are
  // the same page. Contains stays a substring, and the live query for a
  // stored "contains" test is still the case-insensitive SQL match that
  // already shipped. A site root or homepage defaults to exact because
  // "contains" on that address matches every page on the site.
  const HOME_FILE = /^\/(?:index|default|home)\.(?:html?|php|aspx)$/i;

  function stripQueryHash(value) {
    let s = String(value || '').trim();
    const hash = s.indexOf('#');
    if (hash !== -1) s = s.slice(0, hash);
    const query = s.indexOf('?');
    if (query !== -1) s = s.slice(0, query);
    return s;
  }

  function normalPath(path) {
    let p = path || '/';
    if (!p.startsWith('/')) p = '/' + p;
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }

  function pageParts(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        return { kind: 'url', host: u.host.toLowerCase(), path: normalPath(u.pathname) };
      } catch (err) {
        return null;
      }
    }
    const bare = stripQueryHash(raw);
    if (!bare) return { kind: 'path', host: '', path: '/' };
    if (bare.startsWith('/')) return { kind: 'path', host: '', path: normalPath(bare) };
    const hostish = bare.replace(/\/+$/, '');
    if (hostish === 'localhost' || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostish)) {
      return { kind: 'url', host: hostish.toLowerCase(), path: '/' };
    }
    return { kind: 'text', host: '', path: '', text: hostish };
  }

  function isSiteRoot(pattern) {
    const parts = pageParts(pattern);
    if (!parts) return false;
    if (parts.kind === 'text') return false;
    if (parts.path === '/') return true;
    return HOME_FILE.test(parts.path);
  }

  function defaultPageMatch(pattern) {
    return isSiteRoot(pattern) ? 'exact' : 'contains';
  }

  function exactPage(pattern, href) {
    const left = pageParts(pattern);
    const right = pageParts(href);
    if (!left || !right) return false;
    if (left.kind === 'url') {
      return right.kind === 'url' && left.host === right.host && left.path === right.path;
    }
    if (left.kind === 'path') {
      return (right.kind === 'url' || right.kind === 'path') && left.path === right.path;
    }
    return right.kind === 'text' && left.text === right.text;
  }

  function matchPageUrl(pattern, href, matchType) {
    const type = matchType || 'contains';
    if (type === 'exact') return exactPage(pattern, href);
    if (type === 'contains' || type === 'starts_with' || type === 'regex') {
      return matchUrlGoal(pattern, href, type);
    }
    return false;
  }

  function resolvePageMatch(pattern, requested) {
    const text = String(pattern == null ? '' : pattern).trim();
    if (!text) return { ok: false, error: 'url_match is required' };
    if (text.length > 500) return { ok: false, error: 'url_match is too long' };
    if (requested == null || requested === '') {
      return { ok: true, type: defaultPageMatch(text) };
    }
    const type = String(requested).trim();
    if (MATCH_TYPES.indexOf(type) === -1) {
      return { ok: false, error: 'url_match_type must be contains, exact, starts_with or regex' };
    }
    if (type === 'regex' && !isSafeRegex(text)) {
      return { ok: false, error: 'that regular expression is not safe to run' };
    }
    return { ok: true, type: type };
  }

  function pageMatchLabel(type) {
    return {
      contains: 'Contains',
      exact: 'Exact',
      starts_with: 'Starts with',
      regex: 'Regular expression',
    }[type] || 'Contains';
  }

  function pageMatchHint(type, pattern) {
    const root = isSiteRoot(pattern);
    const stored = type || 'contains';
    if (stored === 'exact') {
      return root
        ? 'Exact. This is the site homepage, so the test runs on that page only. A query string, a hash and a trailing slash still match.'
        : 'Exact. The test runs only when the page is this address. A query string, a hash and a trailing slash still match.';
    }
    if (stored === 'starts_with') {
      return root
        ? 'Starts with. The homepage address is the start of every page on this site, so this also runs on /shop, /about and /checkout. Exact limits it to the homepage.'
        : 'Starts with. The test runs on pages whose address begins with this text.';
    }
    if (stored === 'regex') {
      return 'Regular expression. The test runs when the page address matches this pattern.';
    }
    if (root) {
      return 'Contains. Every page on this site includes the homepage address, so the test also runs on /shop, /about and /checkout. Exact limits it to the homepage.';
    }
    return 'Contains. The test runs on any page whose address includes this text.';
  }

  // Preview page vs the test's URL rule. Matching is matchPageUrl — the same
  // function the server uses for exact, starts-with and regex targeting — so
  // the dashboard does not grow a second matcher. Contains stays that
  // function's substring check.
  function previewRulePhrase(matchType) {
    return {
      contains: 'contains',
      exact: 'exact',
      starts_with: 'starts with',
      regex: 'regular expression',
    }[matchType] || 'contains';
  }

  // Shown next to the URL warning. The dashboard cannot see the customer's
  // DOM, so this names the selector the preview will wait for.
  function previewElementNote(selector) {
    const sel = String(selector == null ? '' : selector).trim();
    if (!sel) return '';
    return "This test only runs when '" + sel + "' is on the page. Preview waits for that element and applies nothing if it never appears.";
  }

  function previewUrlWarning(pattern, href, matchType) {
    const page = String(href == null ? '' : href).trim();
    const pat = String(pattern == null ? '' : pattern).trim();
    if (!page || !pat) return '';
    const type = matchType || 'contains';
    if (matchPageUrl(pat, page, type)) return '';
    const phrase = previewRulePhrase(type);
    return "This page doesn't match the test's URL rule (" + phrase + " '" + pat + "'), so visitors here won't see the test.";
  }

  function normaliseOrigin(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
      return new URL(withScheme).origin;
    } catch (err) {
      return '';
    }
  }

  // Site domain first (allowed hosts), then an origin passed in, then the
  // origin of an absolute pattern. A path-only rule has no origin of its own.
  function previewSiteOrigin(pattern, options) {
    const opts = options || {};
    const hosts = Array.isArray(opts.allowedHosts) ? opts.allowedHosts : [];
    for (let i = 0; i < hosts.length; i += 1) {
      const origin = normaliseOrigin(hosts[i]);
      if (origin) return origin;
    }
    const given = normaliseOrigin(opts.origin);
    if (given) return given;
    const pat = String(pattern || '').trim();
    if (/^https?:\/\//i.test(pat)) return normaliseOrigin(pat);
    return '';
  }

  function originPlusPattern(origin, pattern) {
    if (!origin) return '';
    const pat = String(pattern || '').trim();
    if (!pat) return '';
    if (/^https?:\/\//i.test(pat)) {
      try {
        const u = new URL(pat);
        if (u.origin === origin) return pat;
        return origin + u.pathname + u.search + u.hash;
      } catch (err) {
        return '';
      }
    }
    if (pat.charAt(0) === '/') return origin + pat;
    return origin + '/' + pat;
  }

  function siteHomepage(origin) {
    return origin ? origin + '/' : '';
  }

  // A path (/products/) or a full http(s) address names a page. A contains
  // fragment such as "-t-shirt" does not: joining it onto the origin invents
  // an address that still matches the rule.
  function patternIsPageAddress(pattern) {
    const pat = String(pattern || '').trim();
    return pat.charAt(0) === '/' || /^https?:\/\//i.test(pat);
  }

  // Default preview address for a rule.
  // Exact uses the pattern itself. Starts-with uses the site origin plus the
  // pattern when that address matches the rule. Contains does the same only
  // when the pattern is a path or a full http(s) address. A contains fragment
  // uses the site homepage, so the dashboard can ask for a real page. A
  // regular expression uses the homepage too. A join that does not match the
  // rule also uses the homepage.
  function defaultPreviewPage(options) {
    const opts = options || {};
    const pattern = String(opts.pattern == null ? '' : opts.pattern).trim();
    if (!pattern) return '';
    const type = opts.matchType || 'contains';
    if (type === 'exact') return pattern;
    const origin = previewSiteOrigin(pattern, opts);
    const join = type === 'starts_with' || (type === 'contains' && patternIsPageAddress(pattern));
    if (join) {
      const candidate = originPlusPattern(origin, pattern);
      if (candidate && matchPageUrl(pattern, candidate, type)) return candidate;
    }
    return siteHomepage(origin);
  }

  // Page offered by "Use a matching page". Blank unless the pattern is a path
  // or a full address and that page matches the rule, so a contains fragment
  // never fills in a made-up URL.
  function matchingPreviewPage(options) {
    const opts = options || {};
    const pattern = String(opts.pattern == null ? '' : opts.pattern).trim();
    if (!pattern || !patternIsPageAddress(pattern)) return '';
    const type = opts.matchType || 'contains';
    if (type === 'regex') return '';
    const suggested = defaultPreviewPage(opts);
    if (suggested && matchPageUrl(pattern, suggested, type)) return suggested;
    return '';
  }

  function testUrlGoal(match, pattern, sample) {
    const type = match || 'contains';
    if (!pattern || !String(pattern).trim()) {
      return { ok: false, matches: false, message: 'Add a URL pattern first.' };
    }
    if (!sample || !String(sample).trim()) {
      return { ok: false, matches: false, message: 'Paste a URL to test.' };
    }
    if (type === 'regex' && !isSafeRegex(String(pattern).trim())) {
      return { ok: false, matches: false, message: 'This regular expression is not safe to run.' };
    }
    const matches = matchUrlGoal(String(pattern).trim(), String(sample).trim(), type);
    return {
      ok: true,
      matches: matches,
      message: matches ? 'This URL matches.' : 'This URL does not match.',
    };
  }

  return {
    MATCH_TYPES: MATCH_TYPES,
    MAX_REGEX: MAX_REGEX,
    stripEdge: stripEdge,
    starHeight: starHeight,
    isSafeRegex: isSafeRegex,
    matchUrlGoal: matchUrlGoal,
    testUrlGoal: testUrlGoal,
    isSiteRoot: isSiteRoot,
    defaultPageMatch: defaultPageMatch,
    matchPageUrl: matchPageUrl,
    resolvePageMatch: resolvePageMatch,
    pageMatchLabel: pageMatchLabel,
    pageMatchHint: pageMatchHint,
    previewElementNote: previewElementNote,
    previewUrlWarning: previewUrlWarning,
    defaultPreviewPage: defaultPreviewPage,
    matchingPreviewPage: matchingPreviewPage,
  };
});
