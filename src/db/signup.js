// Migration 002. Invite codes, sign-in tokens, Postgres rate limits and the
// audit log. Safe to run again: tables use IF NOT EXISTS, and the copy from
// test_traffic_audit skips rows already copied. The caller wraps this in a
// transaction.

async function applySignup(client) {
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT
  `);
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ
  `);
  await client.query(`
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS conflict BOOLEAN NOT NULL DEFAULT false
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash TEXT NOT NULL UNIQUE,
      hint TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by UUID REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      used_by UUID REFERENCES users(id),
      account_id UUID REFERENCES accounts(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_invite_codes_created ON invite_codes (created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'signup')),
      token_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      website TEXT,
      invite_id UUID REFERENCES invite_codes(id),
      terms_version TEXT,
      request_ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket TEXT PRIMARY KEY,
      hits INTEGER NOT NULL,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      account_id UUID,
      actor_user_id UUID,
      actor_label TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail JSONB NOT NULL DEFAULT '{}',
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log (account_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC)
  `);

  // Copy the existing test-traffic and Reveal rows once. The experiment screen
  // still reads test_traffic_audit, so those rows stay. New actions are written
  // to both, with source_audit_id so this copy does not duplicate them.
  await client.query(`
    INSERT INTO audit_log
      (account_id, actor_label, action, target_type, target_id, detail, ip, created_at)
    SELECT
      a.account_id,
      a.actor,
      CASE a.action
        WHEN 'remove' THEN 'test_traffic_remove'
        WHEN 'restore' THEN 'test_traffic_restore'
        ELSE a.action
      END,
      'experiment',
      a.experiment_id::text,
      jsonb_build_object(
        'criteria', a.criteria,
        'visitor_count', a.visitor_count,
        'event_count', a.event_count,
        'variant_counts', a.variant_counts,
        'source_audit_id', a.id
      ),
      a.actor_ip,
      a.created_at
    FROM test_traffic_audit a
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_log l
      WHERE l.detail->>'source_audit_id' = a.id::text
    )
  `);
}

module.exports = { applySignup };
