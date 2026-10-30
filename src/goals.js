// Experiment-level goals.
//
// A goal's id is the string stored on events.goal_id. Renaming the display
// name must not change it, or the results split in two. Goals that already
// exist keep the id their events already use (the old label, or the selector
// / url when no label was set).
//
// Migration lifts identical per-variant goals to the experiment, including
// the case where only one variant has the goal (Control then shows 0% until
// new traffic arrives — past events are not rewritten). Lists that genuinely
// differ stay on the variants and are flagged.

const crypto = require('crypto');
const db = require('./db');
const { MATCH_TYPES, isSafeRegex } = require('../public/url-match');
const { normaliseElementSelector } = require('./element-selector');

const MAX_VARIANTS = 3;
const GENERATED_ID = /^g_[a-z0-9]{8,32}$/;
// Keep this in step with snippet/ab.js. An event name is what the page
// passes to pivit.track, and what a dataLayer object puts in event.
// experience_impression is the Send to GA4 event, so it cannot be a goal.
// Optional when conditions live on the same goal JSON. Every one has to
// match. Keys use letters, digits, and _ - . Values are text, max 100.
const CUSTOM_EVENT_MAX = 64;
const CUSTOM_EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_CUSTOM_EVENT = 'experience_impression';
const CUSTOM_WHEN_MAX = 3;
const CUSTOM_KEY_MAX = 64;
const CUSTOM_VALUE_MAX = 100;
const CUSTOM_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
// Optional funnel order on the goal JSON. No new column: a goal with no
// step is unchanged. Steps are 1 to 5, unique, and 1..n with no gaps.
const MAX_FUNNEL_STEPS = 5;

function parseGoalStep(value) {
  if (value == null || value === '' || value === false) return { step: null };
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[1-5]$/.test(value.trim())) n = Number(value.trim());
  else return { error: 'a funnel step must be a whole number from 1 to 5' };
  if (!Number.isInteger(n) || n < 1 || n > MAX_FUNNEL_STEPS) {
    return { error: 'a funnel step must be a whole number from 1 to 5' };
  }
  return { step: n };
}

// null when no goal is a step. Otherwise an error string.
function funnelStepError(goals) {
  if (!Array.isArray(goals)) return null;
  const steps = [];
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') continue;
    const parsed = parseGoalStep(goal.step);
    if (parsed.error) return parsed.error;
    if (parsed.step != null) steps.push(parsed.step);
  }
  if (steps.length > MAX_FUNNEL_STEPS) return 'a test can have at most 5 funnel steps';
  steps.sort((a, b) => a - b);
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i] === steps[i - 1]) return 'two goals use the same funnel step';
    if (steps[i] !== i + 1) return 'funnel steps start at 1 and run in order, with no gaps';
  }
  return null;
}

function normaliseCustomEventName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name.length > CUSTOM_EVENT_MAX) return '';
  if (name === RESERVED_CUSTOM_EVENT) return '';
  if (!CUSTOM_EVENT_PATTERN.test(name)) return '';
  return name;
}

function customEventError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'a custom goal needs an event name';
  const name = value.trim();
  if (name.length > CUSTOM_EVENT_MAX) return 'an event name is too long';
  if (name === RESERVED_CUSTOM_EVENT) return 'experience_impression is used by Send to GA4. Choose another event name.';
  if (!CUSTOM_EVENT_PATTERN.test(name)) return 'an event name can use letters, digits, and _ - .';
  return null;
}

function customWhenValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function customWhenParts(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { error: 'each condition needs a key and a value' };
  }
  const key = typeof item.key === 'string' ? item.key.trim() : '';
  const value = customWhenValue(item.value);
  if (value == null) return { error: 'a condition value must be text' };
  if (!key && !value) return { empty: true };
  if (!key) return { error: 'a condition needs a key' };
  if (!value) return { error: 'a condition needs a value' };
  if (key.length > CUSTOM_KEY_MAX) return { error: 'a condition key is too long' };
  if (!CUSTOM_KEY_PATTERN.test(key)) return { error: 'a condition key can use letters, digits, and _ - .' };
  if (value.length > CUSTOM_VALUE_MAX) return { error: 'a condition value is too long' };
  return { key: key, value: value };
}

// null when means "no conditions". An error is a problem to show the user.
// Empty rows are skipped. The stored list keeps the order they were typed.
function parseCustomWhen(when) {
  if (when == null) return { when: [] };
  if (!Array.isArray(when)) return { error: 'conditions must be a list' };
  if (when.length > CUSTOM_WHEN_MAX) return { error: 'a custom goal can have at most 3 conditions' };
  const out = [];
  const seen = new Set();
  for (const item of when) {
    const parsed = customWhenParts(item);
    if (parsed.error) return { error: parsed.error };
    if (parsed.empty) continue;
    if (seen.has(parsed.key)) return { error: 'two conditions use the same key' };
    seen.add(parsed.key);
    out.push({ key: parsed.key, value: parsed.value });
  }
  return { when: out };
}

function customWhenError(when) {
  const parsed = parseCustomWhen(when);
  return parsed.error || null;
}

function variantCapError() {
  return 'A test can have at most 3 variants, including Control.';
}

function variantAdditionAllowed(currentCount) {
  return Number(currentCount) < MAX_VARIANTS;
}

function asGoalList(value) {
  return Array.isArray(value) ? value : [];
}

// The id events already store. Do not invent a new one for a goal that has
// already been counted.
function eventGoalId(goal) {
  if (!goal || typeof goal !== 'object') return '';
  if (goal.id) return String(goal.id);
  const type = goal.type || 'click';
  if (type === 'url') return goal.url_match || '';
  if (type === 'custom' || type === 'revenue') return goal.event || '';
  return goal.selector || '';
}

function normaliseLegacyGoal(goal) {
  const type = goal.type || 'click';
  const id = eventGoalId(goal);
  const name = (goal.name && String(goal.name).trim()) || (goal.id ? String(goal.id) : id);
  const base = { id: id, name: name, type: type };
  if (goal.primary) base.primary = true;
  const parsedStep = parseGoalStep(goal.step);
  if (!parsedStep.error && parsedStep.step != null) base.step = parsedStep.step;
  if (type === 'url') {
    base.url_match = goal.url_match || '';
    base.match = goal.match || 'contains';
    return base;
  }
  if (type === 'click' || type === 'element') {
    base.type = type === 'element' ? 'element' : 'click';
    base.selector = goal.selector || '';
    return base;
  }
  if (type === 'custom') {
    base.event = typeof goal.event === 'string' ? goal.event.trim() : '';
    const parsed = parseCustomWhen(goal.when);
    if (!parsed.error && parsed.when.length) base.when = parsed.when;
    return base;
  }
  const copy = Object.assign({}, goal, base);
  return copy;
}

// Identity ignores the display name and the primary flag. Two variants that
// describe the same trigger with the same event id are the same goal.
function goalIdentity(goal) {
  const type = goal.type || 'click';
  const id = goal.id || '';
  if (type === 'url') return ['url', id, goal.url_match || '', goal.match || 'contains'].join('\0');
  if (type === 'click') return ['click', id, goal.selector || ''].join('\0');
  if (type === 'element') return ['element', id, goal.selector || ''].join('\0');
  if (type === 'custom') {
    const parsed = parseCustomWhen(goal.when);
    const when = (parsed.when || []).map((item) => item.key + '=' + item.value).sort().join('\u0001');
    return ['custom', id, goal.event || '', when].join('\0');
  }
  return [type, id, goal.selector || '', goal.url_match || '', goal.event || ''].join('\0');
}

function signature(goals) {
  return goals.map(goalIdentity).sort().join('\n');
}

function planGoalMigration(variants) {
  const lists = (variants || []).map((variant) => asGoalList(variant.goals).map(normaliseLegacyGoal).filter((goal) => goal.id));
  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length === 0) return { scope: 'shared', goals: [] };

  const signatures = new Set(nonEmpty.map(signature));
  if (signatures.size > 1) return { scope: 'divergent', goals: [] };

  const merged = [];
  const byId = new Map();
  nonEmpty.forEach((list) => {
    list.forEach((goal) => {
      const existing = byId.get(goal.id);
      if (existing) {
        if (goal.primary) existing.primary = true;
        // Step is not part of the goal's identity. The first list that
        // names one wins; a later list can fill it in if the first did not.
        if (existing.step == null && goal.step != null) existing.step = goal.step;
        return;
      }
      const copy = Object.assign({}, goal);
      byId.set(goal.id, copy);
      merged.push(copy);
    });
  });
  return { scope: 'shared', goals: merged };
}

function generateGoalId() {
  return 'g_' + crypto.randomBytes(8).toString('hex');
}

function defaultGoalName(type) {
  if (type === 'url') return 'Visited URL';
  if (type === 'element') return 'Element appears';
  if (type === 'custom') return 'Custom event';
  return 'Click';
}

function storedSelector(value) {
  const element = normaliseElementSelector(value);
  if (element.ok && element.selector) return element.selector;
  return String(value || '').trim();
}

function prepareGoalsForSave(incoming, existingGoals) {
  const existingById = new Map();
  asGoalList(existingGoals).forEach((goal) => {
    const normalised = normaliseLegacyGoal(goal);
    if (normalised.id) existingById.set(normalised.id, normalised);
  });

  const used = new Set();
  const out = [];
  for (const raw of asGoalList(incoming)) {
    const type = raw.type === 'url' || raw.type === 'element' || raw.type === 'custom' ? raw.type : (raw.type || 'click');
    let id = typeof raw.id === 'string' ? raw.id.trim() : '';
    let name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (id && existingById.has(id)) {
      if (!name) name = existingById.get(id).name || id;
    } else if (id && GENERATED_ID.test(id)) {
      if (!name) name = defaultGoalName(type);
    } else if (id) {
      if (!name) name = id;
    } else {
      id = generateGoalId();
      if (!name) name = defaultGoalName(type);
    }
    if (used.has(id)) {
      const err = new Error('two goals share the same id');
      err.status = 400;
      throw err;
    }
    used.add(id);

    const goal = { id: id, name: name, type: type === 'url' || type === 'element' || type === 'custom' ? type : (type === 'click' ? 'click' : type) };
    if (typeof raw.primary === 'boolean') {
      if (raw.primary) goal.primary = true;
    } else if (existingById.has(id) && existingById.get(id).primary) {
      goal.primary = true;
    }

    if (goal.type === 'url') {
      goal.url_match = String(raw.url_match || '').trim();
      goal.match = raw.match || 'contains';
    } else if (goal.type === 'click' || goal.type === 'element') {
      goal.selector = storedSelector(raw.selector);
    } else if (goal.type === 'custom') {
      goal.event = String(raw.event || '').trim();
      const parsed = parseCustomWhen(raw.when);
      if (parsed.error) {
        const err = new Error(parsed.error);
        err.status = 400;
        throw err;
      }
      if (parsed.when.length) goal.when = parsed.when;
    } else {
      Object.assign(goal, raw, { id: id, name: name, type: type });
    }
    const parsedStep = parseGoalStep(raw.step);
    if (parsedStep.error) {
      const err = new Error(parsedStep.error);
      err.status = 400;
      throw err;
    }
    if (parsedStep.step != null) goal.step = parsedStep.step;
    else delete goal.step;
    out.push(goal);
  }
  const stepError = funnelStepError(out);
  if (stepError) {
    const err = new Error(stepError);
    err.status = 400;
    throw err;
  }
  return out;
}

function validateGoals(goals) {
  if (!Array.isArray(goals)) return 'goals must be an array';
  for (const g of goals) {
    if (!g || typeof g !== 'object') return 'each goal must be an object';
    const type = g.type || 'click';
    if (type === 'click') {
      if (typeof g.selector !== 'string' || !g.selector.trim()) return 'a click goal needs a selector';
      if (g.selector.length > 500) return 'a selector is too long';
    } else if (type === 'url') {
      if (typeof g.url_match !== 'string' || !g.url_match.trim()) return 'a url goal needs a url_match';
      if (g.url_match.length > 500) return 'a url pattern is too long';
      const match = g.match || 'contains';
      if (!MATCH_TYPES.includes(match)) return 'match must be contains, exact, starts_with, or regex';
      if (match === 'regex' && !isSafeRegex(g.url_match.trim())) return 'that regular expression is not safe to run';
    } else if (type === 'element') {
      if (typeof g.selector !== 'string' || !g.selector.trim()) return 'an element goal needs a selector';
      const element = normaliseElementSelector(g.selector);
      if (!element.ok || !element.selector) {
        if (element.error && element.error.indexOf('too long') !== -1) return 'a selector is too long';
        return 'an element goal needs a CSS selector';
      }
    } else if (type === 'custom') {
      const eventError = customEventError(g.event);
      if (eventError) return eventError;
      const whenError = customWhenError(g.when);
      if (whenError) return whenError;
    } else {
      return `unknown goal type "${type}"`;
    }
    if (g.id !== undefined && g.id !== null && g.id !== '') {
      if (typeof g.id !== 'string' || g.id.length > 100) return 'a goal id must be a string of 100 characters or fewer';
    }
    if (g.name !== undefined && g.name !== null && String(g.name).length > 120) {
      return 'a goal name must be 120 characters or fewer';
    }
  }
  return funnelStepError(goals);
}

// Writes goals. A shared experiment (and an explicit unify) stores one list
// on the experiment and copies it onto every variant, so an older snippet
// that still reads variant.goals keeps firing the same goals. A divergent
// experiment keeps the per-variant lists unless unify is set.
async function persistGoals(query, { experimentId, variantId, goals, unify = false, accountId } = {}) {
  const params = [experimentId];
  let accountSql = '';
  if (accountId) {
    params.push(accountId);
    accountSql = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT goals, goals_scope FROM experiments WHERE id = $1${accountSql}`,
    params
  );
  if (rows.length === 0) {
    const err = new Error('no experiment found with that id');
    err.status = 404;
    throw err;
  }
  const scope = rows[0].goals_scope || 'shared';
  if (scope === 'divergent' && !unify) {
    if (!variantId) {
      const err = new Error('these variants do not share the same goals');
      err.status = 409;
      throw err;
    }
    const variant = await query(
      `SELECT goals FROM variants WHERE id = $1 AND experiment_id = $2`,
      [variantId, experimentId]
    );
    if (variant.rows.length === 0) {
      const err = new Error('no variant found with that id on that experiment');
      err.status = 404;
      throw err;
    }
    const prepared = prepareGoalsForSave(goals, variant.rows[0].goals || []);
    await query(`UPDATE variants SET goals = $1::jsonb WHERE id = $2`, [JSON.stringify(prepared), variantId]);
    return { goals: prepared, goals_scope: 'divergent' };
  }

  const variantGoals = await query(`SELECT goals FROM variants WHERE experiment_id = $1`, [experimentId]);
  const prior = asGoalList(rows[0].goals).slice();
  variantGoals.rows.forEach((row) => prior.push(...asGoalList(row.goals)));
  const prepared = prepareGoalsForSave(goals, prior);
  const payload = JSON.stringify(prepared);
  const updateParams = [payload, experimentId];
  let updateAccount = '';
  if (accountId) {
    updateParams.push(accountId);
    updateAccount = ` AND account_id = $${updateParams.length}`;
  }
  await query(
    `UPDATE experiments SET goals = $1::jsonb, goals_scope = 'shared', goals_migrated = true WHERE id = $2${updateAccount}`,
    updateParams
  );
  await query(`UPDATE variants SET goals = $1::jsonb WHERE experiment_id = $2`, [payload, experimentId]);
  return { goals: prepared, goals_scope: 'shared' };
}

async function migrateExperiment(query, experimentId) {
  const { rows: variants } = await query(
    `SELECT id, goals FROM variants WHERE experiment_id = $1 ORDER BY created_at, id`,
    [experimentId]
  );
  const plan = planGoalMigration(variants);
  if (plan.scope === 'divergent') {
    await query(
      `UPDATE experiments
       SET goals = '[]'::jsonb, goals_scope = 'divergent', goals_migrated = true
       WHERE id = $1 AND goals_migrated = false`,
      [experimentId]
    );
    return plan;
  }
  const payload = JSON.stringify(plan.goals);
  const updated = await query(
    `UPDATE experiments
     SET goals = $1::jsonb, goals_scope = 'shared', goals_migrated = true
     WHERE id = $2 AND goals_migrated = false
     RETURNING id`,
    [payload, experimentId]
  );
  if (updated.rows.length === 0) return plan;
  await query(`UPDATE variants SET goals = $1::jsonb WHERE experiment_id = $2`, [payload, experimentId]);
  return plan;
}

// Idempotent. Experiments created by the new API insert goals_migrated = true
// and are skipped. A failure must not stop the process — variant goals still
// count until a later boot succeeds.
async function backfillExperimentGoals(query = db.query.bind(db)) {
  const { rows } = await query(
    `SELECT id FROM experiments WHERE goals_migrated = false ORDER BY created_at`
  );
  for (const row of rows) {
    await migrateExperiment(query, row.id);
  }
  return rows.length;
}

module.exports = {
  MAX_VARIANTS,
  MAX_FUNNEL_STEPS,
  parseGoalStep,
  funnelStepError,
  GENERATED_ID,
  CUSTOM_EVENT_MAX,
  CUSTOM_WHEN_MAX,
  CUSTOM_VALUE_MAX,
  RESERVED_CUSTOM_EVENT,
  normaliseCustomEventName,
  parseCustomWhen,
  variantCapError,
  variantAdditionAllowed,
  eventGoalId,
  normaliseLegacyGoal,
  goalIdentity,
  planGoalMigration,
  generateGoalId,
  prepareGoalsForSave,
  validateGoals,
  persistGoals,
  migrateExperiment,
  backfillExperimentGoals,
};
