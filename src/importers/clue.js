import { deriveSpans } from '../spans.js';

// Re-exported so existing callers and tests that import buildSpansFromFlow
// from this module keep working unchanged; the implementation now lives in
// src/spans.js so it can be run on a merged document, not just Clue-only
// input.
export { deriveSpans as buildSpansFromFlow };

const DROPPED = new Set(['sleep_duration', 'energy', 'sex_life', 'collection_method']);
const MOOD_TYPES = new Set(['feelings', 'mind', 'social_life']);

export function blankDay(source) {
  return {
    flow: null,
    cramps: null,
    spotting: null,
    pms: false,
    mood: [],
    discharge: null,
    tests: { ovulation: null, pregnancy: null },
    pain: [],
    medicine: [],
    notes: '',
    source,
    precision: 'exact',
  };
}

function options(value) {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter(item => item && typeof item === 'object' && typeof item.option === 'string')
    .map(item => item.option);
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

export function parseClueMeasurements(records) {
  const days = {};
  const birthControl = [];
  const dropped = {};
  const warnings = [];

  // Sorting by (date, type, id) makes duplicate resolution deterministic
  // regardless of the order the export happens to list records in.
  const sorted = [...records].sort((a, b) => (
    String(a.date).localeCompare(String(b.date))
    || String(a.type).localeCompare(String(b.type))
    || String(a.id).localeCompare(String(b.id))
  ));

  for (const record of sorted) {
    const { type, date } = record;

    if (DROPPED.has(type)) {
      dropped[type] = (dropped[type] ?? 0) + 1;
      continue;
    }

    const opts = options(record.value);

    if (type === 'birth_control_implant') {
      if (opts.includes('inserted')) {
        birthControl.push({
          method: 'implant', startedOn: date, endedOn: null, expectedEffect: 'suppress',
        });
      }
      continue;
    }

    const isMood = MOOD_TYPES.has(type);
    const known = isMood || ['period', 'spotting', 'discharge', 'pms', 'pain', 'tests'].includes(type);
    if (!known) {
      dropped[type] = (dropped[type] ?? 0) + 1;
      warnings.push(`unmapped type: ${type}`);
      continue;
    }

    if (opts.length === 0) continue;

    const day = days[date] ?? blankDay('clue');

    // `touched` enforces lazy day creation. Every branch below that writes a
    // field sets it; the `tests` branch sets it only for an option it actually
    // recognises. Without this, a record whose options are all unrecognised
    // would still commit a day whose every field is null — exactly the empty
    // noise this importer exists to avoid.
    let touched = false;

    if (isMood) {
      for (const option of opts) pushUnique(day.mood, option);
      touched = true;
    } else if (type === 'period') {
      day.flow = opts[opts.length - 1];
      touched = true;
    } else if (type === 'spotting') {
      day.spotting = opts[opts.length - 1];
      touched = true;
    } else if (type === 'discharge') {
      day.discharge = opts[opts.length - 1];
      touched = true;
    } else if (type === 'pms') {
      // An explicit "no" is a real recorded answer, so it earns a day entry
      // even though `false` is also the default.
      day.pms = opts.includes('yes');
      touched = true;
    } else if (type === 'pain') {
      for (const option of opts) {
        if (option === 'period_cramps') day.cramps = 'unknown';
        else if (option === 'pain_free') day.cramps = 'none';
        else pushUnique(day.pain, option);
      }
      touched = true;
    } else if (type === 'tests') {
      for (const option of opts) {
        if (option.startsWith('pregnancy_')) {
          day.tests.pregnancy = option.slice('pregnancy_'.length);
          touched = true;
        } else if (option.startsWith('ovulation_')) {
          day.tests.ovulation = option.slice('ovulation_'.length);
          touched = true;
        } else {
          warnings.push(`unknown test option: ${option}`);
        }
      }
    }

    if (touched) days[date] = day;
  }

  return { days, spans: deriveSpans(days), birthControl, dropped, warnings };
}
