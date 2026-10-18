// What leaves the phone is a projection, built by whitelist. A blacklist
// would leak every field added after it was written — which is exactly the
// mistake this module exists to make impossible.

export const SCOPES = ['dates', 'symptoms', 'everything'];

export const SCOPE_LABELS = {
  dates: 'Dates and predictions — when your periods were and when the next one is expected.',
  symptoms: 'Dates, flow and symptoms — the above plus flow, cramps, spotting, PMS, mood, discharge and test results.',
  everything: 'Everything — the above plus your written notes.',
};

const SPAN_FIELDS = ['start', 'end', 'precision', 'endPrecision', 'source'];
const GAP_FIELDS = ['from', 'to', 'reason'];
const EPISODE_FIELDS = ['startedOn', 'endedOn', 'method', 'expectedEffect'];

// Day fields per scope. `dates` has no entry here because it carries no days
// at all: the spans alone say when she bled.
const DAY_FIELDS = {
  symptoms: ['flow', 'cramps', 'spotting', 'pms', 'mood', 'discharge', 'tests', 'pain', 'medicine', 'source', 'precision'],
  everything: ['flow', 'cramps', 'spotting', 'pms', 'mood', 'discharge', 'tests', 'pain', 'medicine', 'notes', 'source', 'precision'],
};

// A key the scope's field list does not name must simply not appear in the
// output — DAY_FIELDS (and its siblings for spans/gaps/episodes) is the only
// source of truth for what exists, never topped up afterwards. Any value
// that survives the whitelist and is mutable (array or plain object) is
// copied here, once, so a future list field can't repeat the mistake of
// being aliased instead of copied.
const copyValue = (value) => {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
};

const pick = (source, fields) => {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = copyValue(source[field]);
  }
  return out;
};

// A day worth sending: one whose projected fields hold something. Otherwise a
// note-only day would travel as an empty husk under the symptoms scope,
// telling him she logged something on a date without saying what. Reads with
// `?? []` / `=== true` so it works whether or not the scope's whitelist even
// named the key.
function hasContent(day) {
  return Boolean(day.flow) || Boolean(day.cramps) || Boolean(day.spotting)
    || Boolean(day.discharge) || day.pms === true
    || (day.mood ?? []).length > 0 || (day.pain ?? []).length > 0
    || (day.medicine ?? []).length > 0
    || (day.notes ?? '') !== ''
    || Boolean(day.tests && (day.tests.ovulation || day.tests.pregnancy));
}

export function projectDocument(doc, scope) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`unknown share scope: ${scope}`);
  }

  const days = {};
  if (scope !== 'dates') {
    const fields = DAY_FIELDS[scope];
    for (const [date, day] of Object.entries(doc.days ?? {})) {
      const projected = pick(day, fields);
      if (hasContent(projected)) days[date] = projected;
    }
  }

  // Rebuilt field by field, never spread: `sharing` holds the sync key, and a
  // spread would carry it — along with anything else added later.
  return {
    version: 1,
    spans: (doc.spans ?? []).map(span => pick(span, SPAN_FIELDS)),
    gaps: (doc.gaps ?? []).map(gap => pick(gap, GAP_FIELDS)),
    birthControl: (doc.birthControl ?? []).map(episode => pick(episode, EPISODE_FIELDS)),
    days,
  };
}
