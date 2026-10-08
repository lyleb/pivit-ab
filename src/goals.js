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

const MAX_VARIANTS = 3;
const GENERATED_ID = /^g_[a-z0-9]{8,32}$/;

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
  if (type === 'url') {
    base.url_match = goal.url_match || '';
    base.match = goal.match || 'contains';
    return base;
  }
  if (type === 'click') {
    base.type = 'click';
    base.selector = goal.selector || '';
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

function prepareGoalsForSave(incoming, existingGoals) {
  const existingById = new Map();
  asGoalList(existingGoals).forEach((goal) => {
    const normalised = normaliseLegacyGoal(goal);
    if (normalised.id) existingById.set(normalised.id, normalised);
  });

  const used = new Set();
  const out = [];
  for (const raw of asGoalList(incoming)) {
    const type = raw.type || 'click';
    let id = typeof raw.id === 'string' ? raw.id.trim() : '';
    let name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (id && existingById.has(id)) {
      if (!name) name = existingById.get(id).name || id;
    } else if (id && GENERATED_ID.test(id)) {
      if (!name) name = type === 'url' ? 'Visited URL' : 'Click';
    } else if (id) {
      if (!name) name = id;
    } else {
      id = generateGoalId();
      if (!name) name = type === 'url' ? 'Visited URL' : 'Click';
    }
    if (used.has(id)) {
      const err = new Error('two goals share the same id');
      err.status = 400;
      throw err;
    }
    used.add(id);

    const goal = { id: id, name: name, type: type === 'url' ? 'url' : (type === 'click' ? 'click' : type) };
    if (typeof raw.primary === 'boolean') {
      if (raw.primary) goal.primary = true;
    } else if (existingById.has(id) && existingById.get(id).primary) {
      goal.primary = true;
    }

    if (goal.type === 'url') {
      goal.url_match = String(raw.url_match || '').trim();
      goal.match = raw.match || 'contains';
    } else if (goal.type === 'click') {
      goal.selector = String(raw.selector || '').trim();
    } else {
      Object.assign(goal, raw, { id: id, name: name, type: type });
    }
    out.push(goal);
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
  return null;
}

// Writes goals. A shared experiment (and an explicit unify) stores one list
// on the experiment and copies it onto every variant, so an older snippet
// that still reads variant.goals keeps firing the same goals. A divergent
// experiment keeps the per-variant lists unless unify is set.
async function persistGoals(query, { experimentId, variantId, goals, unify = false } = {}) {
  const { rows } = await query(`SELECT goals, goals_scope FROM experiments WHERE id = $1`, [experimentId]);
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
  await query(
    `UPDATE experiments SET goals = $1::jsonb, goals_scope = 'shared', goals_migrated = true WHERE id = $2`,
    [payload, experimentId]
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
  GENERATED_ID,
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
