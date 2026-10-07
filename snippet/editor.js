/**
 * Pivit visual editor — v0.4 (Edit element with HTML/CSS/JS, Remove, Duplicate,
 * Add above/below, Set as goal, plus Changes and Goals lists)
 *
 * Loaded by ab.js only when it sees ?ab_edit=<variant_id>&token=<token> in the
 * URL — never downloaded by a real visitor. Runs entirely on the client's own
 * domain (same-origin DOM access), authenticates back to the Pivit API with a
 * scoped, short-lived token instead of a session cookie (see src/edit-token.js
 * for why: normal session cookies are deliberately never sent cross-site).
 *
 * "Edit element" opens a panel with HTML / CSS / JS tabs. Each part becomes its
 * own entry in the Changes list ('replace', 'stylesheet', 'js'), so it can be
 * edited or removed independently later.
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
  let allGoals = [];         // this variant's click/url goals, same idea
  let savedSnapshot = '';    // canonical form of what's actually saved on the server, for the dirty check
  let experimentName = '';
  let variantName = '';
  let pickingActive = false;
  let hoveredEl = null;
  let changesListOpen = false;
  let goalsListOpen = false;

  // --- DOM mutation primitives (same semantics as snippet/ab.js's applyChange,
  // kept as its own copy so this file has no runtime dependency on ab.js). ---
  function applyChange(change) {
    // Raw CSS isn't tied to a matched element — own <style> tag per change, so a
    // typo in one block can't break the others (mirrors snippet/ab.js).
    if (change.type === 'stylesheet') {
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-pivit-css', '');
      styleEl.textContent = change.value || '';
      document.head.appendChild(styleEl);
      return;
    }
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
        case 'replace': el.insertAdjacentHTML('afterend', change.value); el.remove(); break;
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
      case 'style': return `Inline styles on ${sel}`;
      case 'stylesheet': return sel ? `Add CSS rules (for ${sel})` : 'Add CSS rules';
      case 'replace': return `Replace element ${sel}`;
      case 'attr': return `Set ${change.attr || 'attribute'} on ${sel}`;
      case 'js': return `Custom JS on ${sel}`;
      case 'remove': return `Remove ${sel}`;
      case 'duplicate': return `Duplicate ${sel}`;
      case 'insert_before': return `Insert HTML above ${sel}`;
      case 'insert_after': return `Insert HTML below ${sel}`;
      default: return `${change.type} on ${sel}`;
    }
  }

  // What each editable change type's value is, for the single-field edit panel.
  // Not listed (so Remove-only): duplicate/remove/hide/show have no content to
  // edit, and 'style' (inline-style object) / 'attr' (attr + value) predate the
  // visual editor and don't fit one text box — remove and re-add via CSS/JS.
  const EDIT_META = {
    text: { label: 'Text', hint: "Plain text — replaces the element's text content." },
    html: { label: 'HTML', hint: 'Replaces everything inside the element.' },
    replace: { label: 'HTML', hint: 'Replaces the whole element.' },
    insert_before: { label: 'HTML', hint: 'Inserted directly above the element.' },
    insert_after: { label: 'HTML', hint: 'Inserted directly below the element.' },
    stylesheet: { label: 'CSS', hint: 'Plain CSS, applied to the whole page. Use !important to override the site.' },
    js: { label: 'JavaScript', hint: '"el" is the selected element.' },
  };
  function isEditable(change) {
    return !!EDIT_META[change.type];
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
  async function saveWorkingSet(changes, goals) {
    const res = await fetch(`${API_BASE}/api/editor/variants/${VARIANT_ID}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes, goals }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  // --- Working-set persistence across a reload ---
  function persistWorkingSet() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ changes: allChanges, goals: allGoals })); } catch (e) { /* ignore quota/privacy-mode errors */ }
  }
  function readPersistedWorkingSet() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { changes: parsed, goals: null }; // written before goals existed here
      if (parsed && Array.isArray(parsed.changes)) return { changes: parsed.changes, goals: Array.isArray(parsed.goals) ? parsed.goals : null };
      return null;
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

  // Key-order-independent serialisation: the server's JSONB column hands objects
  // back with its own key order, so a plain JSON.stringify comparison could call
  // identical content "unsaved".
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  function currentSnapshot() {
    return canon({ changes: allChanges, goals: allGoals });
  }
  function isDirty() {
    return currentSnapshot() !== savedSnapshot;
  }

  // --- UI: a single floating root element, all children styled inline to stay
  // insulated from whatever CSS the host page already has. ---
  let root, toolbar, statusEl, countEl, actionPopup, panelEl, changesListEl, goalsListEl;

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
    title.textContent = 'pivitlab editor';
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

    // --- Goals list (collapsible) ---
    const goalsToggle = makeButton('Goals (0)', '#f0f0f7', toggleGoalsList);
    goalsToggle.style.width = '100%';
    goalsToggle.style.color = COLORS.ink;
    goalsToggle.style.marginTop = '6px';
    goalsToggle.id = 'pivit-goals-toggle';
    toolbar.appendChild(goalsToggle);

    goalsListEl = document.createElement('div');
    styleReset(goalsListEl);
    goalsListEl.style.display = 'none';
    goalsListEl.style.marginTop = '6px';
    toolbar.appendChild(goalsListEl);

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

  function toggleGoalsList() {
    goalsListOpen = !goalsListOpen;
    renderGoalsList();
  }

  function describeGoal(g) {
    return (g.type || 'click') === 'url'
      ? `Visit goal "${g.id || g.url_match}" — URL contains ${g.url_match}`
      : `Click goal "${g.id || g.selector}" on ${g.selector}`;
  }

  function renderGoalsList() {
    const toggleBtn = document.getElementById('pivit-goals-toggle');
    if (toggleBtn) toggleBtn.textContent = `Goals (${allGoals.length}) ${goalsListOpen ? '▲' : '▼'}`;
    goalsListEl.style.display = goalsListOpen ? 'block' : 'none';
    goalsListEl.innerHTML = '';

    if (allGoals.length === 0) {
      const empty = document.createElement('div');
      styleReset(empty);
      Object.assign(empty.style, { fontSize: '12px', color: '#6b6f83', padding: '6px 2px' });
      empty.textContent = 'No goals yet — select the button or link that counts as a conversion, then "Set as goal".';
      goalsListEl.appendChild(empty);
      return;
    }
    allGoals.forEach((goal, idx) => {
      const row = document.createElement('div');
      styleReset(row);
      Object.assign(row.style, { padding: '8px', marginTop: '6px', background: '#fafafe', border: `1px solid ${COLORS.border}`, borderRadius: '8px', fontSize: '12px' });
      const desc = document.createElement('div');
      styleReset(desc);
      Object.assign(desc.style, { marginBottom: '6px', color: COLORS.ink, wordBreak: 'break-word' });
      desc.textContent = describeGoal(goal);
      row.appendChild(desc);
      const removeBtn = makeButton('Remove', '#fdeaea', () => {
        if (!confirm(`Remove this goal?\n\n${describeGoal(goal)}`)) return;
        allGoals.splice(idx, 1);
        persistWorkingSet();
        refreshToolbarState(); // goals don't touch the page, so no reload needed
      });
      Object.assign(removeBtn.style, { color: COLORS.danger, fontSize: '11px', padding: '5px 10px' });
      row.appendChild(removeBtn);
      goalsListEl.appendChild(row);
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
    // The replace / stylesheet / js entries made together by "Edit element" are
    // edited together too, so tweaking one part never means re-adding the others.
    if (EDIT_SET_TYPES.indexOf(change.type) !== -1) { openEditSetPanel(null, change.selector, idx); return; }
    const meta = EDIT_META[change.type];
    showEditorPanel({
      title: describeChange(change),
      fields: [{ key: 'v', label: meta.label, value: typeof change.value === 'string' ? change.value : '', hint: meta.hint }],
      applyLabel: 'Save change',
      onApply: (v) => {
        const value = v.v.trim();
        if (!value) return { error: "This can't be empty — use Remove on the list entry to delete the change." };
        allChanges[idx] = { ...allChanges[idx], value };
        reloadAndReplay(); // see reloadAndReplay(): edits to an existing change replay on a clean page
      },
    });
  }

  function refreshToolbarState() {
    countEl.textContent = isDirty() ? '● Unsaved changes' : '✓ All changes saved';
    renderChangesList();
    renderGoalsList();
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
      position: 'fixed', left: Math.min(x, window.innerWidth - 200) + 'px', top: Math.min(y, window.innerHeight - 310) + 'px',
      zIndex: String(Z), background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: '10px',
      boxShadow: '0 8px 28px rgba(19,23,35,0.2)', padding: '8px', width: '190px', fontSize: '13px',
    });
    document.body.appendChild(actionPopup);

    const actions = [
      ['✎ Edit element', () => openEditElementPanel(el, selector)],
      ['⬆ Add above', () => openInsertPanel(selector, 'insert_before')],
      ['⬇ Add below', () => openInsertPanel(selector, 'insert_after')],
      ['⧉ Duplicate', () => { recordAndApply({ selector, type: 'duplicate' }); closeActionPopup(); }],
      ['🎯 Set as goal', () => openGoalPanel(el)],
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

  // --- Editor panel: one generic panel used everywhere. With several fields it
  // shows tabs (Edit element: HTML / CSS / JS); with one it's a plain textarea
  // (Add above/below, and Edit on a Changes-list entry). onApply(values) may
  // return { error } to keep the panel open with a message. ---
  function showEditorPanel(opts) {
    closeActionPopup();
    if (panelEl) panelEl.remove();
    const fields = opts.fields;

    panelEl = document.createElement('div');
    styleReset(panelEl);
    Object.assign(panelEl.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      zIndex: String(Z), background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: '12px',
      boxShadow: '0 12px 40px rgba(19,23,35,0.25)', padding: '20px', width: '560px', maxWidth: '92vw',
      maxHeight: '90vh', overflowY: 'auto', color: COLORS.ink, fontSize: '13px',
    });
    // Keep keystrokes typed into our panel away from the host page's own
    // keyboard shortcuts (many sites bind single keys like "/" or "s").
    ['keydown', 'keyup', 'keypress'].forEach((evt) => panelEl.addEventListener(evt, (e) => e.stopPropagation()));
    document.body.appendChild(panelEl);

    const title = document.createElement('div');
    styleReset(title);
    title.style.fontWeight = '700';
    title.style.fontSize = '14px';
    title.style.wordBreak = 'break-word';
    title.textContent = opts.title;
    panelEl.appendChild(title);

    if (opts.subtitle) {
      const sub = document.createElement('div');
      styleReset(sub);
      Object.assign(sub.style, { fontSize: '11px', color: '#6b6f83', marginTop: '2px', wordBreak: 'break-all', fontFamily: 'Menlo, monospace' });
      sub.textContent = opts.subtitle;
      panelEl.appendChild(sub);
    }

    const areas = {}, hints = {}, tabBtns = {};
    const multi = fields.length > 1;

    if (multi) {
      const tabRow = document.createElement('div');
      styleReset(tabRow);
      Object.assign(tabRow.style, { display: 'flex', gap: '6px', margin: '12px 0 8px' });
      fields.forEach((f) => {
        const t = makeButton(f.label, '#f0f0f7', () => selectTab(f.key));
        t.style.padding = '6px 16px';
        t.style.fontSize = '12px';
        tabBtns[f.key] = t;
        tabRow.appendChild(t);
      });
      panelEl.appendChild(tabRow);
    } else {
      const spacer = document.createElement('div');
      styleReset(spacer);
      spacer.style.height = '10px';
      panelEl.appendChild(spacer);
    }

    fields.forEach((f) => {
      const ta = document.createElement(f.line ? 'input' : 'textarea'); // line: a one-line value (e.g. a label), not code
      styleReset(ta);
      Object.assign(ta.style, {
        display: 'block', width: '100%', height: f.line ? 'auto' : (multi ? '240px' : '170px'), padding: '10px',
        border: `1px solid ${COLORS.border}`, borderRadius: '8px', fontFamily: 'Menlo, Consolas, monospace',
        fontSize: '12px', color: COLORS.ink, background: '#fff', resize: f.line ? 'none' : 'vertical',
      });
      if (f.line) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doApply(); } });
      ta.setAttribute('spellcheck', 'false');
      ta.placeholder = f.placeholder || '';
      ta.value = f.value || '';
      areas[f.key] = ta;
      panelEl.appendChild(ta);

      const hint = document.createElement('div');
      styleReset(hint);
      Object.assign(hint.style, { fontSize: '11px', color: '#6b6f83', marginTop: '6px', lineHeight: '1.4' });
      hint.textContent = f.hint || '';
      hints[f.key] = hint;
      panelEl.appendChild(hint);
    });

    function selectTab(key) {
      fields.forEach((f) => {
        const on = f.key === key;
        areas[f.key].style.display = on ? 'block' : 'none';
        hints[f.key].style.display = on ? 'block' : 'none';
        if (multi) {
          tabBtns[f.key].style.background = on ? COLORS.indigo : '#f0f0f7';
          tabBtns[f.key].style.color = on ? '#fff' : COLORS.ink;
        }
      });
      areas[key].focus();
    }

    const errEl = document.createElement('div');
    styleReset(errEl);
    Object.assign(errEl.style, { color: COLORS.danger, fontSize: '12px', marginTop: '8px', minHeight: '0' });
    panelEl.appendChild(errEl);

    const row = document.createElement('div');
    styleReset(row);
    Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '12px' });
    function doApply() {
      const values = {};
      fields.forEach((f) => { values[f.key] = areas[f.key].value; });
      const result = opts.onApply(values);
      if (result && result.error) { errEl.textContent = result.error; return; }
      if (panelEl) { panelEl.remove(); panelEl = null; }
    }
    const applyBtn = makeButton(opts.applyLabel || 'Apply', COLORS.indigo, doApply);
    applyBtn.style.flex = '1';
    const cancelBtn = makeButton('Cancel', '#f0f0f7', () => { panelEl.remove(); panelEl = null; });
    cancelBtn.style.flex = '1';
    cancelBtn.style.color = COLORS.ink;
    row.appendChild(applyBtn);
    row.appendChild(cancelBtn);
    panelEl.appendChild(row);

    selectTab(fields[0].key);
  }

  // The element's current markup, minus the empty style="" attributes our own
  // hover highlight leaves behind on elements the pointer passed over.
  function cleanOuterHTML(el) {
    const clone = el.cloneNode(true);
    [clone].concat(Array.from(clone.querySelectorAll('[style]'))).forEach((n) => {
      if (n.getAttribute('style') === '') n.removeAttribute('style');
    });
    return clone.outerHTML;
  }

  const collapse = (str) => str.replace(/\s+/g, ' ').trim();

  // The three parts of "Edit element" are stored as three separate entries.
  const EDIT_SET_TYPES = ['replace', 'stylesheet', 'js'];

  // Indexes (into allChanges) of the entries that make up one element's edit set:
  // same selector, one slot per type. If an entry was clicked in the list
  // (pinnedIdx), that exact entry fills its own slot — so with look-alike
  // duplicates, the tab you opened from edits the entry you clicked.
  function findEditSet(selector, pinnedIdx) {
    const slot = {};
    if (pinnedIdx !== null && pinnedIdx !== undefined) slot[allChanges[pinnedIdx].type] = pinnedIdx;
    EDIT_SET_TYPES.forEach((t) => {
      if (slot[t] !== undefined) return;
      const i = allChanges.findIndex((c) => c.selector === selector && c.type === t);
      if (i !== -1) slot[t] = i;
    });
    return slot;
  }

  // "Edit element": HTML / CSS / JS in one panel. Used for a fresh element AND
  // for re-editing one: if this selector already has replace/stylesheet/js
  // entries, they open pre-filled and are updated in place — change just the
  // HTML and the CSS and JS entries are left exactly as they were. Clearing a
  // tab removes that part. A fresh set applies live; editing existing entries
  // replays on a clean page (see reloadAndReplay).
  function openEditSetPanel(el, selector, pinnedIdx) {
    const slot = findEditSet(selector, pinnedIdx);
    const editing = Object.keys(slot).length > 0;
    const target = el || document.querySelector(selector); // null if nothing matches right now
    const cur = (t) => (slot[t] !== undefined ? allChanges[slot[t]] : null);

    const baseHtml = cur('replace') ? cur('replace').value : (target ? cleanOuterHTML(target) : '');
    const cssSkeleton = `${selector} {\n  \n}`;

    showEditorPanel({
      title: 'Edit element',
      subtitle: selector,
      fields: [
        { key: 'html', label: 'HTML', value: baseHtml,
          hint: cur('replace')
            ? "This is the markup the element is being replaced with. Edit it to tweak the replacement. Clear this tab to put back the page's original element."
            : "The element's current markup on the page, including the effect of any other changes you've made to it. Edit it, or paste new HTML to replace it. Leave it unchanged to keep the element as it is." },
        { key: 'css', label: 'CSS', value: cur('stylesheet') ? cur('stylesheet').value : cssSkeleton,
          hint: "Plain CSS applied to the whole page" + (cur('stylesheet') ? '.' : ', pre-filled with a rule for this element.') +
            " Add !important to beat the site's own styles — z-index, colours, :hover and media queries all work. If you change the element's id or classes above, update the selector here too." +
            (cur('stylesheet') ? ' Clear this tab to remove the CSS.' : '') },
        { key: 'js', label: 'JS', value: cur('js') ? cur('js').value : '', placeholder: "el.addEventListener('click', () => console.log('clicked'));",
          hint: 'Runs once for the selected element — "el" is that element. Applied after the HTML and CSS.' + (cur('js') ? ' Clear this tab to remove the JS.' : '') },
      ],
      applyLabel: editing ? 'Save change' : 'Apply',
      onApply: (v) => {
        const html = v.html.trim();
        const css = v.css.trim();
        const js = v.js.trim();
        const cssEmpty = !css || collapse(css) === collapse(cssSkeleton);
        const next = { replace: null, stylesheet: null, js: null };
        let changed = false;

        // Per part: unchanged -> keep the existing entry untouched; changed ->
        // update it; cleared -> drop it; new -> create it.
        if (cur('replace')) {
          if (!html) changed = true;
          else if (collapse(html) !== collapse(cur('replace').value)) { next.replace = { ...cur('replace'), value: html }; changed = true; }
          else next.replace = cur('replace');
        } else if (html && collapse(html) !== collapse(baseHtml)) {
          if (!target) return { error: "This selector doesn't match anything on the page right now, so its HTML can't be replaced." };
          next.replace = { selector, type: 'replace', value: html }; changed = true;
        }
        if (cur('stylesheet')) {
          if (cssEmpty) changed = true;
          else if (collapse(css) !== collapse(cur('stylesheet').value)) { next.stylesheet = { ...cur('stylesheet'), value: css }; changed = true; }
          else next.stylesheet = cur('stylesheet');
        } else if (!cssEmpty) { next.stylesheet = { selector, type: 'stylesheet', value: css }; changed = true; }
        if (cur('js')) {
          if (!js) changed = true;
          else if (collapse(js) !== collapse(cur('js').value)) { next.js = { ...cur('js'), value: js }; changed = true; }
          else next.js = cur('js');
        } else if (js) { next.js = { selector, type: 'js', value: js }; changed = true; }

        if (!changed) return { error: editing ? 'Nothing changed yet.' : 'Nothing to apply yet — change the HTML, add some CSS, or add some JS.' };

        const finalSet = [next.replace, next.stylesheet, next.js].filter(Boolean); // order matters: replace -> stylesheet -> js
        if (!editing) { finalSet.forEach(recordAndApply); return; }

        // Swap the old entries for the new ones where the first old one sat.
        const oldIdx = Object.keys(slot).map((t) => slot[t]).sort((x, y) => x - y);
        const oldSet = new Set(oldIdx);
        const before = allChanges.slice(0, oldIdx[0]);
        const after = allChanges.slice(oldIdx[0]).filter((_, j) => !oldSet.has(oldIdx[0] + j));
        allChanges = before.concat(finalSet, after);
        reloadAndReplay();
      },
    });
  }

  function openEditElementPanel(el, selector) { openEditSetPanel(el, selector, null); }

  // --- Goals: "Set as goal" marks a click on this element as a conversion for
  // THIS variant. Goals are per variant (each visitor's snippet only wires the
  // goals of the variant they were assigned), so the hint says to repeat it on
  // the others — otherwise those variants are never measured. ---
  function suggestGoalLabel(el) {
    const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    let base = el.id ? slug(el.id) : '';
    if (!base) base = slug((el.textContent || '').trim().split(/\s+/).slice(0, 3).join(' '));
    if (!base) base = el.tagName.toLowerCase();
    let label = `${base}_click`;
    let n = 2;
    while (allGoals.some((g) => g.id === label)) label = `${base}_click_${n++}`;
    return label;
  }

  function openGoalPanel(pickedEl) {
    // If the pick landed on the text/icon inside a button or link, the goal belongs on the
    // button or link itself — that's what visitors actually click.
    const clickable = pickedEl.closest('a, button, [role="button"], input[type="submit"], input[type="button"]') || pickedEl;
    const selector = getSelector(clickable);
    const existing = allGoals.find((g) => (g.type || 'click') === 'click' && g.selector === selector);
    showEditorPanel({
      title: 'Set as click goal',
      subtitle: selector,
      fields: [{
        key: 'label', label: 'Goal label', line: true, value: suggestGoalLabel(clickable),
        hint: 'A click on this element counts as a conversion for this variant, and the label names it in your results. ' +
          (clickable !== pickedEl ? 'Using the button/link around what you clicked. ' : '') +
          'Goals belong to each variant separately — set the same goal (same label) on your other variants too, otherwise they are not measured.',
      }],
      applyLabel: 'Set goal',
      onApply: (v) => {
        const label = v.label.trim();
        if (existing) return { error: `This element is already a goal ("${existing.id || existing.selector}") on this variant. Remove it from the Goals list first to change its label.` };
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(label)) return { error: 'Use letters, numbers, underscores or hyphens only — no spaces.' };
        if (allGoals.some((g) => g.id === label)) return { error: `A goal called "${label}" already exists on this variant — choose a different label.` };
        allGoals.push({ type: 'click', selector, id: label });
        persistWorkingSet();
        refreshToolbarState();
      },
    });
  }

  function openInsertPanel(selector, insertType) {
    showEditorPanel({
      title: insertType === 'insert_before' ? 'Add HTML above this element' : 'Add HTML below this element',
      subtitle: selector,
      fields: [{ key: 'html', label: 'HTML', value: '', placeholder: '<div>New content…</div>' }],
      applyLabel: 'Apply',
      onApply: (v) => {
        const value = v.html.trim();
        if (!value) return { error: 'Enter some HTML to insert.' };
        recordAndApply({ selector, type: insertType, value });
      },
    });
  }

  // --- Save ---
  async function onSave() {
    statusEl.textContent = 'Saving…';
    try {
      await saveWorkingSet(allChanges, allGoals);
      savedSnapshot = currentSnapshot();
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
      const serverGoals = Array.isArray(variant.goals) ? variant.goals : [];
      savedSnapshot = canon({ changes: serverChanges, goals: serverGoals });

      // A working set left over from a reload-and-replay (an in-progress,
      // not-yet-saved edit) takes precedence over what's on the server.
      const persisted = readPersistedWorkingSet();
      allChanges = persisted ? persisted.changes : serverChanges;
      allGoals = persisted && persisted.goals !== null ? persisted.goals : serverGoals;

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
      banner.textContent = `pivitlab editor couldn't start: ${err.message}`;
      document.body.appendChild(banner);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
