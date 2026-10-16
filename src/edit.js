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
  if (doc.days[dateISO] === undefined) return doc;
  const day = dayAt(doc, dateISO);
  day.precision = isApproximate ? 'approx' : 'exact';
  return withDay(doc, dateISO, day);
}

const sortSpans = spans => [...spans].sort((a, b) => a.start.localeCompare(b.start));

const span = (start, end) => ({
  start, end, precision: 'exact', endPrecision: 'exact', source: EDIT_SOURCE,
});

// Surgical, never a rebuild. 48 of her periods have no day entries behind
// them — they came from a text log of start and end dates — so deriving
// spans from days would delete them. Only the span touching this date is
// changed; every other span is carried across untouched.
function addToSpans(spans, dateISO) {
  if (spanCovering(spans, dateISO) !== null) return spans;

  const before = spans.find(s => (s.end ?? s.start) === addDays(dateISO, -1));
  const after = spans.find(s => s.start === addDays(dateISO, 1));
  const others = spans.filter(s => s !== before && s !== after);

  if (before && after) {
    // The day closes the gap between two periods: they were one all along.
    return sortSpans([...others, span(before.start, after.end ?? after.start)]);
  }
  if (before) return sortSpans([...others, span(before.start, dateISO)]);
  if (after) return sortSpans([...others, span(dateISO, after.end ?? after.start)]);
  return sortSpans([...others, span(dateISO, dateISO)]);
}

function removeFromSpans(spans, dateISO) {
  const covering = spanCovering(spans, dateISO);
  if (covering === null) return spans;

  const others = spans.filter(s => s !== covering);
  const start = covering.start;
  const end = covering.end ?? covering.start;

  if (start === end) return sortSpans(others);
  if (dateISO === start) return sortSpans([...others, span(addDays(start, 1), end)]);
  if (dateISO === end) return sortSpans([...others, span(start, addDays(end, -1))]);
  return sortSpans([
    ...others,
    span(start, addDays(dateISO, -1)),
    span(addDays(dateISO, 1), end),
  ]);
}

export function setFlow(doc, dateISO, flow) {
  const withFlow = setDayFields(doc, dateISO, { flow });
  const spans = flow === null
    ? removeFromSpans(doc.spans, dateISO)
    : addToSpans(doc.spans, dateISO);
  return { ...withFlow, spans };
}
