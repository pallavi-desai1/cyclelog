import { diffDays } from './dates.js';
import { monthLabel } from './calendar.js';
import { currentEpisode, lastPeriodStartOnOrBefore } from './episodes.js';

export function dayLabel(iso) {
  return `${Number(iso.slice(8, 10))} ${monthLabel(iso.slice(0, 7))}`;
}

function spanCovering(doc, iso) {
  for (const span of doc.spans ?? []) {
    const end = span.end ?? span.start;
    if (span.start <= iso && iso <= end) return span;
  }
  return null;
}

// Only what was actually recorded: a day editor shows empty fields, but a
// day *view* listing "Discharge: none" for every blank would bury the two
// things she did write down.
function loggedItems(entry) {
  if (entry === null) return [];
  const items = [];
  const add = (label, value) => { if (value) items.push({ label, value }); };

  add('Flow', entry.flow);
  add('Cramps', entry.cramps);
  add('Spotting', entry.spotting);
  if (entry.pms === true) items.push({ label: 'PMS', value: 'yes' });
  add('Mood', (entry.mood ?? []).join(', '));
  add('Discharge', entry.discharge);
  add('Ovulation test', entry.tests ? entry.tests.ovulation : null);
  add('Pregnancy test', entry.tests ? entry.tests.pregnancy : null);
  add('Pain', (entry.pain ?? []).join(', '));
  add('Medicine', (entry.medicine ?? []).join(', '));
  add('Notes', entry.notes);

  return items;
}

export function dayDetail(doc, dateISO, {
  todayISO, adaptedDate = null, baselineDates = [],
}) {
  const entry = (doc.days ?? {})[dateISO] ?? null;
  const span = spanCovering(doc, dateISO);
  // The period that opened this cycle. For a future date this is still the
  // last one logged, which is exactly what "day 23" means when she is waiting.
  const cycleStart = lastPeriodStartOnOrBefore(doc, dateISO);
  const episode = currentEpisode(doc, dateISO);

  return {
    date: dateISO,
    label: dayLabel(dateISO),
    isToday: dateISO === todayISO,
    isFuture: dateISO > todayISO,

    cycleStart,
    cycleDay: cycleStart === null ? null : diffDays(cycleStart, dateISO) + 1,

    isPeriod: span !== null,
    periodDay: span === null ? null : diffDays(span.start, dateISO) + 1,

    hasEntry: entry !== null,
    logged: loggedItems(entry),
    source: entry ? entry.source ?? null : null,
    isApproximate: entry ? entry.precision === 'approx' : false,

    // `episode.method === undefined` is the shape a shared copy has under
    // the narrowest scope, which sends episode dates without the method's
    // name (src/sync/scope.js EPISODE_FIELDS.dates). Without this guard the
    // partner's day panel renders "Method: undefined since <date>".
    method: episode === null || episode.method === undefined
      ? null
      : { method: episode.method, startedOn: episode.startedOn },

    predicted: adaptedDate !== null && dateISO === adaptedDate,
    baseline: baselineDates.includes(dateISO),
  };
}
