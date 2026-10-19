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

// Under this, the health card warns. 90% and above is treated as applied.
const CHANGE_APPLIED_WARN_BELOW = 90;

function changeList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

// Stylesheet, page CSS and page JavaScript do not look up an element.
// Everything else with a selector is what the snippet reports.
function tracksElementChange(changes) {
  return changeList(changes).some((change) => {
    if (!change || change.type === 'stylesheet' || change.type === 'page_css' || change.type === 'page_js') return false;
    return String(change.selector || '').trim() !== '';
  });
}

function changeAppliedLine(row) {
  const name = String((row && (row.variant_name || row.name)) || 'Variant');
  const reported = Number(row && row.reported_views) || 0;
  const applied = Math.min(Number(row && row.applied_views) || 0, reported);
  const base = {
    variant_id: row && row.variant_id,
    variant_name: name,
    reported_views: reported,
    applied_views: applied,
  };
  if (reported <= 0) {
    const seen = Number(row && row.views) || 0;
    return Object.assign(base, {
      rate: null,
      state: 'amber',
      text: seen > 0
        ? `${name}: these views have not reported whether the change was applied.`
        : `${name}: not enough views yet to check whether the change was applied.`,
    });
  }
  const rate = Math.round((applied / reported) * 100);
  const low = rate < CHANGE_APPLIED_WARN_BELOW;
  const phrase = `Change applied on ${rate}% of views`;
  return Object.assign(base, {
    rate,
    state: low ? 'amber' : 'green',
    text: low
      ? `${name}: ${phrase}. The selector was missing on many of these views.`
      : `${name}: ${phrase}.`,
  });
}

function summariseChangeApplied(rows) {
  return (rows || []).filter((row) => tracksElementChange(row && row.changes)).map((row) => changeAppliedLine(row));
}

function changesCard(lines) {
  if (!lines || !lines.length) {
    return {
      state: 'green',
      title: 'Changes',
      detail: 'No element changes to check.',
    };
  }
  return {
    state: lines.some((line) => line.state === 'amber') ? 'amber' : 'green',
    title: 'Changes',
    detail: lines.map((line) => line.text).join('\n'),
  };
}

function buildHealth({ status, srm, totalVisitors, scope, goalCount, drops, today, syntheticVisitors, testExcluded, removedVisitors, changeApplied } = {}) {
  const heldOut = testExcluded !== false;
  const changeLines = summariseChangeApplied(changeApplied);
  const checks = [
    sampleRatioCheck(srm, totalVisitors),
    goalsCheck({ scope, goalCount }),
    dropsCheck(drops, today),
    syntheticCheck(syntheticVisitors, heldOut, removedVisitors),
    changesCard(changeLines),
  ];
  return {
    show: status === 'running',
    status: status || '',
    checks,
    change_applied: changeLines,
    test_traffic: {
      visitors: Number(syntheticVisitors) || 0,
      excluded: heldOut,
      removed: Number(removedVisitors) || 0,
    },
  };
}

module.exports = {
  MIN_SPLIT_VISITORS,
  CHANGE_APPLIED_WARN_BELOW,
  sampleRatioCheck,
  goalsCheck,
  dropsCheck,
  syntheticCheck,
  tracksElementChange,
  changeAppliedLine,
  summariseChangeApplied,
  buildHealth,
};
