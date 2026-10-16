import { parseISO, addDays, lastDayOfMonth, pad2 } from './dates.js';

// Sunday first: this is a US calendar, and the owner reads it at a glance.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthOf(iso) {
  return iso.slice(0, 7);
}

export function shiftMonth(month, delta) {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  // Math.floor, not a truncating divide: stepping back from January must land
  // in the previous December rather than rounding toward zero.
  const shiftedYear = year + Math.floor(index / 12);
  const shiftedMonth = ((index % 12) + 12) % 12;
  return `${shiftedYear}-${pad2(shiftedMonth + 1)}`;
}

export function monthLabel(month) {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function weekdayOf(iso) {
  return new Date(parseISO(iso)).getUTCDay();
}

// Every date a span covers. A span with no logged end covers its start only —
// guessing an end would draw days of bleeding that were never recorded.
function periodDays(spans) {
  const marked = new Set();
  for (const span of spans ?? []) {
    const end = span.end ?? span.start;
    for (let date = span.start; date <= end; date = addDays(date, 1)) {
      marked.add(date);
    }
  }
  return marked;
}

function cellFor(date, { month, todayISO, bleeding, days, adaptedDate, baselineDate }) {
  const entry = days[date] ?? null;
  return {
    date,
    day: Number(date.slice(8, 10)),
    inMonth: monthOf(date) === month,
    isToday: date === todayISO,
    isPeriod: bleeding.has(date),
    flow: entry ? entry.flow ?? null : null,
    spotting: entry ? entry.spotting ?? null : null,
    pms: entry ? entry.pms === true : false,
    // Two separate marks, never one: §10.3 draws the adapted prediction as a
    // solid outline and the counterfactual as a dashed one, so they stay
    // distinguishable without relying on colour.
    predicted: adaptedDate !== null && date === adaptedDate,
    baseline: baselineDate !== null && date === baselineDate,
    hasEntry: entry !== null,
  };
}

export function monthGrid(doc, {
  month, todayISO, adaptedDate = null, baselineDate = null,
}) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const first = `${month}-01`;
  const last = lastDayOfMonth(year, monthNumber);

  // Whole weeks: back to the Sunday on or before the 1st, forward to the
  // Saturday on or after the last day.
  const start = addDays(first, -weekdayOf(first));
  const end = addDays(last, 6 - weekdayOf(last));

  const context = {
    month,
    todayISO,
    bleeding: periodDays(doc.spans),
    days: doc.days ?? {},
    adaptedDate,
    baselineDate,
  };

  const weeks = [];
  let week = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    week.push(cellFor(date, context));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  return { month, label: monthLabel(month), weeks };
}
