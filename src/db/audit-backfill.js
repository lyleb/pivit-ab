// Migration 014. Copy any test_traffic_audit rows that are not already in
// audit_log. Additive: it only inserts. The experiment screen still reads
// test_traffic_audit, so that table stays. schema.sql and migration 000 are
// left alone. Re-running this is safe: source_audit_id skips rows already copied.

async function applyAuditBackfill(client) {
  await client.query(`
    INSERT INTO audit_log
      (account_id, actor_label, action, target_type, target_id, detail, ip, created_at)
    SELECT
      COALESCE(a.account_id, e.account_id),
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
    LEFT JOIN experiments e ON e.id = a.experiment_id
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_log l
      WHERE l.detail->>'source_audit_id' = a.id::text
    )
  `);
}

module.exports = { applyAuditBackfill };
