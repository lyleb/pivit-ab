// When a test starts. page_load is today's behaviour: the address matches,
// and the optional element_selector still waits about four seconds.
// element waits for a CSS selector for the whole visit. The visitor is
// counted only after that element is on the page.
// js_condition waits until an expression the owner wrote is true.
// manual waits until the page calls pivit.activate with this test's key.
//
// page_load, js_condition and manual still honour element_selector. An
// element start uses activation_value only. A leftover element_selector is
// cleared when that start is saved, and the snippet ignores it if it is
// still stored, so a stale selector cannot block the test. A test that
// leaves activation on page_load is unchanged.

const { normaliseElementSelector } = require('./element-selector');

const ACTIVATION_TYPES = ['page_load', 'element', 'js_condition', 'manual'];
const JS_CONDITION_MAX = 500;

// The same people who can save page JavaScript. A signed-in Owner or Member
// has session role owner. The legacy owner password does too. A Viewer does
// not. View as is read-only and is refused before a write.
function canSetJsCondition(account) {
  return !!(account && account.role === 'owner' && account.readOnly !== true);
}

const JS_CONDITION_DENIED = 'Only someone who can write page JavaScript can set or change a JavaScript condition.';

function normaliseJsCondition(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Enter the JavaScript condition that starts the test.' };
  }
  const text = value.trim();
  if (!text) return { ok: false, error: 'Enter the JavaScript condition that starts the test.' };
  if (text.length > JS_CONDITION_MAX) return { ok: false, error: 'That condition is too long.' };
  if (/[\u0000-\u001f]/.test(text)) {
    return { ok: false, error: 'Enter one JavaScript expression, for example window.checkout && checkout.step === 3.' };
  }
  return { ok: true, type: 'js_condition', value: text };
}

function normaliseActivation(type, value) {
  if (type == null || type === '' || type === 'page_load') {
    return { ok: true, type: 'page_load', value: null };
  }
  if (type === 'manual') return { ok: true, type: 'manual', value: null };
  if (type === 'js_condition') return normaliseJsCondition(value);
  if (type !== 'element') {
    return {
      ok: false,
      error: 'Start the test when the page loads, when an element appears, when a JavaScript condition is true, or when the page calls pivit.activate.',
    };
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

// Empty when this save may proceed. A JavaScript condition can be set or
// changed only by someone who can write page JavaScript. Saving the same
// condition again is allowed, so another setting on the page can still be saved.
function jsConditionChangeError(account, previousType, previousValue, next) {
  const will = next && next.type === 'js_condition';
  const was = previousType === 'js_condition';
  if (!was && !will) return '';
  const prev = typeof previousValue === 'string' ? previousValue : null;
  if (was && will && prev === next.value) return '';
  if (canSetJsCondition(account)) return '';
  return JS_CONDITION_DENIED;
}

module.exports = {
  ACTIVATION_TYPES,
  JS_CONDITION_MAX,
  JS_CONDITION_DENIED,
  canSetJsCondition,
  normaliseActivation,
  jsConditionChangeError,
};
