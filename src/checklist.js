// First-run checklist on the owner dashboard. The route supplies facts from
// the account's own rows. This module only decides which steps have ticked
// and whether the list should still be on screen.

const STEP_IDS = ['site', 'snippet', 'test', 'preview', 'started'];

function checklistFromFacts(facts) {
  const source = facts || {};
  const done = {
    site: source.hasSite === true,
    snippet: source.snippetSeen === true,
    test: source.hasTest === true,
    preview: source.previewSeen === true,
    started: source.started === true,
  };
  const steps = STEP_IDS.map((id) => ({ id, done: done[id] }));
  const complete = steps.every((step) => step.done);
  const dismissed = source.dismissed === true;
  return {
    dismissed,
    complete,
    visible: !dismissed && !complete,
    steps,
  };
}

module.exports = { STEP_IDS, checklistFromFacts };
