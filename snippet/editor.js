/**
 * Pivit visual editor — v0.2 (stage 1: Remove, Duplicate, Add above/below,
 * plus a Changes list with Edit/Remove on each entry)
 *
 * Loaded by ab.js only when it sees ?ab_edit=<variant_id>&token=<token> in the
 * URL — never downloaded by a real visitor. Runs entirely on the client's own
 * domain (same-origin DOM access), authenticates back to the Pivit API with a
 * scoped, short-lived token instead of a session cookie (see src/edit-token.js
 * for why: normal session cookies are deliberately never sent cross-site).
 *
 * "Replace/change element" (full HTML/CSS/JS editing) is deliberately not in
 * this version — it needs a richer panel pre-filled with the element's current
 * markup, coming next, built on top of the Changes list added here.
 *
 * Editing or removing an EXISTING change reloads the page and replays the
 * updated change list from a clean DOM, rather than trying to reverse an
 * arbitrary DOM mutation in place (which isn't reliably possible — there's no
 * generic "undo" for an innerHTML overwrite or a node removal). The working
 * change list survives the reload via sessionStorage, keyed per variant, so
 * unsaved edits aren't lost either.
 */
(function () {
  const scriptTag = document.currentScript || document.querySelector('script[src*="/snippet/editor.js"]');
  const API_BASE = (scriptTag && scriptTag.getAttribute('data-api')) || '';
  const VARIANT_ID = scriptTag && scriptTag.getAttribute('data-variant-id');
  const TOKEN = new URLSearchParams(window.location.search).get('token');

  const Z = 2147483647; // max safe z-index — stays above whatever the host page uses
  const COLORS = { indigo: '#5635FB', indigoDark: '#4527d6', mint: '#02DEB5', ink: '#131723', danger: '#d64545', border: '#e6e7f0' };
  const STORAGE_KEY = `pivit_editor_changes_${VARIANT_ID}`;

  let allChanges = [];       // the full working set — both already-saved and new-this-session
  let savedSnapshot = '[]';  // JSON of what's actually saved on the server, for the dirty check
  let experimentName = '';
  let variantName = '';
  let pickingActive = false;
  let hoveredEl = null;
  let changesListOpen = false;

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

  // Plain-English description of a change, for the Changes list.
  function describeChange(change) {
    const sel = change.selector;
    switch (change.type) {
      case 'text': return `Change text on ${sel}`;
      case 'html': return `Replace HTML on ${sel}`;
      case 'hide': return `Hide ${sel}`;
      case 'show': return `Show ${sel}`;
      case 'style': return `Custom CSS on ${sel}`;
      case 'attr': return `Set ${change.attr || 'attribute'} on ${sel}`;
      case 'js': return `Custom JS on ${sel}`;
      case 'remove': return `Remove ${sel}`;
      case 'duplicate': return `Duplicate ${sel}`;
      case 'insert_before': return `Insert HTML above ${sel}`;
      case 'insert_after': return `Insert HTML below ${sel}`;
      default: return `${change.type} on ${sel}`;
    }
  }

  // Only insert_before/insert_after have a simple single-value editor right
  // now — html/style/js get real "Edit" support once the full Replace/Change
  // panel exists. duplicate/remove/hide/show have no content to edit at all.
  function isEditable(change) {
    return change.type === 'insert_before' || change.type === 'insert_after';
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
  async function saveChanges(changes) {
    const res = await fetch(`${API_BASE}/api/editor/variants/${VARIANT_ID}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  // --- Working-set persistence across a reload ---
  function persistWorkingSet() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(allChanges)); } catch (e) { /* ignore quota/privacy-mode errors */ }
  }
  function readPersistedWorkingSet() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearPersistedWorkingSet() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  // Edit or remove on an EXISTING change can't reliably be undone in place —
  // there's no generic way to reverse an arbitrary DOM mutation. Instead:
  // persist the updated array, then reload onto a clean DOM and replay it.
  function reloadAndReplay() {
    persistWorkingSet();
    window.location.reload();
  }

  function isDirty() {
    return JSON.stringify(allChanges) !== savedSnapshot;
  }

  // --- UI: a single floating root element, all children styled inline to stay
  // insulated from whatever CSS the host page already has. ---
  let root, toolbar, statusEl, countEl, actionPopup, panelEl, changesListEl;

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
      boxShadow: '0 8px 28px rgba(19,23,35,0.18)', padding: '14px', width: '300px',
      fontSize: '13px', color: COLORS.ink, maxHeight: '80vh', overflowY: 'auto',
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

    // --- Changes list (collapsible) ---
    const listToggle = makeButton('Changes (0)', '#f0f0f7', toggleChangesList);
    listToggle.style.width = '100%';
    listToggle.style.color = COLORS.ink;
    listToggle.id = 'pivit-changes-toggle';
    toolbar.appendChild(listToggle);

    changesListEl = document.createElement('div');
    styleReset(changesListEl);
    changesListEl.style.display = 'none';
    changesListEl.style.marginTop = '6px';
    toolbar.appendChild(changesListEl);

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

    refreshToolbarState();
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

  function toggleChangesList() {
    changesListOpen = !changesListOpen;
    renderChangesList();
  }

  function renderChangesList() {
    const toggleBtn = document.getElementById('pivit-changes-toggle');
    if (toggleBtn) toggleBtn.textContent = `Changes (${allChanges.length}) ${changesListOpen ? '▲' : '▼'}`;
    changesListEl.style.display = changesListOpen ? 'block' : 'none';
    changesListEl.innerHTML = '';

    if (allChanges.length === 0) {
      const empty = document.createElement('div');
      styleReset(empty);
      empty.style.fontSize = '12px';
      empty.style.color = '#6b6f83';
      empty.style.padding = '6px 2px';
      empty.textContent = 'No changes yet — select an element to start.';
      changesListEl.appendChild(empty);
      return;
    }

    allChanges.forEach((change, idx) => {
      const row = document.createElement('div');
      styleReset(row);
      Object.assign(row.style, {
        padding: '8px', marginTop: '6px', background: '#fafafe', border: `1px solid ${COLORS.border}`,
        borderRadius: '8px', fontSize: '12px',
      });

      const desc = document.createElement('div');
      styleReset(desc);
      desc.style.marginBottom = '6px';
      desc.style.color = COLORS.ink;
      desc.style.wordBreak = 'break-word';
      desc.textContent = describeChange(change);
      row.appendChild(desc);

      const btnRow = document.createElement('div');
      styleReset(btnRow);
      btnRow.style.display = 'flex';
      btnRow.style.gap = '6px';

      if (isEditable(change)) {
        const editBtn = makeButton('Edit', '#f0f0f7', () => editChangeAtIndex(idx));
        editBtn.style.color = COLORS.ink;
        editBtn.style.fontSize = '11px';
        editBtn.style.padding = '5px 10px';
        btnRow.appendChild(editBtn);
      }
      const removeBtn = makeButton('Remove', '#fdeaea', () => removeChangeAtIndex(idx));
      removeBtn.style.color = COLORS.danger;
      removeBtn.style.fontSize = '11px';
      removeBtn.style.padding = '5px 10px';
      btnRow.appendChild(removeBtn);

      row.appendChild(btnRow);
      changesListEl.appendChild(row);
    });
  }

  function removeChangeAtIndex(idx) {
    const change = allChanges[idx];
    if (!confirm(`Remove this change?\n\n${describeChange(change)}\n\nThe page will reload to show the result.`)) return;
    allChanges.splice(idx, 1);
    reloadAndReplay();
  }

  function editChangeAtIndex(idx) {
    const change = allChanges[idx];
    showContentPanel(change.selector, change.type, change.value, idx);
  }

  function refreshToolbarState() {
    countEl.textContent = isDirty() ? '● Unsaved changes' : '✓ All changes saved';
    renderChangesList();
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
      ['✏ Add above', () => showContentPanel(selector, 'insert_before', '', null)],
      ['✏ Add below', () => showContentPanel(selector, 'insert_after', '', null)],
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

  // Records a NEW change (from a quick action, not from editing an existing
  // list entry) — applies directly to the live DOM, no reload needed, since
  // adding something new doesn't require reversing anything.
  function recordAndApply(change) {
    applyChange(change);
    allChanges.push(change);
    persistWorkingSet();
    refreshToolbarState();
  }

  // --- Content panel: used both for new Add-above/below actions (editIndex
  // is null) and for editing an existing insert_before/insert_after entry
  // from the Changes list (editIndex is that entry's index). ---
  function showContentPanel(selector, changeType, initialValue, editIndex) {
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
    label.textContent = changeType === 'insert_before' ? 'HTML to add above this element' : 'HTML to add below this element';
    panelEl.appendChild(label);

    const textarea = document.createElement('textarea');
    styleReset(textarea);
    Object.assign(textarea.style, {
      width: '100%', height: '140px', padding: '10px', border: `1px solid ${COLORS.border}`, borderRadius: '8px',
      fontFamily: 'Menlo, monospace', fontSize: '12px', color: COLORS.ink,
    });
    textarea.placeholder = '<div>New content…</div>';
    textarea.value = initialValue || '';
    panelEl.appendChild(textarea);

    const row = document.createElement('div');
    styleReset(row);
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.marginTop = '12px';
    const applyBtn = makeButton(editIndex === null ? 'Apply' : 'Save change', COLORS.indigo, () => {
      const value = textarea.value.trim();
      if (!value) { textarea.style.border = `1px solid ${COLORS.danger}`; return; }
      panelEl.remove();
      if (editIndex === null) {
        recordAndApply({ selector, type: changeType, value });
      } else {
        allChanges[editIndex] = { ...allChanges[editIndex], value };
        reloadAndReplay();
      }
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
    statusEl.textContent = 'Saving…';
    try {
      await saveChanges(allChanges);
      savedSnapshot = JSON.stringify(allChanges);
      clearPersistedWorkingSet();
      refreshToolbarState();
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
      const serverChanges = Array.isArray(variant.changes) ? variant.changes : [];
      savedSnapshot = JSON.stringify(serverChanges);

      // A working set left over from a reload-and-replay (an in-progress,
      // not-yet-saved edit) takes precedence over what's on the server.
      const persisted = readPersistedWorkingSet();
      allChanges = persisted !== null ? persisted : serverChanges;

      allChanges.forEach(applyChange);

      buildToolbar();
      statusEl.textContent = `${experimentName} — ${variantName}`;
      refreshToolbarState();
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
