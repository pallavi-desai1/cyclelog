import { addDays, diffDays } from './dates.js';
import { episodeAt } from './cycles.js';

export function periodStartsDuringEpisodes(doc) {
  // episodeAt already owns "which episode was in force on this date", including
  // its inclusive-endedOn boundary. Re-deriving that here would be a second
  // copy of the same rule, free to drift from the first.
  return [...(doc.spans ?? [])]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(span => ({ start: span.start, method: episodeAt(doc, span.start)?.method ?? null }))
    .filter(entry => entry.method !== null);
}

// Each actual period start during birth control is paired with the nth
// projection of the frozen baseline. Pairing by index is what makes this read
// as "this cycle came N days later than it would have", cycle by cycle.
export function divergenceSeries(doc, baseline) {
  if (!baseline || baseline.available !== true) return [];
  if (!baseline.anchor || !Number.isFinite(baseline.length)) return [];
  const step = Math.round(baseline.length);
  if (!(step > 0)) return [];

  return periodStartsDuringEpisodes(doc).map((entry, i) => {
    const projected = addDays(baseline.anchor, step * (i + 1));
    return {
      index: i + 1,
      actual: entry.start,
      baseline: projected,
      delta: diffDays(projected, entry.start),
      method: entry.method,
    };
  });
}

export function meanShift(series) {
  const deltas = (series ?? []).map(point => point.delta).filter(Number.isFinite);
  if (deltas.length === 0) return null;
  return deltas.reduce((total, d) => total + d, 0) / deltas.length;
}
