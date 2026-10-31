// Counts how many elements a click-goal selector matches in the HTML of the
// preview page. The page is the same address preview and the editor open.
// A miss does not block saving: a button can appear later, after the first
// HTML, the way a late click goal already does.

const dns = require('dns').promises;
const { normaliseHost } = require('./host-scope');

const MAX_HTML = 1500000;
const MAX_SELECTOR = 500;
const FETCH_MS = 8000;
const MAX_HOPS = 4;

const NEEDS_PAGE = 'Add the page address on the preview step to check this selector against the page.';
const NOT_YOUR_SITE = 'That page is not on a domain this agency can test, so the selector was not checked. You can still save the goal.';
const NOT_LOADED = "We couldn't load that page, so the selector was not checked. You can still save the goal. The element may appear later.";
const NOT_VALID = "That isn't a valid CSS selector. You can still save the goal.";
const NOT_SUPPORTED = 'This selector is too complex to check here. You can still save the goal.';
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function hint(message) {
  return { loaded: false, valid: true, supported: true, count: null, tone: 'hint', message };
}

function isPrivateAddress(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) return true;
  if (value === '::1' || value === '0.0.0.0') return true;
  if (value.includes(':')) {
    const head = value.split(':')[0];
    if (head === '' || head === '0' || head.startsWith('fe80') || head.startsWith('fc') || head.startsWith('fd')) return true;
    return false;
  }
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0];
  const b = parts[1];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function allowedHostSet(allowedHosts) {
  const set = new Set();
  (Array.isArray(allowedHosts) ? allowedHosts : []).forEach((entry) => {
    const host = normaliseHost(entry);
    if (host) set.add(host);
  });
  return set;
}

function describePage(pageUrl, allowedHosts) {
  const raw = String(pageUrl == null ? '' : pageUrl).trim();
  if (!raw) return { ok: false, message: NEEDS_PAGE };
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, message: NEEDS_PAGE };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: NEEDS_PAGE };
  if (url.username || url.password) return { ok: false, message: NOT_YOUR_SITE };
  const host = normaliseHost(url.hostname);
  if (!host || isPrivateAddress(host) || isPrivateAddress(url.hostname)) {
    return { ok: false, message: NOT_YOUR_SITE };
  }
  if (!allowedHostSet(allowedHosts).has(host)) return { ok: false, message: NOT_YOUR_SITE };
  return { ok: true, url: url.toString(), host, lookupHost: url.hostname.replace(/\.$/, '') };
}

function describeSelectorCount(result) {
  const source = result || {};
  if (source.loaded !== true) {
    return hint(source.message || NOT_LOADED);
  }
  if (source.valid === false) {
    return {
      loaded: true, valid: false, supported: true, count: 0, tone: 'warn', message: NOT_VALID,
    };
  }
  if (source.supported === false) {
    return {
      loaded: true, valid: true, supported: false, count: null, tone: 'hint', message: NOT_SUPPORTED,
    };
  }
  const count = Number(source.count) || 0;
  if (count <= 0) {
    return {
      loaded: true,
      valid: true,
      supported: true,
      count: 0,
      tone: 'warn',
      message: 'This selector matches 0 elements on the page. You can still save the goal. The element may appear later, for example a button on a later step.',
    };
  }
  if (count === 1) {
    return {
      loaded: true,
      valid: true,
      supported: true,
      count: 1,
      tone: 'ok',
      message: 'This selector matches 1 element on the page.',
    };
  }
  return {
    loaded: true,
    valid: true,
    supported: true,
    count,
    tone: 'note',
    message: `This selector matches ${count} elements on the page. A click on any of them counts.`,
  };
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function readIdent(text, i) {
  const start = i;
  while (i < text.length && /[a-zA-Z0-9_-]/.test(text[i])) i += 1;
  if (i === start) return null;
  return { ident: text.slice(start, i), i };
}

function readAttr(text, i) {
  if (text[i] !== '[') return { ok: false, valid: false };
  i = skipSpace(text, i + 1);
  const name = readIdent(text, i);
  if (!name) return { ok: false, valid: false };
  i = skipSpace(text, name.i);
  if (i < text.length && '*~^$|'.includes(text[i])) {
    return { ok: false, valid: true, supported: false };
  }
  let op = '';
  let value = '';
  if (text[i] === '=') {
    op = '=';
    i = skipSpace(text, i + 1);
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const end = text.indexOf(quote, i + 1);
      if (end < 0) return { ok: false, valid: false };
      value = text.slice(i + 1, end);
      i = end + 1;
    } else {
      const start = i;
      while (i < text.length && text[i] !== ']' && !/\s/.test(text[i])) i += 1;
      value = text.slice(start, i);
    }
    i = skipSpace(text, i);
  }
  if (text[i] !== ']') return { ok: false, valid: false };
  return {
    ok: true,
    i: i + 1,
    attr: { name: name.ident.toLowerCase(), op, value },
  };
}

function readCompound(text, i) {
  const compound = { tag: '', id: '', classes: [], attrs: [], nth: null };
  let saw = false;
  while (i < text.length && !/\s/.test(text[i]) && text[i] !== '>' && text[i] !== ',') {
    saw = true;
    const ch = text[i];
    if (ch === '#') {
      const id = readIdent(text, i + 1);
      if (!id) return { ok: false, valid: false };
      compound.id = id.ident;
      i = id.i;
    } else if (ch === '.') {
      const cls = readIdent(text, i + 1);
      if (!cls) return { ok: false, valid: false };
      compound.classes.push(cls.ident);
      i = cls.i;
    } else if (ch === '[') {
      const attr = readAttr(text, i);
      if (!attr.ok) return attr;
      compound.attrs.push(attr.attr);
      i = attr.i;
    } else if (ch === ':') {
      if (text.startsWith(':nth-of-type(', i)) {
        const rest = text.slice(i + ':nth-of-type('.length);
        const matched = rest.match(/^(\d+)\)/);
        if (!matched || Number(matched[1]) < 1) return { ok: false, valid: true, supported: false };
        compound.nth = Number(matched[1]);
        i += ':nth-of-type('.length + matched[0].length;
      } else {
        return { ok: false, valid: true, supported: false };
      }
    } else if (ch === '*') {
      compound.tag = '*';
      i += 1;
    } else if (/[a-zA-Z]/.test(ch)) {
      const tag = readIdent(text, i);
      if (!tag) return { ok: false, valid: false };
      compound.tag = tag.ident.toLowerCase();
      i = tag.i;
    } else {
      return { ok: false, valid: false };
    }
  }
  if (!saw) return { ok: false, valid: false };
  return { ok: true, valid: true, supported: true, i, compound };
}

function parseAlternative(text) {
  const source = String(text || '');
  const parts = [];
  let i = skipSpace(source, 0);
  let combinator = '';
  if (!source.trim()) return { ok: false, valid: false };
  while (i < source.length) {
    if (source[i] === '>') {
      if (parts.length === 0) return { ok: false, valid: false };
      combinator = '>';
      i = skipSpace(source, i + 1);
      if (i >= source.length) return { ok: false, valid: false };
    }
    const compound = readCompound(source, i);
    if (!compound.ok) return compound;
    parts.push({ combinator, compound: compound.compound });
    combinator = ' ';
    i = skipSpace(source, compound.i);
  }
  if (!parts.length) return { ok: false, valid: false };
  return { ok: true, valid: true, supported: true, parts };
}

function splitCommas(text) {
  const parts = [];
  let start = 0;
  let square = 0;
  let round = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') square += 1;
    else if (ch === ']' && square) square -= 1;
    else if (ch === '(') round += 1;
    else if (ch === ')' && round) round -= 1;
    else if (ch === ',' && !square && !round) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  if (parts.some((part) => !part.trim())) return null;
  return parts;
}

function attrMap(raw) {
  const attrs = {};
  const re = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match = re.exec(raw);
  while (match) {
    const name = match[1].toLowerCase();
    if (name !== '/') {
      const value = match[2] != null ? match[2] : (match[3] != null ? match[3] : (match[4] != null ? match[4] : ''));
      attrs[name] = value;
    }
    match = re.exec(raw);
  }
  return attrs;
}

function parseHtml(html) {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const root = { tag: '#document', id: '', classes: [], attrs: {}, children: [], parent: null };
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let match = re.exec(source);
  while (match) {
    const raw = match[0];
    const tag = match[1].toLowerCase();
    if (raw.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else {
      const attrs = attrMap(match[2] || '');
      const el = {
        tag,
        id: attrs.id || '',
        classes: String(attrs.class || '').split(/\s+/).filter(Boolean),
        attrs,
        children: [],
        parent: stack[stack.length - 1],
      };
      stack[stack.length - 1].children.push(el);
      const selfClose = /\/\s*$/.test(match[2] || '') || VOID_TAGS.has(tag);
      if (!selfClose) stack.push(el);
    }
    match = re.exec(source);
  }
  return root;
}

function compoundMatches(el, compound) {
  if (!el || el.tag === '#document') return false;
  if (compound.tag && compound.tag !== '*' && el.tag !== compound.tag) return false;
  if (compound.id && el.id !== compound.id) return false;
  for (let i = 0; i < compound.classes.length; i += 1) {
    if (el.classes.indexOf(compound.classes[i]) === -1) return false;
  }
  for (let i = 0; i < compound.attrs.length; i += 1) {
    const attr = compound.attrs[i];
    if (!Object.prototype.hasOwnProperty.call(el.attrs, attr.name)) return false;
    if (attr.op === '=' && el.attrs[attr.name] !== attr.value) return false;
  }
  if (compound.nth != null) {
    const siblings = (el.parent ? el.parent.children : []).filter((child) => child.tag === el.tag);
    if (siblings.indexOf(el) + 1 !== compound.nth) return false;
  }
  return true;
}

function walk(node, visit) {
  (node.children || []).forEach((child) => {
    visit(child);
    walk(child, visit);
  });
}

function queryParts(root, parts) {
  let current = [root];
  parts.forEach((part) => {
    const next = [];
    current.forEach((node) => {
      if (part.combinator === '>') {
        (node.children || []).forEach((child) => {
          if (compoundMatches(child, part.compound)) next.push(child);
        });
        return;
      }
      walk(node, (el) => {
        if (compoundMatches(el, part.compound)) next.push(el);
      });
    });
    current = next;
  });
  return current;
}

function countSelectorMatches(html, selector) {
  const text = String(selector || '').trim();
  if (!text || text.length > MAX_SELECTOR) {
    return { loaded: true, valid: false, supported: true, count: 0 };
  }
  const alternatives = splitCommas(text);
  if (!alternatives) return { loaded: true, valid: false, supported: true, count: 0 };
  const parsed = [];
  for (let i = 0; i < alternatives.length; i += 1) {
    const one = parseAlternative(alternatives[i]);
    if (!one.ok) {
      return {
        loaded: true,
        valid: one.valid !== false,
        supported: one.supported !== false,
        count: 0,
      };
    }
    parsed.push(one.parts);
  }
  const root = parseHtml(html);
  const found = new Set();
  parsed.forEach((parts) => {
    queryParts(root, parts).forEach((el) => found.add(el));
  });
  return { loaded: true, valid: true, supported: true, count: found.size };
}

async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function readLimited(res) {
  if (!res || !res.body || typeof res.body.getReader !== 'function') {
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (text.length > MAX_HTML) return null;
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > MAX_HTML) {
      if (typeof reader.cancel === 'function') await reader.cancel();
      return null;
    }
    chunks.push(step.value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder('utf-8').decode(all);
}

function headerValue(res, name) {
  if (!res || !res.headers) return '';
  if (typeof res.headers.get === 'function') return res.headers.get(name) || '';
  const value = res.headers[name] || res.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : (value || '');
}

async function fetchHtml(pageUrl, allowedHosts, fetchImpl) {
  let current = pageUrl;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'pivitlab-selector-check' },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    const status = Number(res && res.status) || 0;
    if (status >= 300 && status < 400) {
      const location = headerValue(res, 'location');
      if (!location) return { ok: false };
      let next = '';
      try { next = new URL(location, current).toString(); } catch (err) { return { ok: false }; }
      const gate = describePage(next, allowedHosts);
      if (!gate.ok) return { ok: false, blocked: true };
      current = gate.url;
      continue;
    }
    if (status < 200 || status >= 300) return { ok: false };
    const type = headerValue(res, 'content-type').toLowerCase();
    if (type && !type.includes('text/html') && !type.includes('application/xhtml')) return { ok: false };
    const html = await readLimited(res);
    if (html == null) return { ok: false };
    return { ok: true, html };
  }
  return { ok: false };
}

async function checkClickSelector({ pageUrl, selector, allowedHosts, fetchImpl, lookupImpl } = {}) {
  const gate = describePage(pageUrl, allowedHosts);
  if (!gate.ok) return hint(gate.message);
  const lookup = lookupImpl || defaultLookup;
  try {
    const records = await lookup(gate.lookupHost || gate.host);
    const list = Array.isArray(records) ? records : [records];
    if (!list.length || list.some((row) => !row || isPrivateAddress(row.address))) {
      return hint(NOT_YOUR_SITE);
    }
  } catch (err) {
    return hint(NOT_LOADED);
  }
  try {
    const loaded = await fetchHtml(gate.url, allowedHosts, fetchImpl || fetch);
    if (!loaded.ok) return hint(loaded.blocked ? NOT_YOUR_SITE : NOT_LOADED);
    return describeSelectorCount(countSelectorMatches(loaded.html, selector));
  } catch (err) {
    return hint(NOT_LOADED);
  }
}

module.exports = {
  NEEDS_PAGE,
  NOT_LOADED,
  NOT_VALID,
  isPrivateAddress,
  countSelectorMatches,
  describeSelectorCount,
  checkClickSelector,
};
