/**
 * Pivit visual editor — v0.1 (stage 1: Remove, Duplicate, Add above/below)
 *
 * Loaded by ab.js only when it sees ?ab_edit=<variant_id>&token=<token> in the
 * URL — never downloaded by a real visitor. Runs entirely on the client's own
 * domain (same-origin DOM access), authenticates back to the Pivit API with a
 * scoped, short-lived token instead of a session cookie (see src/edit-token.js
 * for why: normal session cookies are deliberately never sent cross-site).
 *
 * "Replace/change element" (full HTML/CSS/JS editing) is deliberately not in
 * this version — it needs a richer panel pre-filled with the element's current
 * markup, coming in the next stage.
 */
(function () {
  const scriptTag = document.currentScript || document.querySelector('script[src*="/snippet/editor.js"]');
  const API_BASE = (scriptTag && scriptTag.getAttribute('data-api')) || '';
  const VARIANT_ID = scriptTag && scriptTag.getAttribute('data-variant-id');
  const TOKEN = new URLSearchParams(window.location.search).get('token');

  const Z = 2147483647; // max safe z-index — stays above whatever the host page uses
  const COLORS = { indigo: '#5635FB', indigoDark: '#4527d6', mint: '#02DEB5', ink: '#131723', danger: '#d64545', border: '#e6e7f0' };

  let existingChanges = [];
  let pendingChanges = [];
  let experimentName = '';
  let variantName = '';
  let pickingActive = false;
  let hoveredEl = null;

  // --- DOM mutation primitives (same semantics as snippet/ab.js's applyChange,
  // kept as its own copy so this file has no runtime dependency on ab.js). ---
  function applyChange(change) {
    const els = document.querySelectorAll(change.selector);
    els.forEach((el) => {
      switch (change.type) {
        case 'text': el.textContent = change.value; break;
        case 'html': el.innerHTML = change.value; break;
        case 'hide': el.style.display = 'none'; break;
        case 'show': el.style.display = ''; break;
        case 'style': Object.assign(el.style, change.value || {}); break;
        case 'attr': if (change.attr) el.setAttribute(change.attr, change.value); break;
        case 'js': try { new Function('el', change.value)(el); } catch (e) { console.warn('[pivit-editor] js change failed:', e); } break;
        case 'remove': el.remove(); break;
        case 'duplicate': {
          const clone = el.cloneNode(true);
          clone.removeAttribute('id');
          el.insertAdjacentElement('afterend', clone);
          break;
        }
        case 'insert_before': el.insertAdjacentHTML('beforebegin', change.value); break;
        case 'insert_after': el.insertAdjacentHTML('afterend', change.value); break;
      }
    });
  }

  // --- Selector computation (same approach as snippet/picker-bookmarklet.js) ---
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
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(' > ');
  }

  // --- API calls (token in the query string — no cookies involved at all) ---
  async function fetchVariant() {
    const res = await fetch(`${API_BASE}/api/editor/variants/${VARIANT_ID}?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }
  async function saveChanges(allChanges) {
    const res = await fetch(`${API_BASE}/api/editor/variants/${VARIANT_ID}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: allChanges }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  // --- UI: a single floating root element, all children styled inline to stay
  // insulated from whatever CSS the host page already has. ---
  let root, toolbar, statusEl, countEl, actionPopup, panelEl, highlightBox;

  // Deliberately NOT `style.all = 'initial'` — that resets `display` to CSS's
  // initial value (inline), not a div's normal block default, which silently
  // breaks layout (discovered via testing: it made an invisible element cover
  // the toolbar's own button). Reset only the properties actually at risk of
  // inheriting something unwanted from the host page.
  function styleReset(el) {
    el.style.fontFamily = '-apple-system, "Segoe UI", Roboto, sans-serif';
    el.style.boxSizing = 'border-box';
    el.style.lineHeight = 'normal';
    el.style.textAlign = 'left';
    el.style.float = 'none';
    el.style.margin = '0';
  }

  function buildToolbar() {
    root = document.createElement('div');
    styleReset(root);
    root.style.position = 'fixed';
    root.style.zIndex = String(Z);
    root.style.bottom = '20px';
    root.style.right = '20px';
    document.body.appendChild(root);

    toolbar = document.createElement('div');
    styleReset(toolbar);
    Object.assign(toolbar.style, {
      background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: '12px',
      boxShadow: '0 8px 28px rgba(19,23,35,0.18)', padding: '14px', width: '280px',
      fontSize: '13px', color: COLORS.ink,
    });
    root.appendChild(toolbar);

    const title = document.createElement('div');
    styleReset(title);
    title.style.fontWeight = '700';
    title.style.marginBottom = '2px';
    title.textContent = 'Pivit editor';
    toolbar.appendChild(title);

    statusEl = document.createElement('div');
    styleReset(statusEl);
    statusEl.style.color = '#6b6f83';
    statusEl.style.fontSize = '12px';
    statusEl.style.marginBottom = '10px';
    toolbar.appendChild(statusEl);

    const pickBtn = makeButton('🎯 Select element', COLORS.indigo, () => togglePicking());
    pickBtn.style.width = '100%';
    pickBtn.id = 'pivit-pick-btn';
    toolbar.appendChild(pickBtn);

    countEl = document.createElement('div');
    styleReset(countEl);
    countEl.style.fontSize = '12px';
    countEl.style.color = '#6b6f83';
    countEl.style.margin = '8px 0';
    toolbar.appendChild(countEl);

    const saveBtn = makeButton('💾 Save', COLORS.mint, onSave);
    saveBtn.style.width = '100%';
    saveBtn.style.color = COLORS.ink;
    toolbar.appendChild(saveBtn);

    const previewRow = document.createElement('div');
    styleReset(previewRow);
    previewRow.style.display = 'flex';
    previewRow.style.gap = '6px';
    previewRow.style.marginTop = '8px';
    ['Desktop', 'Tablet', 'Mobile'].forEach((label) => {
      const sizes = { Desktop: [1280, 800], Tablet: [768, 1024], Mobile: [390, 844] };
      const btn = makeButton(label, '#f0f0f7', () => openPreview(sizes[label][0], sizes[label][1]));
      btn.style.flex = '1';
      btn.style.color = COLORS.ink;
      btn.style.fontSize = '11px';
      btn.style.padding = '6px 4px';
      previewRow.appendChild(btn);
    });
    toolbar.appendChild(previewRow);

    const hint = document.createElement('div');
    styleReset(hint);
    hint.style.fontSize = '11px';
    hint.style.color = '#6b6f83';
    hint.style.marginTop = '8px';
    hint.textContent = 'Preview reflects the last save, not unsaved edits.';
    toolbar.appendChild(hint);

    updateCount();
  }

  function makeButton(label, bg, onClick) {
    const btn = document.createElement('button');
    styleReset(btn);
    btn.textContent = label;
    Object.assign(btn.style, {
      display: 'block', background: bg, color: '#fff', border: 'none', borderRadius: '8px',
      padding: '10px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', marginTop: '0',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function updateCount() {
    countEl.textContent = `${pendingChanges.length} unsaved change${pendingChanges.length === 1 ? '' : 's'}`;
  }

  function openPreview(width, height) {
    const url = new URL(window.location.href);
    url.searchParams.delete('ab_edit');
    url.searchParams.delete('token');
    url.searchParams.set('ab_preview', VARIANT_ID);
    window.open(url.toString(), '_blank', `width=${width},height=${height}`);
  }

  // --- Element picking ---

  function togglePicking() {
    pickingActive = !pickingActive;
    const btn = document.getElementById('pivit-pick-btn');
    if (pickingActive) {
      btn.textContent = '✕ Cancel picking';
      btn.style.background = COLORS.danger;
      document.addEventListener('mousemove', onHoverMove, true);
      document.addEventListener('click', onPickClick, true);
      document.body.style.cursor = 'crosshair';
    } else {
      stopPicking();
    }
  }

  function stopPicking() {
    pickingActive = false;
    const btn = document.getElementById('pivit-pick-btn');
    if (btn) { btn.textContent = '🎯 Select element'; btn.style.background = COLORS.indigo; }
    document.removeEventListener('mousemove', onHoverMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.body.style.cursor = '';
    clearHighlight();
  }

  function clearHighlight() {
    if (hoveredEl) { hoveredEl.style.outline = ''; hoveredEl.style.outlineOffset = ''; }
    hoveredEl = null;
  }

  function onHoverMove(e) {
    if (root.contains(e.target) || (actionPopup && actionPopup.contains(e.target))) return;
    clearHighlight();
    hoveredEl = e.target;
    hoveredEl.style.outline = `2px solid ${COLORS.indigo}`;
    hoveredEl.style.outlineOffset = '1px';
  }

  function onPickClick(e) {
    if (root.contains(e.target)) return; // clicks on our own toolbar pass through normally
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    stopPicking();
    showActionPopup(target, e.clientX, e.clientY);
  }

  // --- Quick-actions popup ---

  function closeActionPopup() {
    if (actionPopup) { actionPopup.remove(); actionPopup = null; }
  }

  function showActionPopup(el, x, y) {
    closeActionPopup();
    const selector = getSelector(el);

    actionPopup = document.createElement('div');
    styleReset(actionPopup);
    Object.assign(actionPopup.style, {
      position: 'fixed', left: Math.min(x, window.innerWidth - 200) + 'px', top: Math.min(y, window.innerHeight - 220) + 'px',
      zIndex: String(Z), background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: '10px',
      boxShadow: '0 8px 28px rgba(19,23,35,0.2)', padding: '8px', width: '190px', fontSize: '13px',
    });
    document.body.appendChild(actionPopup);

    const actions = [
      ['✏ Add above', () => showContentPanel(el, selector, 'insert_before')],
      ['✏ Add below', () => showContentPanel(el, selector, 'insert_after')],
      ['⧉ Duplicate', () => { recordAndApply({ selector, type: 'duplicate' }); closeActionPopup(); }],
      ['🗑 Remove', () => { recordAndApply({ selector, type: 'remove' }); closeActionPopup(); }],
    ];
    actions.forEach(([label, handler]) => {
      const item = document.createElement('div');
      styleReset(item);
      Object.assign(item.style, { padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', color: COLORS.ink });
      item.textContent = label;
      item.addEventListener('mouseenter', () => { item.style.background = '#f4f2fe'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', handler);
      actionPopup.appendChild(item);
    });

    const cancel = document.createElement('div');
    styleReset(cancel);
    Object.assign(cancel.style, { padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', color: '#6b6f83', textAlign: 'center', marginTop: '2px' });
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeActionPopup);
    actionPopup.appendChild(cancel);
  }

  function recordAndApply(change) {
    applyChange(change);
    pendingChanges.push(change);
    updateCount();
  }

  // --- "Add above/below" content panel — a single HTML textarea for now;
  // the full multi-field HTML/CSS/JS editor is the next stage, used for
  // "Replace/change" once that's built. ---
  function showContentPanel(el, selector, insertType) {
    closeActionPopup();
    panelEl = document.createElement('div');
    styleReset(panelEl);
    Object.assign(panelEl.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      zIndex: String(Z), background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: '12px',
      boxShadow: '0 12px 40px rgba(19,23,35,0.25)', padding: '20px', width: '480px', maxWidth: '90vw',
    });
    document.body.appendChild(panelEl);

    const label = document.createElement('div');
    styleReset(label);
    label.style.fontWeight = '700';
    label.style.marginBottom = '8px';
    label.style.color = COLORS.ink;
    label.textContent = insertType === 'insert_before' ? 'HTML to add above this element' : 'HTML to add below this element';
    panelEl.appendChild(label);

    const textarea = document.createElement('textarea');
    styleReset(textarea);
    Object.assign(textarea.style, {
      width: '100%', height: '140px', padding: '10px', border: `1px solid ${COLORS.border}`, borderRadius: '8px',
      fontFamily: 'Menlo, monospace', fontSize: '12px', color: COLORS.ink,
    });
    textarea.placeholder = '<div>New content…</div>';
    panelEl.appendChild(textarea);

    const row = document.createElement('div');
    styleReset(row);
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.marginTop = '12px';
    const applyBtn = makeButton('Apply', COLORS.indigo, () => {
      const value = textarea.value.trim();
      if (!value) { textarea.style.border = `1px solid ${COLORS.danger}`; return; }
      recordAndApply({ selector, type: insertType, value });
      panelEl.remove();
    });
    applyBtn.style.flex = '1';
    const cancelBtn = makeButton('Cancel', '#f0f0f7', () => panelEl.remove());
    cancelBtn.style.flex = '1';
    cancelBtn.style.color = COLORS.ink;
    row.appendChild(applyBtn);
    row.appendChild(cancelBtn);
    panelEl.appendChild(row);
  }

  // --- Save ---
  async function onSave() {
    const merged = existingChanges.concat(pendingChanges);
    statusEl.textContent = 'Saving…';
    try {
      await saveChanges(merged);
      existingChanges = merged;
      pendingChanges = [];
      updateCount();
      statusEl.textContent = 'Saved ✓';
      setTimeout(() => { statusEl.textContent = `${experimentName} — ${variantName}`; }, 2000);
    } catch (err) {
      statusEl.textContent = `Save failed: ${err.message}`;
    }
  }

  // --- Boot ---
  async function boot() {
    if (!VARIANT_ID || !TOKEN) {
      console.error('[pivit-editor] missing variant id or token — cannot start.');
      return;
    }
    try {
      const variant = await fetchVariant();
      experimentName = variant.experiment_name || '';
      variantName = variant.name || '';
      existingChanges = Array.isArray(variant.changes) ? variant.changes : [];
      existingChanges.forEach(applyChange);

      buildToolbar();
      statusEl.textContent = `${experimentName} — ${variantName}`;
    } catch (err) {
      const banner = document.createElement('div');
      styleReset(banner);
      Object.assign(banner.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: String(Z), background: '#fdeaea',
        color: '#8a2d2d', padding: '14px', textAlign: 'center', fontFamily: '-apple-system, sans-serif', fontSize: '14px',
      });
      banner.textContent = `Pivit editor couldn't start: ${err.message}`;
      document.body.appendChild(banner);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
