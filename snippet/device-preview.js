/**
 * pivitlab device preview.
 *
 * Loaded by ab.js only when a preview URL includes pivit_device. Never
 * downloaded for a normal visit. The shell sits on the customer's page and
 * frames a second copy of that page with pivit_device removed. The framed
 * copy runs the live snippet, so CSS, HTML and JavaScript changes apply the
 * same way they do for a visitor, including JavaScript that runs once on load.
 *
 * Resizing a frame that is already loaded would leave that one-shot
 * JavaScript behind. Switching device or refreshing replaces the frame, which
 * loads the page again and applies the variant again.
 */
(function (root) {
  const DEVICES = {
    desktop: { label: 'Desktop', width: 1280, height: 800 },
    tablet: { label: 'Tablet', width: 768, height: 1024 },
    mobile: { label: 'Mobile', width: 390, height: 844 },
  };

  function deviceName(value) {
    const name = String(value || '').toLowerCase();
    return DEVICES[name] ? name : '';
  }

  // The framed page must not include pivit_device, or it would open another
  // shell instead of applying the variant.
  function frameUrl(href) {
    const url = new URL(href);
    url.searchParams.delete('pivit_device');
    return url.toString();
  }

  function deviceFromHref(href) {
    try {
      return deviceName(new URL(href).searchParams.get('pivit_device'));
    } catch (err) {
      return '';
    }
  }

  // Popup sizes follow the device the owner picked. Desktop is a normal tab.
  // Tablet and mobile ask the browser for a window of about that size.
  const POPUP = {
    tablet: { width: 820, height: 1180 },
    mobile: { width: 390, height: 844 },
  };
  const LOAD_TIMEOUT_MS = 8000;
  const BLOCKED_MESSAGE = "This site doesn't allow previews inside another page, so we'll open it in its own window.";

  function popupOptions(device) {
    const name = deviceName(device) || 'desktop';
    const size = POPUP[name];
    if (!size) return { device: 'desktop', target: '_blank', features: '', width: 0, height: 0 };
    return {
      device: name,
      target: 'pivitlab-preview',
      features: 'popup,width=' + size.width + ',height=' + size.height,
      width: size.width,
      height: size.height,
    };
  }

  function popupLabel(device) {
    const name = deviceName(device) || 'desktop';
    if (name === 'tablet') return 'Open tablet window';
    if (name === 'mobile') return 'Open mobile window';
    return 'Open in a tab';
  }

  function defaultPort(protocol) {
    if (protocol === 'https:') return '443';
    if (protocol === 'http:') return '80';
    return '';
  }

  function parseOrigin(value) {
    try {
      const url = new URL(value);
      return {
        origin: url.origin,
        protocol: url.protocol,
        host: url.hostname.toLowerCase(),
        port: url.port || defaultPort(url.protocol),
      };
    } catch (err) {
      return null;
    }
  }

  // frame-ancestors is ignored in <meta>. Only the enforcing header matters.
  // Report-only policies are not passed in here.
  function frameAncestorLists(csp) {
    const lists = [];
    const text = String(csp || '');
    const pattern = /(?:^|;)\s*frame-ancestors\s+([^;]*)/gi;
    let match = pattern.exec(text);
    while (match) {
      lists.push(match[1].trim());
      match = pattern.exec(text);
    }
    return lists;
  }

  function sourceMatches(token, ancestor, resourceOrigin) {
    const raw = String(token || '').trim();
    const lower = raw.toLowerCase();
    if (!raw) return false;
    if (lower === '*') return true;
    if (lower === "'self'") return ancestor.origin === resourceOrigin;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(raw)) return ancestor.protocol === lower;
    let expr = raw;
    let scheme = '';
    const schemeAt = expr.indexOf('://');
    if (schemeAt > 0) {
      scheme = expr.slice(0, schemeAt).toLowerCase() + ':';
      expr = expr.slice(schemeAt + 3);
    }
    expr = expr.split('/')[0];
    let host = expr;
    let port = '';
    const colon = expr.lastIndexOf(':');
    if (colon > 0 && expr.indexOf(']') === -1) {
      host = expr.slice(0, colon);
      port = expr.slice(colon + 1);
    }
    host = host.toLowerCase();
    if (scheme && ancestor.protocol !== scheme) return false;
    if (!scheme && ancestor.protocol !== 'http:' && ancestor.protocol !== 'https:') return false;
    if (port) {
      if (ancestor.port !== port) return false;
    } else if (ancestor.port !== defaultPort(ancestor.protocol)) {
      return false;
    }
    if (host === '*') return true;
    if (host.startsWith('*.')) {
      const suffix = host.slice(2);
      return ancestor.host === suffix || ancestor.host.endsWith('.' + suffix);
    }
    return ancestor.host === host;
  }

  function ancestorListBlocks(list, ancestorOrigin, resourceOrigin) {
    const tokens = String(list || '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    if (tokens.length === 1 && tokens[0].toLowerCase() === "'none'") return true;
    if (tokens.some((token) => token.toLowerCase() === "'none'")) return false;
    const ancestor = parseOrigin(ancestorOrigin);
    if (!ancestor) return false;
    return !tokens.some((token) => sourceMatches(token, ancestor, resourceOrigin));
  }

  function xfoBlocks(xfo, ancestorOrigin, resourceOrigin) {
    const value = String(xfo || '').split(',')[0].trim();
    if (!value) return false;
    const lower = value.toLowerCase();
    if (lower === 'deny') return true;
    if (lower === 'sameorigin') return ancestorOrigin !== resourceOrigin;
    if (lower.indexOf('allow-from') === 0) {
      const allowed = value.slice('allow-from'.length).trim();
      try { return new URL(allowed).origin !== ancestorOrigin; }
      catch (err) { return true; }
    }
    return false;
  }

  // True when the response headers would stop this page framing the resource.
  // When frame-ancestors is present, browsers ignore X-Frame-Options.
  function framingBlockedByHeaders(headers) {
    const info = headers || {};
    const ancestorOrigin = info.ancestorOrigin || '';
    const resourceOrigin = info.resourceOrigin || ancestorOrigin;
    const lists = frameAncestorLists(info.csp);
    if (lists.length) {
      return lists.some((list) => ancestorListBlocks(list, ancestorOrigin, resourceOrigin));
    }
    return xfoBlocks(info.xfo, ancestorOrigin, resourceOrigin);
  }

  function headersFromResponse(response, url) {
    if (!response || response.type === 'opaque' || response.type === 'opaqueredirect') return null;
    const get = response.headers && response.headers.get ? response.headers.get.bind(response.headers) : function () { return ''; };
    let resourceOrigin = '';
    try { resourceOrigin = new URL(response.url || url).origin; }
    catch (err) { resourceOrigin = ''; }
    return {
      csp: get('content-security-policy') || '',
      xfo: get('x-frame-options') || '',
      resourceOrigin: resourceOrigin,
    };
  }

  const api = {
    DEVICES,
    POPUP,
    LOAD_TIMEOUT_MS,
    BLOCKED_MESSAGE,
    deviceName,
    frameUrl,
    deviceFromHref,
    popupOptions,
    popupLabel,
    framingBlockedByHeaders,
    headersFromResponse,
    boot,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function style(el, props) {
    Object.keys(props).forEach((key) => { el.style[key] = props[key]; });
  }

  function boot(doc, href, hooks) {
    const options = hooks || {};
    const history = options.history || (root && root.history);
    const setTimer = options.setTimeout || (root && root.setTimeout) || setTimeout;
    const clearTimerFn = options.clearTimeout || (root && root.clearTimeout) || clearTimeout;
    let ancestorOrigin = options.origin || '';
    if (!ancestorOrigin) {
      try { ancestorOrigin = new URL(href).origin; } catch (err) { ancestorOrigin = ''; }
    }
    const headerCache = new Map();
    let current = deviceFromHref(href) || 'desktop';
    let generation = 0;
    let shownGen = 0;
    let loadTimer = 0;
    let currentFrame = null;
    const shell = ensureShell(doc);
    shell.textContent = '';
    if (doc.documentElement && doc.documentElement.style) doc.documentElement.style.overflow = 'hidden';
    style(shell, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      background: '#e8eaef',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
      color: '#131723',
      overflow: 'hidden',
    });

    const bar = doc.createElement('div');
    style(bar, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '12px 16px',
      background: '#fff',
      borderBottom: '1px solid #e6e7f0',
      flexShrink: '0',
    });

    const brand = doc.createElement('div');
    brand.textContent = 'pivitlab preview';
    style(brand, { fontWeight: '700', fontSize: '14px', marginRight: '8px' });
    bar.appendChild(brand);

    const buttons = {};
    Object.keys(DEVICES).forEach((name) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = DEVICES[name].label;
      button.setAttribute('data-device', name);
      button.addEventListener('click', () => { if (name !== current) show(name); });
      bar.appendChild(button);
      buttons[name] = button;
    });

    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    refresh.setAttribute('data-refresh', '1');
    refresh.addEventListener('click', () => show(current));
    style(refresh, { marginLeft: 'auto' });
    bar.appendChild(refresh);
    shell.appendChild(bar);

    const note = doc.createElement('p');
    note.textContent = 'This frame runs the saved variant, including a banner and whole-page CSS and JavaScript, the same way the live snippet does. Switching device or refreshing loads the page again, so a change that runs once on load runs again.';
    style(note, {
      margin: '0',
      padding: '8px 16px',
      fontSize: '12px',
      lineHeight: '1.4',
      color: '#3f4558',
      background: '#f4f6fb',
      flexShrink: '0',
    });
    shell.appendChild(note);

    const stage = doc.createElement('div');
    style(stage, {
      flex: '1',
      overflow: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '24px 16px 32px',
    });
    const bezel = doc.createElement('div');
    bezel.setAttribute('data-bezel', '1');
    stage.appendChild(bezel);
    shell.appendChild(stage);

    const caption = doc.createElement('div');
    caption.setAttribute('data-caption', '1');
    style(caption, {
      textAlign: 'center',
      fontSize: '12px',
      color: '#5c6378',
      padding: '0 16px 16px',
      flexShrink: '0',
    });
    shell.appendChild(caption);

    function paintButtons() {
      Object.keys(buttons).forEach((name) => {
        const active = name === current;
        buttons[name].setAttribute('aria-pressed', active ? 'true' : 'false');
        style(buttons[name], {
          border: '0',
          borderRadius: '8px',
          padding: '8px 12px',
          fontWeight: '650',
          fontSize: '13px',
          cursor: 'pointer',
          background: active ? '#5635FB' : '#f0f0f7',
          color: active ? '#fff' : '#131723',
        });
      });
      style(refresh, {
        border: '0',
        borderRadius: '8px',
        padding: '8px 12px',
        fontWeight: '650',
        fontSize: '13px',
        cursor: 'pointer',
        background: '#f0f0f7',
        color: '#131723',
      });
    }

    function childWith(parent, attr, value) {
      const kids = parent && parent.children ? parent.children : [];
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.getAttribute && child.getAttribute(attr) === value) return child;
      }
      return null;
    }

    function stopLoadTimer() {
      if (!loadTimer) return;
      clearTimerFn(loadTimer);
      loadTimer = 0;
    }

    // shown: the frame has a real document, so the site allows framing.
    // blocked: the browser left a blank or error document.
    // opaque: Chrome hides both a blocked frame and a cross-origin frame.
    function readFrame(frame) {
      try {
        const framed = frame.contentDocument;
        if (!framed || !framed.documentElement) return 'opaque';
        const url = framed.URL || (framed.location && framed.location.href) || '';
        if (!url || url === 'about:blank' || url.indexOf('chrome-error:') === 0) return 'blocked';
        return 'shown';
      } catch (err) {
        return 'shown';
      }
    }

    function revealFrame(frame, gen) {
      if (gen !== generation || !frame.parentElement) return;
      shownGen = gen;
      stopLoadTimer();
      const fail = childWith(bezel, 'data-frame-fallback', '1');
      if (fail && fail.parentElement) fail.parentElement.removeChild(fail);
      style(frame, { display: 'block' });
    }

    function openPreview(device, previewUrl) {
      const choice = popupOptions(device);
      const opener = options.open || (root && typeof root.open === 'function' ? root.open.bind(root) : null);
      if (!opener) return;
      let win = null;
      try {
        win = choice.features ? opener(previewUrl, choice.target, choice.features) : opener(previewUrl, choice.target);
      } catch (err) {
        return;
      }
      // Some browsers open a normal window and ignore width/height features.
      // Resize while we can still reach the window, before dropping opener.
      if (win && choice.width && typeof win.resizeTo === 'function') {
        try {
          const width = Number(win.outerWidth);
          const height = Number(win.outerHeight);
          const off = !Number.isFinite(width) || !Number.isFinite(height)
            || Math.abs(width - choice.width) > 80
            || Math.abs(height - choice.height) > 80;
          if (off) win.resizeTo(choice.width, choice.height);
        } catch (err) { /* the features string is still the request */ }
      }
      try { if (win) win.opener = null; } catch (err) { /* the window can still open */ }
    }

    function presentFallback(frame, gen) {
      if (gen !== generation || shownGen === gen || !frame.parentElement) return;
      stopLoadTimer();
      if (childWith(bezel, 'data-frame-fallback', '1')) return;
      const previewUrl = frame.src;
      const spec = DEVICES[current] || DEVICES.desktop;
      style(frame, { display: 'none' });
      const fail = doc.createElement('div');
      fail.setAttribute('data-frame-fallback', '1');
      style(fail, {
        width: spec.width + 'px',
        maxWidth: '100%',
        background: '#fff',
        color: '#131723',
        padding: '24px',
        borderRadius: '12px',
        fontSize: '14px',
        lineHeight: '1.45',
        boxSizing: 'border-box',
      });
      const message = doc.createElement('p');
      message.setAttribute('data-fallback-message', '1');
      message.textContent = BLOCKED_MESSAGE;
      style(message, { margin: '0' });
      fail.appendChild(message);
      const actions = doc.createElement('div');
      style(actions, {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        marginTop: '16px',
        alignItems: 'center',
      });
      Object.keys(DEVICES).forEach((name) => {
        const choice = popupOptions(name);
        const button = doc.createElement('button');
        button.type = 'button';
        button.setAttribute('data-open-window', name);
        if (choice.features) button.setAttribute('data-popup-features', choice.features);
        button.textContent = popupLabel(name);
        const chosen = name === current;
        style(button, {
          border: '0',
          borderRadius: '8px',
          padding: '10px 14px',
          fontWeight: '650',
          fontSize: '14px',
          cursor: 'pointer',
          background: chosen ? '#5635FB' : '#f0f0f7',
          color: chosen ? '#fff' : '#131723',
        });
        button.addEventListener('click', () => openPreview(name, previewUrl));
        actions.appendChild(button);
      });
      const link = doc.createElement('a');
      link.href = previewUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open the preview in a tab';
      style(link, {
        flexBasis: '100%',
        color: '#4527d6',
        fontWeight: '650',
        marginTop: '4px',
      });
      actions.appendChild(link);
      fail.appendChild(actions);
      frame.parentElement.appendChild(fail);
    }

    // Read the page's own framing headers. We do not proxy the page and we
    // do not remove those headers. A same-origin document we can read is
    // already on screen, so this only runs when the frame is opaque.
    function loadHeaders(url) {
      if (headerCache.has(url)) return headerCache.get(url);
      const pending = Promise.resolve().then(() => {
        if (typeof options.headersFor === 'function') return options.headersFor(url);
        const doFetch = options.fetch || (typeof fetch === 'function' ? fetch : null);
        if (!doFetch) return null;
        return Promise.resolve(doFetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' }))
          .then((response) => headersFromResponse(response, url))
          .catch(() => null);
      });
      headerCache.set(url, pending);
      return pending;
    }

    function headersBlock(info, url) {
      if (!info) {
        try { return new URL(url).origin === ancestorOrigin; }
        catch (err) { return true; }
      }
      return framingBlockedByHeaders({
        csp: info.csp,
        xfo: info.xfo,
        ancestorOrigin: ancestorOrigin,
        resourceOrigin: info.resourceOrigin || ancestorOrigin,
      });
    }

    function considerFrame(frame, gen) {
      if (gen !== generation || !frame.parentElement) return;
      const verdict = readFrame(frame);
      if (verdict === 'shown') {
        revealFrame(frame, gen);
        return;
      }
      if (verdict === 'blocked') {
        presentFallback(frame, gen);
        return;
      }
      loadHeaders(frame.src).then((info) => {
        if (gen !== generation) return;
        if (headersBlock(info, frame.src)) presentFallback(frame, gen);
        else revealFrame(frame, gen);
      }).catch(() => {
        if (gen !== generation) return;
        presentFallback(frame, gen);
      });
    }

    function violationForFrame(event, frame) {
      if (!event || !frame) return false;
      const directive = String(event.effectiveDirective || event.violatedDirective || '')
        .toLowerCase()
        .replace(/-elem$/, '');
      if (directive !== 'frame-ancestors' && directive !== 'frame-src' && directive !== 'child-src') return false;
      const blocked = event.blockedURI || '';
      if (!blocked) return directive === 'frame-ancestors';
      try {
        const src = new URL(frame.src);
        const got = new URL(blocked, src);
        return got.origin === src.origin && (directive === 'frame-ancestors' || got.pathname === src.pathname);
      } catch (err) {
        return false;
      }
    }

    function onViolation(event) {
      const frame = currentFrame;
      if (!frame || !violationForFrame(event, frame)) return;
      presentFallback(frame, generation);
    }

    if (doc.addEventListener) doc.addEventListener('securitypolicyviolation', onViolation, true);

    function show(name) {
      current = deviceName(name) || 'desktop';
      const spec = DEVICES[current];
      generation += 1;
      const gen = generation;
      shownGen = 0;
      stopLoadTimer();
      bezel.textContent = '';
      const pad = current === 'desktop' ? 10 : 14;
      style(bezel, {
        background: '#131723',
        padding: pad + 'px',
        borderRadius: current === 'desktop' ? '12px' : '28px',
        boxShadow: '0 16px 40px rgba(19,23,35,0.18)',
      });
      const frame = doc.createElement('iframe');
      currentFrame = frame;
      frame.title = spec.label + ' preview';
      frame.setAttribute('data-pivit-frame', String(gen));
      // No sandbox attribute. A sandbox without allow-scripts would show the
      // HTML and CSS and skip the variant's JavaScript.
      style(frame, {
        display: 'block',
        width: spec.width + 'px',
        height: spec.height + 'px',
        border: '0',
        background: '#fff',
        borderRadius: current === 'desktop' ? '6px' : '18px',
      });
      frame.addEventListener('load', () => considerFrame(frame, gen));
      frame.addEventListener('securitypolicyviolation', onViolation);
      frame.src = frameUrl(href);
      bezel.appendChild(frame);
      loadTimer = setTimer(() => {
        loadTimer = 0;
        if (gen !== generation || shownGen === gen) return;
        presentFallback(frame, gen);
      }, LOAD_TIMEOUT_MS);
      if (loadTimer && typeof loadTimer.unref === 'function') loadTimer.unref();
      caption.textContent = spec.label + ' · ' + spec.width + ' × ' + spec.height;
      paintButtons();
      if (history && history.replaceState) {
        try {
          const next = new URL(href);
          next.searchParams.set('pivit_device', current);
          history.replaceState(null, '', next.toString());
          href = next.toString();
        } catch (err) { /* keep the frame even if the address cannot change */ }
      }
      return frame;
    }

    show(current);
    return { show, shell };
  }

  function ensureShell(doc) {
    let shell = doc.getElementById && doc.getElementById('pivit-device-shell');
    if (shell) return shell;
    shell = doc.createElement('div');
    shell.setAttribute('id', 'pivit-device-shell');
    const parent = doc.documentElement || doc.body;
    parent.appendChild(shell);
    return shell;
  }

  if (!root || !root.document) return;
  const initialHref = root.location && root.location.href;
  if (!initialHref) return;
  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', () => boot(root.document, root.location.href, { history: root.history }));
  } else {
    boot(root.document, root.location.href, { history: root.history });
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
