// Migration 013. A demo test is a labelled type that counts test traffic only.
// Additive: one column, a check, and a trigger that refuses to change the type.
// Existing rows become live via the default. schema.sql and migration 000 are
// left alone. Version 000 is already recorded on the live database and does
// not run again. Re-running this is safe.

async function applyDemoTest(client) {
  await client.query(`
    ALTER TABLE experiments
      ADD COLUMN IF NOT EXISTS test_type TEXT NOT NULL DEFAULT 'live'
  `);
  await client.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'experiments_test_type_check'
      ) THEN
        ALTER TABLE experiments
          ADD CONSTRAINT experiments_test_type_check
          CHECK (test_type IN ('live', 'demo'));
      END IF;
    END
    $do$
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION experiments_test_type_locked()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.test_type = 'demo' AND NEW.test_type IS DISTINCT FROM OLD.test_type THEN
        RAISE EXCEPTION 'A demo test cannot be switched to live.';
      END IF;
      IF OLD.test_type IS DISTINCT FROM 'demo' AND NEW.test_type = 'demo' THEN
        RAISE EXCEPTION 'A live test cannot be changed into a demo.';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `);
  await client.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'experiments_test_type_locked'
      ) THEN
        CREATE TRIGGER experiments_test_type_locked
          BEFORE UPDATE OF test_type ON experiments
          FOR EACH ROW
          EXECUTE PROCEDURE experiments_test_type_locked();
      END IF;
    END
    $do$
  `);
}

module.exports = { applyDemoTest };
