import { diffDays } from './dates.js';

// Groups consecutive flow-bearing days (a gap of up to two days still counts
// as the same period) into spans, deriving each span's source and precision
// from the days that actually contribute to it rather than hard-coding them.
//
// This used to live only in src/importers/clue.js, whose `toSpan` hard-coded
// `source: 'clue'` and `precision: 'exact'` on every span it built — fine
// for Clue-only input, but it meant nothing could rebuild spans from a
// *merged* document without relabelling legacy and manual days as Clue data.
// Moving the derivation here, keyed off each day's own `source`/`precision`
// fields, makes it safe to call on any `days` map regardless of provenance.
//
// Deliberately out of scope: how `days` and `spans` stay in sync on a
// document that already has spans from elsewhere. That is a later plan's
// design problem.
export function deriveSpans(days) {
  const dates = Object.keys(days).filter(date => days[date].flow !== null).sort();
  const spans = [];
  let group = [];

  const flush = () => {
    if (group.length === 0) return;
    const start = group[0];
    const end = group[group.length - 1];
    const sources = new Set(group.map(date => days[date].source));
    const source = sources.size === 1 ? [...sources][0] : 'manual';
    const precision = group.some(date => days[date].precision === 'approx') ? 'approx' : 'exact';
    spans.push({ start, end, precision, endPrecision: precision, source });
  };

  let previous = null;
  for (const date of dates) {
    if (group.length === 0) {
      group = [date];
    } else if (diffDays(previous, date) > 2) {
      flush();
      group = [date];
    } else {
      group.push(date);
    }
    previous = date;
  }
  flush();

  return spans;
}
