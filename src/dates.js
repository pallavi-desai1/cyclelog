const MS_PER_DAY = 86400000;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseISO(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new TypeError(`not an ISO date: ${iso}`);
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  // Date.UTC silently rolls an impossible calendar date forward (2026-02-30
  // becomes 2 March), so the shape check above is not enough: it validates
  // YYYY-MM-DD syntax, not the calendar. Rolling it back through toISO and
  // comparing catches that — toISO is defined below in this module, but by
  // the time this line runs the module has already finished evaluating (this
  // function is only ever called after import), so there is no
  // use-before-definition hazard.
  if (toISO(ms) !== iso) throw new TypeError(`not a real calendar date: ${iso}`);
  return ms;
}

export function toISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return toISO(parseISO(iso) + n * MS_PER_DAY);
}

export function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / MS_PER_DAY);
}

export function lastDayOfMonth(year, month) {
  return toISO(Date.UTC(year, month, 0));
}
