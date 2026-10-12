import { addDays, diffDays } from './dates.js';
import { episodeAt } from './cycles.js';

export function periodStartsDuringEpisodes(doc) {
  // episodeAt already owns "which episode was in force on this date", including
  // its inclusive-endedOn boundary. Re-deriving that here would be a second
  // copy of the same rule, free to drift from the first.
  return [...(doc.spans ?? [])]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(span => {
      const episode = episodeAt(doc, span.start);
      return episode === null
        ? null
        : { start: span.start, method: episode.method, episodeStart: episode.startedOn };
    })
    .filter(entry => entry !== null);
}

function lastStartBefore(allStarts, iso) {
  let found = null;
  for (const start of allStarts) {
    if (start < iso) found = start;
    else break;
  }
  return found;
}

// Each actual period start during birth control is paired with the nth
// projection of the frozen baseline. Pairing by index is what makes this read
// as "this cycle came N days later than it would have", cycle by cycle.
export function divergenceSeries(doc, baseline) {
  if (!baseline || baseline.available !== true) return [];
  if (!baseline.anchor || !Number.isFinite(baseline.length)) return [];
  const length = baseline.length;
  if (!(length > 0)) return [];

  const allStarts = [...(doc.spans ?? [])].map(span => span.start).sort((a, b) => a.localeCompare(b));
  const ordinals = new Map();
  const anchors = new Map();
  const rows = [];

  for (const entry of periodStartsDuringEpisodes(doc)) {
    // Numbering restarts within each episode, and each episode projects from the
    // last period start before it began. Numbering straight through a gap of
    // natural cycling would pair a post-break period against a projection that
    // ignores the elapsed months — on a pill-then-gap-then-implant history that
    // produced a divergence of -177 days, projecting a period from an anchor
    // months after it.
    const n = (ordinals.get(entry.episodeStart) ?? 0) + 1;
    ordinals.set(entry.episodeStart, n);

    if (!anchors.has(entry.episodeStart)) {
      anchors.set(entry.episodeStart, lastStartBefore(allStarts, entry.episodeStart));
    }
    const anchor = anchors.get(entry.episodeStart);

    // No logged period before this episode means there is no "would have been"
    // date to measure against, so the row is omitted rather than projected from
    // a stale anchor. Falling back to `baseline.anchor` here would reproduce the
    // very bug this function was rewritten to remove — a cycle projected from a
    // pre-birth-control anchor years earlier. Unreachable through the normal
    // pipeline (an available baseline implies logged periods before every
    // episode) but reachable by a caller supplying its own baseline.
    if (anchor === null) continue;

    // Multiply before rounding. Rounding the step first and then multiplying
    // drifts up to half a day per cycle — six days by the twelfth — and the
    // baseline length is a weighted median, which lands on x.5 for an
    // even-sized sample.
    const projected = addDays(anchor, Math.round(length * n));

    rows.push({
      index: n,
      actual: entry.start,
      baseline: projected,
      delta: diffDays(projected, entry.start),
      method: entry.method,
      episodeStart: entry.episodeStart,
    });
  }

  return rows;
}

export function meanShift(series) {
  const deltas = (series ?? []).map(point => point.delta).filter(Number.isFinite);
  if (deltas.length === 0) return null;
  return deltas.reduce((total, d) => total + d, 0) / deltas.length;
}
