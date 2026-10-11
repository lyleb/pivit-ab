// In-process daily job. Railway runs one web service, so a timer inside the
// process is enough. It is idempotent: a restart after 06:00 London fills
// today's row if it is missing, and a second run the same day does not
// recompute. The timer is not started under NODE_ENV=test.

const { runDailySnapshots } = require('./snapshot');
const { nextLondonRun, londonParts } = require('./clock');

function startSnapshotScheduler() {
  if (process.env.NODE_ENV === 'test') return { stop() {} };
  let timer = null;
  let stopped = false;

  function arm(waitMs, fn) {
    if (stopped) return;
    timer = setTimeout(fn, waitMs);
    if (timer.unref) timer.unref();
  }

  function scheduleNext(from) {
    const next = nextLondonRun(from || new Date(), 6);
    const wait = Math.max(1000, next.getTime() - Date.now());
    arm(wait, async () => {
      try {
        await runDailySnapshots(new Date());
      } catch (err) {
        console.error('Daily status snapshot failed:', err);
      }
      scheduleNext(new Date());
    });
  }

  arm(1500, async () => {
    try {
      const now = new Date();
      if (londonParts(now).hour >= 6) await runDailySnapshots(now);
    } catch (err) {
      console.error('Daily status snapshot failed:', err);
    }
    scheduleNext(new Date());
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { startSnapshotScheduler };
