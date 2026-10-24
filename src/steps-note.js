// A short reminder of how to reach the screen a variant was edited on.
// "Click Continue twice" is the sort of note. It is text, not a DOM change,
// so it does not belong in the changes list. 280 characters is enough for
// a sentence and short enough to sit in the editor and in a preview.

const STEPS_NOTE_MAX = 280;

function normaliseStepsNote(value) {
  if (value === undefined) return { ok: true, omitted: true, value: '' };
  if (value === null) return { ok: true, omitted: false, value: '' };
  if (typeof value !== 'string') return { ok: false, error: 'The steps note has to be text.' };
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length > STEPS_NOTE_MAX) {
    return { ok: false, error: 'The steps note has to be 280 characters or fewer.' };
  }
  return { ok: true, omitted: false, value: clean };
}

module.exports = { STEPS_NOTE_MAX, normaliseStepsNote };
