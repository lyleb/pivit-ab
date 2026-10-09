// Migration 001. Moves the existing single-tenant database into account #1
// ("Heclr") without changing experiment rows, client passwords, or event rows.
// The caller runs this inside a transaction and rolls back if the totals check
// fails. Re-running it after a rollback is safe. Re-running it after it has
// been recorded is the migrator's job (it will not enter this function again).

const crypto = require('crypto');
const { normaliseHost } = require('../host-scope');

const LEGACY_ACCOUNT_NAME = 'Heclr';
const SUPERADMIN_EMAIL = 'info@heclr.com';
const PRIMARY_SITE_HOST = 'cantsaythat.co.uk';

function newSiteKey() {
  return 'site_' + crypto.randomBytes(18).toString('hex');
}

function hostSet(allowedHosts) {
  const hosts = [];
  for (const entry of allowedHosts || []) {
    const host = normaliseHost(entry);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  hosts.sort();
  return hosts;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function snapshot(client) {
  const totals = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM experiments) AS experiments,
      (SELECT COUNT(*)::int FROM variants) AS variants,
      (SELECT COUNT(*)::int FROM events) AS events,
      (SELECT COUNT(*)::int FROM events WHERE is_test) AS test_events,
      (SELECT COUNT(*)::int FROM events WHERE excluded_at IS NOT NULL) AS excluded_events,
      (SELECT COUNT(*)::int FROM test_traffic_audit) AS audit_rows,
      (SELECT COUNT(*)::int FROM clients) AS clients
  `);
  const eventsByExperiment = await client.query(`
    SELECT experiment_id::text AS experiment_id,
           COUNT(*)::int AS events,
           COUNT(*) FILTER (WHERE is_test)::int AS test_events,
           COUNT(*) FILTER (WHERE excluded_at IS NOT NULL)::int AS excluded_events
    FROM events
    GROUP BY experiment_id
    ORDER BY experiment_id
  `);
  const experiments = await client.query(`
    SELECT id::text AS id, name, status, url_match, allowed_hosts, client_id::text AS client_id
    FROM experiments
    ORDER BY id
  `);
  const variants = await client.query(`
    SELECT id::text AS id, experiment_id::text AS experiment_id, name, traffic_split, enabled
    FROM variants
    ORDER BY id
  `);
  const eventRows = await client.query(`
    SELECT id::text AS id, experiment_id::text AS experiment_id, variant_id::text AS variant_id,
           visitor_id, event_type, goal_id, is_test,
           excluded_at IS NOT NULL AS excluded
    FROM events
    ORDER BY id
  `);
  const clients = await client.query(`
    SELECT id::text AS id, name, username, password_hash
    FROM clients
    ORDER BY id
  `);
  return {
    totals: totals.rows[0],
    eventsByExperiment: eventsByExperiment.rows,
    experiments: experiments.rows,
    variants: variants.rows,
    eventRows: eventRows.rows,
    clients: clients.rows,
  };
}

function mismatchLines(before, after) {
  const lines = [];
  for (const key of Object.keys(before.totals)) {
    if (Number(before.totals[key]) !== Number(after.totals[key])) {
      lines.push(`${key}: ${before.totals[key]} before, ${after.totals[key]} after`);
    }
  }
  if (!sameJson(before.eventsByExperiment, after.eventsByExperiment)) {
    lines.push('events per experiment changed');
  }
  if (!sameJson(before.experiments, after.experiments)) lines.push('experiment rows changed');
  if (!sameJson(before.variants, after.variants)) lines.push('variant rows changed');
  if (!sameJson(before.eventRows, after.eventRows)) lines.push('event rows changed');
  if (!sameJson(before.clients, after.clients)) lines.push('client logins changed');
  return lines;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      legacy BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_legacy
      ON accounts ((true))
      WHERE legacy
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      verified_at TIMESTAMPTZ,
      is_superadmin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      user_id UUID NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, user_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      domains TEXT[] NOT NULL DEFAULT '{}',
      public_key TEXT NOT NULL UNIQUE,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sites_account ON sites (account_id)`);

  await client.query(`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS site_id UUID`);
  await client.query(`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS needs_site BOOLEAN NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE variants ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE goal_templates ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE event_drops ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE test_traffic_audit ADD COLUMN IF NOT EXISTS account_id UUID`);
  await client.query(`ALTER TABLE host_hits ADD COLUMN IF NOT EXISTS account_id UUID`);
}

async function ensurePeople(client, accountId) {
  const user = await client.query(
    `INSERT INTO users (email, is_superadmin)
     VALUES ($1, true)
     ON CONFLICT (email) DO UPDATE SET is_superadmin = true
     RETURNING id`,
    [SUPERADMIN_EMAIL]
  );
  await client.query(
    `INSERT INTO memberships (account_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (account_id, user_id) DO NOTHING`,
    [accountId, user.rows[0].id]
  );
}

async function ensureSite(client, accountId, domains, name) {
  const { rows } = await client.query(
    `SELECT id, domains FROM sites WHERE account_id = $1`,
    [accountId]
  );
  const wanted = domains.join('\n');
  const found = rows.find((row) => hostSet(row.domains).join('\n') === wanted);
  if (found) return found.id;
  const inserted = await client.query(
    `INSERT INTO sites (account_id, name, domains, public_key, verified_at)
     VALUES ($1, $2, $3::text[], $4, now())
     RETURNING id`,
    [accountId, name, domains, newSiteKey()]
  );
  return inserted.rows[0].id;
}

async function attachExperiments(client, accountId) {
  await ensureSite(client, accountId, [PRIMARY_SITE_HOST], PRIMARY_SITE_HOST);
  const { rows } = await client.query(
    `SELECT id, allowed_hosts FROM experiments WHERE account_id IS NULL`
  );
  for (const row of rows) {
    const hosts = hostSet(row.allowed_hosts);
    if (hosts.length === 0) {
      await client.query(
        `UPDATE experiments
         SET account_id = $2, site_id = NULL, needs_site = true
         WHERE id = $1 AND account_id IS NULL`,
        [row.id, accountId]
      );
      continue;
    }
    const siteId = await ensureSite(client, accountId, hosts, hosts[0]);
    await client.query(
      `UPDATE experiments
       SET account_id = $2, site_id = $3, needs_site = false
       WHERE id = $1 AND account_id IS NULL`,
      [row.id, accountId, siteId]
    );
  }
}

async function backfillChildren(client, accountId) {
  await client.query(`
    UPDATE variants AS v
    SET account_id = e.account_id
    FROM experiments e
    WHERE v.experiment_id = e.id
      AND v.account_id IS NULL
  `);
  await client.query(`
    UPDATE events AS ev
    SET account_id = e.account_id
    FROM experiments e
    WHERE ev.experiment_id = e.id
      AND ev.account_id IS NULL
  `);
  await client.query(
    `UPDATE clients SET account_id = $1 WHERE account_id IS NULL`,
    [accountId]
  );
  await client.query(
    `UPDATE goal_templates SET account_id = $1 WHERE account_id IS NULL`,
    [accountId]
  );
  await client.query(`
    UPDATE event_drops AS d
    SET account_id = e.account_id
    FROM experiments e
    WHERE d.experiment_id = e.id
      AND d.account_id IS NULL
  `);
  await client.query(`
    UPDATE test_traffic_audit AS a
    SET account_id = e.account_id
    FROM experiments e
    WHERE a.experiment_id = e.id
      AND a.account_id IS NULL
  `);
  await client.query(
    `UPDATE host_hits SET account_id = $1 WHERE account_id IS NULL`,
    [accountId]
  );
}

async function tighten(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION legacy_account_id() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT id FROM accounts WHERE legacy IS TRUE ORDER BY created_at, id LIMIT 1
    $$
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION pivit_child_account_id() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.account_id IS NULL THEN
        SELECT e.account_id INTO NEW.account_id
        FROM experiments e
        WHERE e.id = NEW.experiment_id;
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS variants_account_id ON variants;
    CREATE TRIGGER variants_account_id
      BEFORE INSERT ON variants
      FOR EACH ROW EXECUTE PROCEDURE pivit_child_account_id()
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS events_account_id ON events;
    CREATE TRIGGER events_account_id
      BEFORE INSERT ON events
      FOR EACH ROW EXECUTE PROCEDURE pivit_child_account_id()
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS event_drops_account_id ON event_drops;
    CREATE TRIGGER event_drops_account_id
      BEFORE INSERT ON event_drops
      FOR EACH ROW EXECUTE PROCEDURE pivit_child_account_id()
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS test_traffic_audit_account_id ON test_traffic_audit;
    CREATE TRIGGER test_traffic_audit_account_id
      BEFORE INSERT ON test_traffic_audit
      FOR EACH ROW EXECUTE PROCEDURE pivit_child_account_id()
  `);

  await client.query(`ALTER TABLE experiments ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE variants ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE events ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE clients ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE goal_templates ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE event_drops ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE test_traffic_audit ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE host_hits ALTER COLUMN account_id SET NOT NULL`);
  await client.query(`ALTER TABLE host_hits ALTER COLUMN account_id SET DEFAULT legacy_account_id()`);

  await addFk(client, 'experiments', 'experiments_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'experiments', 'experiments_site_id_fkey', 'site_id', 'sites');
  await addFk(client, 'variants', 'variants_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'events', 'events_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'clients', 'clients_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'goal_templates', 'goal_templates_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'event_drops', 'event_drops_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'test_traffic_audit', 'test_traffic_audit_account_id_fkey', 'account_id', 'accounts');
  await addFk(client, 'host_hits', 'host_hits_account_id_fkey', 'account_id', 'accounts');

  await client.query(`CREATE INDEX IF NOT EXISTS idx_experiments_account ON experiments (account_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_experiments_site ON experiments (site_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_variants_account ON variants (account_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_account ON events (account_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_clients_account ON clients (account_id)`);

  await client.query(`
    ALTER TABLE goal_templates DROP CONSTRAINT IF EXISTS goal_templates_type_value_label_key
  `);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE goal_templates
        ADD CONSTRAINT goal_templates_account_goal_key UNIQUE (account_id, type, value, label);
    EXCEPTION
      WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$
  `);
}

async function addFk(client, table, name, column, ref) {
  await client.query(
    `DO $$ BEGIN
       ALTER TABLE ${table}
         ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${ref}(id);
     EXCEPTION
       WHEN duplicate_object OR duplicate_table THEN NULL;
     END $$`
  );
}

async function applyTenancy(client) {
  const before = await snapshot(client);
  await ensureSchema(client);
  // The partial unique index is not an INSERT conflict target. Insert if missing.
  let accountId;
  const existing = await client.query(
    `SELECT id FROM accounts WHERE legacy IS TRUE ORDER BY created_at, id LIMIT 1`
  );
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    await client.query(
      `UPDATE accounts SET name = $2 WHERE id = $1 AND name IS DISTINCT FROM $2`,
      [accountId, LEGACY_ACCOUNT_NAME]
    );
  } else {
    const created = await client.query(
      `INSERT INTO accounts (name, legacy) VALUES ($1, true) RETURNING id`,
      [LEGACY_ACCOUNT_NAME]
    );
    accountId = created.rows[0].id;
  }
  await ensurePeople(client, accountId);
  await attachExperiments(client, accountId);
  await backfillChildren(client, accountId);
  await tighten(client);

  let after = await snapshot(client);
  if (process.env.NODE_ENV === 'test' && process.env.PIVIT_TENANCY_FAULT === 'totals') {
    after = JSON.parse(JSON.stringify(after));
    after.totals.experiments = Number(after.totals.experiments) + 1;
  }
  const lines = mismatchLines(before, after);
  if (lines.length) {
    const err = new Error(
      'Tenancy migration totals did not match, so nothing was kept. ' + lines.join('; ')
    );
    err.code = 'TENANCY_MISMATCH';
    throw err;
  }
  console.log(
    `Tenancy check passed: ${before.totals.experiments} experiments, ` +
    `${before.totals.variants} variants, ${before.totals.events} events, ` +
    `${before.totals.test_events} test events, ${before.totals.excluded_events} excluded events, ` +
    `${before.totals.audit_rows} audit rows, ${before.totals.clients} client logins.`
  );
}

module.exports = {
  LEGACY_ACCOUNT_NAME,
  SUPERADMIN_EMAIL,
  PRIMARY_SITE_HOST,
  newSiteKey,
  hostSet,
  applyTenancy,
  snapshot,
  mismatchLines,
};
