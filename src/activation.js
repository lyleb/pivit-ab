// When a test starts. page_load is today's behaviour: the address matches,
// and the optional element_selector still waits about four seconds.
// element waits for a CSS selector for the whole visit. The visitor is
// counted only after that element is on the page.
//
// The two are different questions. element_selector asks whether this page
// should run the test at all. activation asks when the counting starts.
// A test that leaves activation on page_load is unchanged.

const { normaliseElementSelector } = require('./element-selector');

const ACTIVATION_TYPES = ['page_load', 'element'];

function normaliseActivation(type, value) {
  if (type == null || type === '' || type === 'page_load') {
    return { ok: true, type: 'page_load', value: null };
  }
  if (type !== 'element') {
    return { ok: false, error: 'Start the test when the page loads, or when an element appears.' };
  }
  const element = normaliseElementSelector(value);
  if (!element.ok) {
    if (element.error && element.error.indexOf('too long') !== -1) {
      return { ok: false, error: 'That selector is too long.' };
    }
    return { ok: false, error: 'Enter a CSS selector, for example #step-payment.' };
  }
  if (!element.selector) {
    return { ok: false, error: 'Enter the CSS selector for the element that starts the test.' };
  }
  return { ok: true, type: 'element', value: element.selector };
}

module.exports = {
  ACTIVATION_TYPES,
  normaliseActivation,
};
