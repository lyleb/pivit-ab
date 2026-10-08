// Runs the conversion and host-hit SQL against Postgres when one is reachable.
// Skips (exit 0) when it is not, so `npm test` still passes without a database.
const assert = require('assert');
const { Client } = require('pg');

// Local socket only. Never reads DATABASE_URL, so this cannot run against Railway.
// Peer auth on /var/run/postgresql; TCP to 127.0.0.1 requires a password this script does not have.
function localUrl(database) {
  return `postgres://ubuntu@/${database}?host=/var/run/postgresql`;
}

const connectionString = localUrl('postgres');

async function main() {
  const admin = new Client({ connectionString });
  try {
    await admin.connect();
  } catch (err) {
    console.log('metrics-db tests skipped:', err.message);
    return;
  }

  const dbName = 'pivit_metrics_' + Date.now().toString(36);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = localUrl(dbName);
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';

  const db = require('../src/db');
  const metrics = require('../src/metrics');
  const hits = require('../src/host-hits');
  const goals = require('../src/goals');
  const drops = require('../src/event-drops');

  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query(`
      CREATE TABLE experiments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        url_match TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        goals JSONB NOT NULL DEFAULT '[]',
        goals_scope TEXT NOT NULL DEFAULT 'shared',
        goals_migrated BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        traffic_split INTEGER NOT NULL DEFAULT 50,
        changes JSONB NOT NULL DEFAULT '[]',
        goals JSONB NOT NULL DEFAULT '[]',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE events (
        id BIGSERIAL PRIMARY KEY,
        experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
        visitor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        goal_id TEXT,
        is_test BOOLEAN NOT NULL DEFAULT false,
        excluded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE host_hits (
        day DATE NOT NULL,
        host TEXT NOT NULL,
        referrer_origin TEXT NOT NULL DEFAULT '',
        hit_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, host, referrer_origin)
      );
      CREATE TABLE event_drops (
        day DATE NOT NULL,
        experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        drop_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, experiment_id, reason)
      );
    `);

    const exp = await db.query(
      `INSERT INTO experiments (name, url_match, status) VALUES ('Repeat clicks', '/pricing', 'running') RETURNING id`
    );
    const experimentId = exp.rows[0].id;
    const control = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'Control', 50, $2::jsonb) RETURNING id`,
      [experimentId, JSON.stringify([{ type: 'click', selector: '.a', id: 'cta' }, { type: 'url', url_match: '/thanks', id: 'thanks' }])]
    );
    const challenger = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'B', 50, $2::jsonb) RETURNING id`,
      [experimentId, JSON.stringify([{ type: 'click', selector: '.a', id: 'cta', primary: true }, { type: 'url', url_match: '/thanks', id: 'thanks' }])]
    );
    const controlId = control.rows[0].id;
    const challengerId = challenger.rows[0].id;

    async function track(variantId, visitorId, eventType, goalId, at) {
      await db.query(
        `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [experimentId, variantId, visitorId, eventType, goalId, at]
      );
    }

    await track(controlId, 'a', 'view', null, '2026-10-01T10:00:00Z');
    await track(controlId, 'a', 'convert', 'cta', '2026-10-01T10:01:00Z');
    await track(controlId, 'a', 'convert', 'cta', '2026-10-01T10:02:00Z');
    await track(controlId, 'a', 'convert', 'cta', '2026-10-01T10:03:00Z');
    await track(controlId, 'a', 'convert', 'thanks', '2026-10-02T10:00:00Z');
    await track(controlId, 'b', 'view', null, '2026-10-01T11:00:00Z');
    await track(challengerId, 'c', 'view', null, '2026-10-01T12:00:00Z');
    await track(challengerId, 'c', 'convert', 'cta', '2026-10-01T12:01:00Z');
    await track(challengerId, 'c', 'convert', 'cta', '2026-10-01T12:02:00Z');

    const { results, primaryKey } = await metrics.getVariantResults(experimentId);
    assert.strictEqual(primaryKey, 'cta');
    const controlRow = results.find((row) => row.variant_name === 'Control');
    const bRow = results.find((row) => row.variant_name === 'B');
    assert.strictEqual(controlRow.visitors, 2);
    assert.strictEqual(controlRow.conversions, 1);
    assert.strictEqual(controlRow.conversion_events, 3);
    assert.strictEqual(controlRow.conversion_rate, 50);
    assert.ok(controlRow.conversion_rate <= 100);
    assert.strictEqual(bRow.visitors, 1);
    assert.strictEqual(bRow.conversions, 1);
    assert.strictEqual(bRow.conversion_events, 2);
    assert.strictEqual(bRow.conversion_rate, 100);

    const { variantData } = await metrics.getPrimaryVariantData(experimentId);
    variantData.forEach((row) => {
      assert.ok(row.conversions <= row.visitors);
    });

    const breakdown = await metrics.getGoalBreakdown(experimentId);
    const thanks = breakdown.goals.find((goal) => goal.key === 'thanks');
    const thanksControl = thanks.variants.find((row) => row.variant_name === 'Control');
    assert.strictEqual(thanksControl.conversions, 1);
    assert.strictEqual(thanksControl.conversion_events, 1);
    assert.ok(thanksControl.conversion_rate <= 100);

    const series = await metrics.getTimeseries(experimentId);
    const controlSeries = series.filter((row) => row.variant_name === 'Control');
    controlSeries.forEach((row) => {
      assert.ok(row.conversions <= row.visitors || row.visitors === 0);
      assert.ok(row.cumulative_conversions <= row.cumulative_visitors);
      assert.ok(metrics.conversionRate(row.cumulative_visitors, row.cumulative_conversions) <= 100);
    });
    const last = controlSeries[controlSeries.length - 1];
    assert.strictEqual(last.cumulative_visitors, 2);
    assert.strictEqual(last.cumulative_conversions, 1);

    async function snapshotExperiment(id) {
      const variantResults = await metrics.getVariantResults(id);
      const breakdown = await metrics.getGoalBreakdown(id);
      const series = await metrics.getTimeseries(id);
      return { variantResults, breakdown, series };
    }

    const beforeRepeat = await snapshotExperiment(experimentId);

    // The About-test shape: the goal exists on one variant only. Control's
    // historical rate stays 0 after the goal is lifted to the experiment.
    const about = await db.query(
      `INSERT INTO experiments (name, url_match, status) VALUES ('About', '/about', 'running') RETURNING id`
    );
    const aboutId = about.rows[0].id;
    const aboutControl = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'Control', 50, '[]') RETURNING id`,
      [aboutId]
    );
    const aboutB = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'B', 50, $2::jsonb) RETURNING id`,
      [aboutId, JSON.stringify([{ type: 'url', url_match: '/about-thanks', id: 'about_thanks' }])]
    );
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id) VALUES
       ($1, $2, 'viewer', 'view', null),
       ($1, $3, 'buyer', 'view', null),
       ($1, $3, 'buyer', 'convert', 'about_thanks')`,
      [aboutId, aboutControl.rows[0].id, aboutB.rows[0].id]
    );
    const beforeAbout = await snapshotExperiment(aboutId);

    const conflict = await db.query(
      `INSERT INTO experiments (name, url_match, status) VALUES ('Conflict', '/conflict', 'running') RETURNING id`
    );
    const conflictId = conflict.rows[0].id;
    await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'Control', 50, $2::jsonb)`,
      [conflictId, JSON.stringify([{ type: 'click', selector: '.a', id: 'one' }])]
    );
    await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, goals) VALUES ($1, 'B', 50, $2::jsonb)`,
      [conflictId, JSON.stringify([{ type: 'click', selector: '.b', id: 'two' }])]
    );
    const beforeConflictGoals = await db.query(
      `SELECT name, goals FROM variants WHERE experiment_id = $1 ORDER BY name`,
      [conflictId]
    );
    const beforeConflict = await snapshotExperiment(conflictId);

    const migrated = await goals.backfillExperimentGoals(db.query.bind(db));
    assert.ok(migrated >= 3);

    assert.deepStrictEqual(await snapshotExperiment(experimentId), beforeRepeat);
    assert.deepStrictEqual(await snapshotExperiment(aboutId), beforeAbout);
    assert.deepStrictEqual(await snapshotExperiment(conflictId), beforeConflict);

    const aboutRow = await db.query(`SELECT goals, goals_scope FROM experiments WHERE id = $1`, [aboutId]);
    assert.strictEqual(aboutRow.rows[0].goals_scope, 'shared');
    assert.strictEqual(aboutRow.rows[0].goals[0].id, 'about_thanks');
    assert.strictEqual(aboutRow.rows[0].goals[0].match, 'contains');
    const aboutVariants = await db.query(`SELECT goals FROM variants WHERE experiment_id = $1`, [aboutId]);
    aboutVariants.rows.forEach((row) => {
      assert.strictEqual(row.goals[0].id, 'about_thanks');
    });
    const aboutAfter = await metrics.getVariantResults(aboutId);
    const aboutControlRow = aboutAfter.results.find((row) => row.variant_name === 'Control');
    const aboutBRow = aboutAfter.results.find((row) => row.variant_name === 'B');
    assert.strictEqual(aboutControlRow.conversions, 0);
    assert.strictEqual(aboutControlRow.conversion_rate, 0);
    assert.strictEqual(aboutBRow.conversions, 1);

    const conflictRow = await db.query(`SELECT goals_scope, goals FROM experiments WHERE id = $1`, [conflictId]);
    assert.strictEqual(conflictRow.rows[0].goals_scope, 'divergent');
    assert.deepStrictEqual(conflictRow.rows[0].goals, []);
    const conflictGoals = await db.query(
      `SELECT name, goals FROM variants WHERE experiment_id = $1 ORDER BY name`,
      [conflictId]
    );
    assert.deepStrictEqual(conflictGoals.rows, beforeConflictGoals.rows);

    // Renaming the display name leaves the counted id, and the numbers, alone.
    await db.query(
      `UPDATE experiments SET goals = $2::jsonb WHERE id = $1`,
      [aboutId, JSON.stringify([{ id: 'about_thanks', name: 'About thank-you', type: 'url', url_match: '/about-thanks', match: 'contains' }])]
    );
    const renamedAbout = await snapshotExperiment(aboutId);
    assert.strictEqual(renamedAbout.breakdown.goals[0].key, 'about_thanks');
    assert.strictEqual(renamedAbout.breakdown.goals[0].label, 'About thank-you');
    assert.deepStrictEqual(renamedAbout.variantResults, beforeAbout.variantResults);
    assert.deepStrictEqual(renamedAbout.series, beforeAbout.series);
    assert.deepStrictEqual(
      renamedAbout.breakdown.goals[0].variants,
      beforeAbout.breakdown.goals[0].variants
    );

    await drops.scheduleEventDrop(aboutId, 'bot', db.query.bind(db), new Date('2026-10-08T12:00:00Z'));
    await drops.scheduleEventDrop(aboutId, 'bot', db.query.bind(db), new Date('2026-10-08T12:05:00Z'));
    await drops.scheduleEventDrop(aboutId, 'rate_limited', db.query.bind(db), new Date('2026-10-08T13:00:00Z'));
    const dropRows = await db.query(
      `SELECT reason, drop_count FROM event_drops WHERE experiment_id = $1 ORDER BY reason`,
      [aboutId]
    );
    assert.deepStrictEqual(dropRows.rows.map((row) => [row.reason, Number(row.drop_count)]), [
      ['bot', 2],
      ['rate_limited', 1],
    ]);
    await drops.scheduleEventDrop(aboutId, 'host', () => Promise.reject(new Error('db down')));

    const room = await db.query(`SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1`, [experimentId]);
    assert.strictEqual(room.rows[0].n, 2);
    assert.strictEqual(goals.variantAdditionAllowed(room.rows[0].n), true);
    await db.query(`INSERT INTO variants (experiment_id, name, traffic_split) VALUES ($1, 'C', 0)`, [experimentId]);
    const full = await db.query(`SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1`, [experimentId]);
    assert.strictEqual(full.rows[0].n, 3);
    assert.strictEqual(goals.variantAdditionAllowed(full.rows[0].n), false);

    await hits.scheduleHostHit({
      method: 'GET',
      path: '/snippet/ab.js',
      hostname: 'pivit.click',
      headers: { origin: 'https://cantsaythat.co.uk' },
      get(name) { return this.headers[name]; },
    }, db.query.bind(db), new Date('2026-10-07T12:00:00Z'));
    await hits.scheduleHostHit({
      method: 'POST',
      path: '/api/event',
      hostname: 'pivit.click',
      headers: { origin: 'https://cantsaythat.co.uk' },
      get(name) { return this.headers[name]; },
    }, db.query.bind(db), new Date('2026-10-07T12:05:00Z'));
    const rolled = await db.query(`SELECT host, referrer_origin, hit_count FROM host_hits`);
    assert.strictEqual(rolled.rows.length, 1);
    assert.strictEqual(rolled.rows[0].host, 'pivit.click');
    assert.strictEqual(rolled.rows[0].referrer_origin, 'https://cantsaythat.co.uk');
    assert.strictEqual(Number(rolled.rows[0].hit_count), 2);

    console.log('metrics-db tests passed');
  } finally {
    await db.pool.end();
    const drop = new Client({ connectionString });
    await drop.connect();
    await drop.query(`DROP DATABASE ${dbName}`);
    await drop.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
