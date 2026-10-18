// Glanceable traffic-split badge.
//
// The chi-square check itself is unchanged: p < 0.01, the same bar as the
// results page, the health panel and the verdict (src/srm.js). This module
// only decides when that result is worth a pill. Below 100 visitors a quiet
// split is still mostly noise, so the badge stays a subtle "Too early" rather
// than "Split OK". A detected mismatch uses that same floor, so a tiny sample
// does not shout "Split skewed" on every row.

const { SRM_P_VALUE_THRESHOLD } = require('./srm');

const SPLIT_CHECK_MIN_VISITORS = 100;

const COPY = {
  ok: {
    label: 'Split OK',
    tooltip: 'Visitors are splitting as expected',
  },
  skewed: {
    label: 'Split skewed',
    tooltip: "Visitors aren't splitting as set; results may be unreliable",
  },
  early: {
    label: 'Too early',
    tooltip: 'Not enough visitors yet to check the split.',
  },
};

function visitorTotal(variants) {
  return (variants || [])
    .filter((variant) => variant && variant.enabled !== false)
    .reduce((sum, variant) => sum + (Number(variant.visitors) || 0), 0);
}

/**
 * @param {{ srmDetected?: boolean, applicable?: boolean, totalVisitors?: number }} input
 * @returns {{ state: 'ok'|'skewed'|'early', show: boolean, label: string, tooltip: string, srmDetected: boolean, visitors: number, minVisitors: number, threshold: number }}
 */
function splitCheck({ srmDetected = false, applicable = true, totalVisitors = 0 } = {}) {
  const visitors = Math.max(0, Number(totalVisitors) || 0);
  const detected = !!srmDetected;
  const ready = applicable !== false && visitors >= SPLIT_CHECK_MIN_VISITORS;
  const state = !ready ? 'early' : (detected ? 'skewed' : 'ok');
  const copy = COPY[state];
  return {
    state,
    show: state !== 'early',
    label: copy.label,
    tooltip: copy.tooltip,
    srmDetected: detected,
    visitors,
    minVisitors: SPLIT_CHECK_MIN_VISITORS,
    threshold: SRM_P_VALUE_THRESHOLD,
  };
}

// srm is the object from detectSRM / srmFor. Visitors are counted from the
// same enabled variants that check used.
function splitCheckFromVariants(srm, variants) {
  return splitCheck({
    srmDetected: !!(srm && srm.srm_detected),
    applicable: !!(srm && srm.applicable),
    totalVisitors: visitorTotal(variants),
  });
}

module.exports = {
  SPLIT_CHECK_MIN_VISITORS,
  splitCheck,
  splitCheckFromVariants,
  visitorTotal,
};
