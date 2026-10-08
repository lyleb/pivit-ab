// Plain-English health for a running experiment. The route gathers the
// numbers; this module only decides the green / amber / red wording so the
// dashboard and the tests share one copy.

// Below this, a quiet result is "too early", not "the split is fine".
// A detected mismatch is still reported — that threshold is already strict.
const MIN_SPLIT_VISITORS = 50;

function sampleRatioCheck(srm, totalVisitors) {
  if (srm && srm.srm_detected) {
    return {
      state: 'red',
      title: 'Traffic split',
      detail: 'The traffic split does not match the weights you set. Treat the results with caution until this is understood.',
    };
  }
  const visitors = Number(totalVisitors) || 0;
  if (!srm || !srm.applicable || visitors < MIN_SPLIT_VISITORS) {
    return {
      state: 'amber',
      title: 'Traffic split',
      detail: 'Not enough visitors yet to check the traffic split.',
    };
  }
  return {
    state: 'green',
    title: 'Traffic split',
    detail: 'The traffic split matches the weights you set.',
  };
}

function goalsCheck({ scope, goalCount } = {}) {
  if (scope === 'divergent') {
    return {
      state: 'red',
      title: 'Goals',
      detail: 'These variants do not measure the same goals. A variant without the goal shows 0%.',
    };
  }
  if (!goalCount) {
    return {
      state: 'amber',
      title: 'Goals',
      detail: 'No goals yet, so the conversion rate will stay at 0%.',
    };
  }
  return {
    state: 'green',
    title: 'Goals',
    detail: 'Every variant uses the same goals.',
  };
}

function countReason(rows, reason) {
  return (rows || []).reduce((sum, row) => {
    if (row.reason !== reason) return sum;
    return sum + (Number(row.drop_count) || 0);
  }, 0);
}

function dropSentence(rate, bot, host) {
  const parts = [`${rate} rate-limited`, `${bot} filtered as bots`];
  if (host) parts.push(`${host} from another site`);
  return parts.join(', ');
}

function dropsCheck(rows, today) {
  const all = rows || [];
  const todayRows = all.filter((row) => String(row.day).slice(0, 10) === today);
  const rateToday = countReason(todayRows, 'rate_limited');
  const botToday = countReason(todayRows, 'bot');
  const hostToday = countReason(todayRows, 'host');
  const rateWeek = countReason(all, 'rate_limited');
  const botWeek = countReason(all, 'bot');
  const hostWeek = countReason(all, 'host');
  const todayText = `Today: ${dropSentence(rateToday, botToday, hostToday)}.`;
  const weekText = ` Last 7 days: ${dropSentence(rateWeek, botWeek, hostWeek)}.`;
  if (rateToday > 0) {
    return {
      state: 'red',
      title: 'Dropped events',
      detail: `${todayText}${weekText} Real clicks may be missing.`,
    };
  }
  if (rateWeek > 0 || botToday > 0 || hostToday > 0 || botWeek > 0 || hostWeek > 0) {
    return {
      state: 'amber',
      title: 'Dropped events',
      detail: `${todayText}${weekText}`,
    };
  }
  return {
    state: 'green',
    title: 'Dropped events',
    detail: 'No events were dropped today.',
  };
}

function exclusionSentence(heldOut, removed) {
  const gone = Number(removed) || 0;
  if (gone > 0 && heldOut) {
    const verb = gone === 1 ? 'has' : 'have';
    return `They are excluded from the results. ${gone} of them ${verb} been removed and stay out until you restore them.`;
  }
  if (gone > 0) {
    const noun = gone === 1 ? 'visitor' : 'visitors';
    return `Included in the results, except ${gone} removed ${noun}, which stay out until you restore them.`;
  }
  return heldOut ? 'They are excluded from the results.' : 'They are included in the results.';
}

function syntheticCheck(count, excluded, removed) {
  const n = Number(count) || 0;
  const heldOut = excluded !== false;
  const gone = Number(removed) || 0;
  if (n <= 0 && gone <= 0) {
    return {
      state: 'green',
      title: 'Test traffic',
      detail: 'No test traffic in these results.',
      visitors: 0,
      excluded: heldOut,
      removed: 0,
    };
  }
  const noun = n === 1 ? 'visitor is' : 'visitors are';
  return {
    state: 'amber',
    title: 'Test traffic',
    detail: `${n} ${noun} test traffic. ${exclusionSentence(heldOut, gone)}`,
    visitors: n,
    excluded: heldOut,
    removed: gone,
  };
}

function buildHealth({ status, srm, totalVisitors, scope, goalCount, drops, today, syntheticVisitors, testExcluded, removedVisitors } = {}) {
  const heldOut = testExcluded !== false;
  const checks = [
    sampleRatioCheck(srm, totalVisitors),
    goalsCheck({ scope, goalCount }),
    dropsCheck(drops, today),
    syntheticCheck(syntheticVisitors, heldOut, removedVisitors),
  ];
  return {
    show: status === 'running',
    status: status || '',
    checks,
    test_traffic: {
      visitors: Number(syntheticVisitors) || 0,
      excluded: heldOut,
      removed: Number(removedVisitors) || 0,
    },
  };
}

module.exports = {
  MIN_SPLIT_VISITORS,
  sampleRatioCheck,
  goalsCheck,
  dropsCheck,
  syntheticCheck,
  buildHealth,
};
