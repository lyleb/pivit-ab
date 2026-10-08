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
  };
});
