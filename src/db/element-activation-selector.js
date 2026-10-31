// Migration 022. An element start uses activation_value only. A selector
// left in element_selector from before that start was chosen waits for an
// element that may never appear, so no visitor is assigned. Clear those
// leftovers. page_load, js_condition and manual keep element_selector.
// Nothing is dropped. schema.sql and migration 000 are left alone.
// Re-running this is safe.

async function applyElementActivationSelector(client) {
  await client.query(`
    UPDATE experiments
    SET element_selector = NULL
    WHERE activation_type = 'element'
      AND element_selector IS NOT NULL
  `);
}

module.exports = { applyElementActivationSelector };
