/**
 * pivitlab selector picker — bookmarklet
 *
 * Not part of the tracking snippet. Drag the "Selector Picker" link on the
 * dashboard to your bookmarks bar, then click it on the live page. Click an
 * element and its selector is copied. When the pivitlab snippet is on the
 * page, this uses the same uniqueSelector the editor saves, so the goal
 * matches what visitors' browsers can find.
 */
(function () {
  if (window.__abPickerActive) return;
  window.__abPickerActive = true;

  const POSITION_WARNING = 'This picks the element by its position on the page, so it may break if the page layout changes. pivitlab looks for it for up to 10 seconds. Pick a button, a link, or an element with a name if you can.';
  const COPIED = 'Copied. Paste this into the click goal on pivitlab.';

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#5635FB;color:#fff;padding:14px 16px;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-weight:650;z-index:2147483647;text-align:center;box-shadow:0 2px 8px rgba(19,23,35,0.2);';
  bar.textContent = 'pivitlab: click the element you want. Press Esc to cancel.';
  document.documentElement.appendChild(bar);

  let highlighted = null;
  function clearHighlight() {
    if (highlighted) { highlighted.style.outline = ''; highlighted.style.outlineOffset = ''; }
  }

  function cssEscape(str) {
    return window.CSS && CSS.escape ? CSS.escape(str) : String(str).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function attrEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isPositional(selector) {
    if (window.PivitRuntime && typeof window.PivitRuntime.isPositionalSelector === 'function') {
      return window.PivitRuntime.isPositionalSelector(selector);
    }
    return /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type)\b/.test(selector || '');
  }

  function matchesOnly(selector, el) {
    try {
      const list = document.querySelectorAll(selector);
      return list.length === 1 && list[0] === el;
    } catch (err) {
      return false;
    }
  }

  function fallbackSelector(el) {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if (el.id && String(el.id).indexOf(':') === -1 && matchesOnly('#' + cssEscape(el.id), el)) {
      return '#' + cssEscape(el.id);
    }
    const attrs = ['data-testid', 'data-test', 'data-cy', 'data-id', 'data-section', 'name', 'aria-label'];
    if (tag === 'a') attrs.push('href');
    for (let i = 0; i < attrs.length; i++) {
      const value = el.getAttribute && el.getAttribute(attrs[i]);
      if (!value || String(value).length > 80) continue;
      if (attrs[i] === 'href' && (value === '#' || String(value).indexOf('javascript:') === 0)) continue;
      const sel = tag + '[' + attrs[i] + '="' + attrEscape(value) + '"]';
      if (matchesOnly(sel, el)) return sel;
    }
    const raw = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
    const stable = raw.filter((cls) => cls && !/^(is|has|js)-/.test(cls) && !/^css-/.test(cls) && !/^sc-/.test(cls));
    if (stable.length) {
      const sel = tag + '.' + stable.map(cssEscape).join('.');
      if (matchesOnly(sel, el)) return sel;
    }
    const chain = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && chain.length < 6) {
      chain.unshift(node);
      node = node.parentElement;
    }
    function compound(item, nth) {
      const itemTag = item.tagName.toLowerCase();
      const classes = (typeof item.className === 'string' ? item.className.trim().split(/\s+/) : [])
        .filter((cls) => cls && !/^(is|has|js)-/.test(cls) && !/^css-/.test(cls));
      let part = classes.length ? itemTag + '.' + classes.slice(0, 2).map(cssEscape).join('.') : itemTag;
      if (nth && item.parentElement) {
        const siblings = Array.from(item.parentElement.children).filter((child) => child.tagName === item.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(item) + 1) + ')';
      }
      return part;
    }
    for (let start = chain.length - 1; start >= 0; start--) {
      const slice = chain.slice(start);
      const plain = slice.map((item) => compound(item, false)).join(' ');
      if (matchesOnly(plain, el)) return plain;
      const withNth = slice.map((item) => compound(item, true)).join(' ');
      if (withNth !== plain && matchesOnly(withNth, el)) return withNth;
    }
    return chain.map((item) => compound(item, true)).join(' ');
  }

  function getSelector(el) {
    if (window.PivitRuntime && typeof window.PivitRuntime.uniqueSelector === 'function') {
      return window.PivitRuntime.uniqueSelector(el, document);
    }
    return fallbackSelector(el);
  }

  function onMouseMove(e) {
    if (e.target === bar || bar.contains(e.target)) return;
    clearHighlight();
    highlighted = e.target;
    highlighted.style.outline = '2px solid #5635FB';
    highlighted.style.outlineOffset = '1px';
  }

  function showResult(selector) {
    clearHighlight();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    bar.textContent = '';
    bar.style.textAlign = 'left';
    bar.style.background = '#fff';
    bar.style.color = '#131723';
    bar.style.padding = '16px 18px';

    const title = document.createElement('div');
    title.textContent = 'Selector';
    title.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:8px;';
    bar.appendChild(title);

    const field = document.createElement('input');
    field.readOnly = true;
    field.value = selector;
    field.setAttribute('aria-label', 'Selector');
    field.style.cssText = 'display:block;width:100%;box-sizing:border-box;font:15px/1.4 Menlo,Consolas,monospace;padding:12px;border:1px solid #e6e7f0;border-radius:8px;color:#131723;background:#f7f7fb;';
    bar.appendChild(field);

    const note = document.createElement('div');
    const positional = isPositional(selector);
    note.textContent = positional ? POSITION_WARNING : COPIED;
    note.setAttribute('role', positional ? 'alert' : 'status');
    note.style.cssText = positional
      ? 'margin-top:12px;padding:14px 16px;border-radius:10px;background:#fff4e5;color:#6a4b12;font-size:16px;font-weight:650;line-height:1.45;'
      : 'margin-top:10px;font-size:15px;font-weight:650;color:#131723;';
    bar.appendChild(note);

    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done';
    done.style.cssText = 'margin-top:12px;padding:8px 14px;border:0;border-radius:8px;background:#5635FB;color:#fff;font:14px -apple-system,sans-serif;font-weight:700;cursor:pointer;';
    done.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    });
    bar.appendChild(done);
    field.focus();
    field.select();
  }

  function onClick(e) {
    if (e.target === bar || bar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const selector = getSelector(e.target);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(selector).catch(() => {});
    }
    showResult(selector);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanup();
  }

  function cleanup() {
    clearHighlight();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (bar.parentNode) bar.remove();
    window.__abPickerActive = false;
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();
