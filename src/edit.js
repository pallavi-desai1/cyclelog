import { addDays, parseISO } from './dates.js';
import { blankDay } from './importers/clue.js';

// Her own entries outrank every importer: src/merge.js ranks manual above
// clue above legacy, so a future re-import cannot overwrite what she typed.
export const EDIT_SOURCE = 'manual';

const LIST_FIELDS = ['mood', 'pain'];

export function spanCovering(spans, dateISO) {
  for (const span of spans) {
    const end = span.end ?? span.start;
    if (span.start <= dateISO && dateISO <= end) return span;
  }
  return null;
}

// A day is worth storing only while it holds something. Otherwise an opened
// and abandoned editor would leave a husk behind on every date she looked at.
function isEmpty(day) {
  return day.flow === null
    && day.cramps === null
    && day.spotting === null
    && day.discharge === null
    && day.pms !== true
    && day.mood.length === 0
    && day.pain.length === 0
    && day.notes === ''
    && day.tests.ovulation === null
    && day.tests.pregnancy === null;
}

function withDay(doc, dateISO, day) {
  const days = { ...doc.days };
  if (day === null || isEmpty(day)) delete days[dateISO];
  else days[dateISO] = day;
  return { ...doc, days };
}

function dayAt(doc, dateISO) {
  const existing = doc.days[dateISO];
  if (existing === undefined) return { ...blankDay(EDIT_SOURCE) };
  return {
    ...existing,
    mood: [...(existing.mood ?? [])],
    pain: [...(existing.pain ?? [])],
    tests: { ...existing.tests },
  };
}

export function setDayFields(doc, dateISO, patch) {
  parseISO(dateISO);                       // rejects a date that cannot exist
  const day = dayAt(doc, dateISO);

  for (const [field, value] of Object.entries(patch)) {
    if (LIST_FIELDS.includes(field)) day[field] = [...value];
    else if (field === 'tests') day.tests = { ...day.tests, ...value };
    else if (field === 'notes') day.notes = value.trim();
    else day[field] = value;
  }
  day.source = EDIT_SOURCE;

  return withDay(doc, dateISO, day);
}

export function setApproximate(doc, dateISO, isApproximate) {
  // Unlike setDayFields, this does not call parseISO: an impossible date
  // with no existing day simply falls through this guard and returns the
  // document unchanged, rather than throwing.
  if (doc.days[dateISO] === undefined) return doc;
  const day = dayAt(doc, dateISO);
  day.precision = isApproximate ? 'approx' : 'exact';
  return withDay(doc, dateISO, day);
}

const sortSpans = spans => [...spans].sort((a, b) => a.start.localeCompare(b.start));

// precision/endPrecision are taken from the caller rather than assumed:
// an endpoint that did not move keeps whatever precision it already had
// (5 of her spans start approximate and 7 end approximate, from lines in
// the hand-written log marked "approx", "(est.)" or "midnight" — those
// feed APPROX_WEIGHT in src/weighted.js). Only an endpoint that is new or
// that moved to the edited date becomes 'exact'.
const span = (start, end, precision, endPrecision) => ({
  start, end, precision, endPrecision, source: EDIT_SOURCE,
});

// Surgical, never a rebuild. Many imported periods have no day entries
// behind them — a text log of start and end dates records no per-day flow —
// so deriving spans from days would delete them. Only the span touching this date is
// changed; every other span is carried across untouched.
function addToSpans(spans, dateISO) {
  if (spanCovering(spans, dateISO) !== null) return spans;

  const before = spans.find(s => (s.end ?? s.start) === addDays(dateISO, -1));
  const after = spans.find(s => s.start === addDays(dateISO, 1));
  const others = spans.filter(s => s !== before && s !== after);

  if (before && after) {
    // The day closes the gap between two periods: they were one all along.
    // Neither original endpoint moved — each keeps its own precision.
    return sortSpans([...others, span(before.start, after.end ?? after.start, before.precision, after.endPrecision)]);
  }
  if (before) {
    // before.start is unmoved; the new end is today's edit, so it's exact.
    return sortSpans([...others, span(before.start, dateISO, before.precision, 'exact')]);
  }
  if (after) {
    // The new start is today's edit, so it's exact; after's end is unmoved.
    return sortSpans([...others, span(dateISO, after.end ?? after.start, 'exact', after.endPrecision)]);
  }
  return sortSpans([...others, span(dateISO, dateISO, 'exact', 'exact')]);
}

function removeFromSpans(spans, dateISO) {
  const covering = spanCovering(spans, dateISO);
  if (covering === null) return spans;

  const others = spans.filter(s => s !== covering);
  const start = covering.start;
  const end = covering.end ?? covering.start;

  if (start === end) return sortSpans(others);
  if (dateISO === start) {
    // The new start moved to the day after the edit, so it's exact; the
    // end never moved and keeps its own precision.
    return sortSpans([...others, span(addDays(start, 1), end, 'exact', covering.endPrecision)]);
  }
  if (dateISO === end) {
    // The start never moved and keeps its own precision; the new end
    // moved to the day before the edit, so it's exact.
    return sortSpans([...others, span(start, addDays(end, -1), covering.precision, 'exact')]);
  }
  // Split: the first half keeps the original start precision and gets a
  // new, exact end; the second half gets a new, exact start and keeps
  // the original end precision.
  return sortSpans([
    ...others,
    span(start, addDays(dateISO, -1), covering.precision, 'exact'),
    span(addDays(dateISO, 1), end, 'exact', covering.endPrecision),
  ]);
}

export function setFlow(doc, dateISO, flow) {
  const withFlow = setDayFields(doc, dateISO, { flow });
  const spans = flow === null
    ? removeFromSpans(doc.spans, dateISO)
    : addToSpans(doc.spans, dateISO);
  return { ...withFlow, spans };
}

// Composes the three edits exactly as a save applies them, with one guard
// `setFlow` cannot provide on its own: `flow` only moves spans when it
// actually changed. A day with no entry has no flow radio checked, so the
// form reports `flow: null` whether she left it alone or deliberately
// cleared it — and routing an untouched save through setFlow unconditionally
// reads a never-recorded flow as a removal, splitting or shrinking whatever
// period silently covers that day (Review Focus 2: many imported periods
// have no day entries behind them, so this is not a corner case for her).
// A deliberate clear still moves the spans correctly, because `existingFlow`
// is non-null in that case and therefore differs from `null`.
export function applyDayEdit(doc, dateISO, { flow, patch, approximate }) {
  const existingFlow = doc.days[dateISO]?.flow ?? null;
  let next = setDayFields(doc, dateISO, patch);
  if (flow !== existingFlow) next = setFlow(next, dateISO, flow);
  next = setApproximate(next, dateISO, approximate);
  return next;
}
