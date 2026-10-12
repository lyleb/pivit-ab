// Loads the Cloudflare Turnstile script only when pivitlab says it is on.
// Both keys have to be set on the server. Otherwise this file does nothing
// and the Cloudflare script is never requested.
(function () {
  window.pivitTurnstileToken = function () { return ''; };

  function mount(siteKey) {
    var slot = document.getElementById('turnstile-slot');
    if (!slot || !window.turnstile || !siteKey) return;
    window.turnstile.render(slot, {
      sitekey: siteKey,
      callback: function (token) {
        window.pivitTurnstileToken = function () { return token || ''; };
      },
    });
  }

  fetch('/api/auth/turnstile', { credentials: 'same-origin' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || data.enabled !== true || !data.siteKey) return;
      var script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.onload = function () { mount(data.siteKey); };
      document.head.appendChild(script);
    })
    .catch(function () {});
})();
