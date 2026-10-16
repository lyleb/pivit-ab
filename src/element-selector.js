// Optional CSS selector that must be on the page before a visitor is bucketed.
// Empty means the URL rule is the only gate. The snippet does the lookup;
// this only stores a single selector the owner typed.

const MAX_SELECTOR = 500;

function normaliseElementSelector(value) {
  if (value == null || value === '') return { ok: true, selector: null };
  if (typeof value !== 'string') return { ok: false, error: 'element_selector must be a CSS selector' };
  const text = value.trim();
  if (!text) return { ok: true, selector: null };
  if (text.length > MAX_SELECTOR) return { ok: false, error: 'element_selector is too long' };
  // A style block or a scrap of HTML is not a selector. querySelector would
  // throw, and the snippet would then never run the test.
  if (/[{}<>]/.test(text) || /[\u0000-\u001f]/.test(text)) {
    return { ok: false, error: 'element_selector must be a CSS selector' };
  }
  return { ok: true, selector: text };
}

module.exports = {
  MAX_SELECTOR,
  normaliseElementSelector,
};
