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

  const api = { DEVICES, deviceName, frameUrl, deviceFromHref, boot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function style(el, props) {
    Object.keys(props).forEach((key) => { el.style[key] = props[key]; });
  }

  function boot(doc, href, hooks) {
    const options = hooks || {};
    const history = options.history || (root && root.history);
    let current = deviceFromHref(href) || 'desktop';
    let generation = 0;
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
    note.textContent = 'This frame runs the saved variant, including whole-page CSS and JavaScript, the same way the live snippet does. Switching device or refreshing loads the page again, so a change that runs once on load runs again.';
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

    function show(name) {
      current = deviceName(name) || 'desktop';
      const spec = DEVICES[current];
      generation += 1;
      bezel.textContent = '';
      const pad = current === 'desktop' ? 10 : 14;
      style(bezel, {
        background: '#131723',
        padding: pad + 'px',
        borderRadius: current === 'desktop' ? '12px' : '28px',
        boxShadow: '0 16px 40px rgba(19,23,35,0.18)',
      });
      const frame = doc.createElement('iframe');
      frame.title = spec.label + ' preview';
      frame.setAttribute('data-pivit-frame', String(generation));
      // No sandbox attribute. A sandbox without allow-scripts would show the
      // HTML and CSS and skip the variant's JavaScript.
      frame.src = frameUrl(href);
      style(frame, {
        display: 'block',
        width: spec.width + 'px',
        height: spec.height + 'px',
        border: '0',
        background: '#fff',
        borderRadius: current === 'desktop' ? '6px' : '18px',
      });
      frame.addEventListener('load', () => {
        let framed = false;
        try { framed = !!(frame.contentDocument && frame.contentDocument.documentElement); }
        catch (err) { framed = false; }
        if (framed || !frame.parentElement) return;
        const fail = doc.createElement('div');
        style(fail, {
          width: spec.width + 'px',
          maxWidth: '100%',
          background: '#fff',
          color: '#131723',
          padding: '24px',
          borderRadius: '12px',
          fontSize: '14px',
          lineHeight: '1.45',
        });
        fail.appendChild(doc.createTextNode('This page cannot be shown in a frame. '));
        const link = doc.createElement('a');
        link.href = frame.src;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open the preview in a tab';
        style(link, { color: '#4527d6', fontWeight: '650' });
        fail.appendChild(link);
        frame.parentElement.replaceChild(fail, frame);
      });
      bezel.appendChild(frame);
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
