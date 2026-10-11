// Europe/London clock for the daily status snapshot.
// The portal does not invent its own "today": a snapshot belongs to the
// London calendar date, and the job is due at 06:00 London time.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function londonParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const bag = {};
  fmt.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') bag[part.type] = part.value;
  });
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function londonOffsetMs(instant) {
  const parts = londonParts(instant);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

// A London civil time as a UTC instant. Two passes cover the DST boundary.
function londonCivilToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);
  const offset = londonOffsetMs(new Date(guess));
  let utc = guess - offset;
  const offset2 = londonOffsetMs(new Date(utc));
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

function londonDateISO(date) {
  const parts = londonParts(date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function londonDayStartUtc(date) {
  const parts = londonParts(date);
  return londonCivilToUtc(parts.year, parts.month, parts.day, 0, 0);
}

function previousLondonDate(date) {
  const start = londonDayStartUtc(date);
  return londonDateISO(new Date(start.getTime() - 60 * 60 * 1000));
}

function nextLondonRun(now, hour = 6) {
  const parts = londonParts(now);
  let target = londonCivilToUtc(parts.year, parts.month, parts.day, hour, 0);
  if (target.getTime() <= now.getTime()) {
    const tomorrow = new Date(target.getTime() + 26 * 60 * 60 * 1000);
    const next = londonParts(tomorrow);
    target = londonCivilToUtc(next.year, next.month, next.day, hour, 0);
  }
  return target;
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDayMonth(date) {
  const parts = londonParts(date);
  return `${parts.day} ${MONTHS[parts.month - 1]}`;
}

function formatMonthYear(date) {
  const parts = londonParts(date);
  return `${MONTHS[parts.month - 1]} ${parts.year}`;
}

function formatLondonStamp(date) {
  const parts = londonParts(date);
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${parts.day} ${MONTHS[parts.month - 1]}, ${hour}:${minute}`;
}

function formatLondonDay(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  if (!year || !month || !day) return '';
  return formatDayMonth(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

module.exports = {
  MONTHS,
  londonParts,
  londonCivilToUtc,
  londonDateISO,
  londonDayStartUtc,
  previousLondonDate,
  nextLondonRun,
  addDays,
  formatDayMonth,
  formatMonthYear,
  formatLondonStamp,
  formatLondonDay,
};
