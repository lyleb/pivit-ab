/**
 * AB Selector Picker — bookmarklet
 *
 * Not part of the tracking snippet. This is a standalone tool: drag the
 * "AB Selector Picker" link on the admin dashboard to your bookmarks bar,
 * then click it while viewing the actual client page. Click any element
 * on that page and its CSS selector gets copied to your clipboard.
 */
(function () {
  if (window.__abPickerActive) return;
  window.__abPickerActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1AB7C8;color:#fff;padding:10px 16px;font:14px -apple-system,sans-serif;z-index:2147483647;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
  overlay.textContent = 'AB Selector Picker: click an element to copy its selector — press Esc to cancel';
  document.documentElement.appendChild(overlay);

  let highlighted = null;
  function clearHighlight() {
    if (highlighted) { highlighted.style.outline = ''; highlighted.style.outlineOffset = ''; }
  }

  function cssEscape(str) {
    return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function getSelector(el) {
    if (el.id) return '#' + cssEscape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (typeof node.className === 'string' && node.className.trim()) {
        const classes = node.className.trim().split(/\s+/).slice(0, 2).map(cssEscape);
        if (classes.length) part += '.' + classes.join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTagSiblings.length > 1) part += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(' > ');
  }

  function onMouseMove(e) {
    if (e.target === overlay) return;
    clearHighlight();
    highlighted = e.target;
    highlighted.style.outline = '2px solid #1AB7C8';
    highlighted.style.outlineOffset = '1px';
  }

  function onClick(e) {
    if (e.target === overlay) return;
    e.preventDefault();
    e.stopPropagation();
    const selector = getSelector(e.target);
    cleanup();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(selector).catch(() => {});
    }
    window.prompt('Selector (copied to clipboard if permitted) — paste this into the admin dashboard:', selector);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanup();
  }

  function cleanup() {
    clearHighlight();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    window.__abPickerActive = false;
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();
