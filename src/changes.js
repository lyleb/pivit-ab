// Variant changes are JSON the visual editor and the API both write.
// Element HTML, CSS and JS stay the types they already use. page_css and
// page_js are the whole page, not one element. banner is one bar for the
// page (text, countdown, colours, position, sticky, optional link).

const CHANGE_TYPES = [
  'text',
  'html',
  'hide',
  'show',
  'style',
  'attr',
  'js',
  'remove',
  'duplicate',
  'insert_before',
  'insert_after',
  'replace',
  'stylesheet',
  'page_css',
  'page_js',
  'banner',
];

const ALLOWED = Object.create(null);
CHANGE_TYPES.forEach((type) => { ALLOWED[type] = true; });

// null means the list is acceptable. Callers treat an omitted list as
// "leave the stored changes alone". null is not an array; the caller decides
// whether that wipes the list or is a bad request.
function validateChanges(changes) {
  if (changes == null) return null;
  if (!Array.isArray(changes)) return 'changes must be an array';
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change || typeof change !== 'object' || Array.isArray(change)) return 'each change must be an object';
    const type = change.type;
    if (typeof type !== 'string' || !ALLOWED[type]) {
      const shown = String(type == null ? '' : type).slice(0, 40);
      return `unknown change type "${shown}"`;
    }
  }
  return null;
}

module.exports = { CHANGE_TYPES, validateChanges };
