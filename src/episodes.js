import { episodeAt, isNoMethod } from './cycles.js';

// Irregularity priors by what the method is expected to do to the cycle.
export const SIGMA_BY_EFFECT = { suppress: 7, regulate: 3, none: 0 };

// An unrecognised effect gets the widest prior. A wider prior lowers the
// confidence percentage, which is the honest direction when we do not know how
// a method behaves.
const FALLBACK_EFFECT = 'suppress';

export function sigmaForEffect(effect) {
  return SIGMA_BY_EFFECT[effect] ?? SIGMA_BY_EFFECT[FALLBACK_EFFECT];
}

export function sortedEpisodes(doc) {
  return (doc.birthControl ?? []).filter(episode => !isNoMethod(episode)).sort((a, b) => a.startedOn.localeCompare(b.startedOn));
}

export function firstEpisode(doc) {
  return sortedEpisodes(doc)[0] ?? null;
}

export function currentEpisode(doc, todayISO) {
  return episodeAt(doc, todayISO);
}

export function usableCycles(cycles) {
  return (cycles ?? []).filter(
    cycle => !cycle.excluded && typeof cycle.length === 'number' && cycle.length > 0,
  );
}

// The baseline sample is everything before the FIRST episode, not the current
// one. Frozen at that boundary, it never moves, which is what makes the
// counterfactual a fair comparison instead of a target that drifts.
//
// The WHOLE cycle must precede the first episode, not merely its start. A cycle
// that starts before birth control and ends at the first period after it has a
// length produced entirely by the method — and `baselineModel` would then anchor
// on that cycle's nextStart, which is a post-method period start. That makes the
// counterfactual track the very reality it exists to contrast with, and it
// happens on the first period logged after starting a method.
export function baselineCycles(cycles, doc) {
  const first = firstEpisode(doc);
  const usable = usableCycles(cycles);
  if (first === null) return usable;
  return usable.filter(cycle => cycle.start < first.startedOn
    && typeof cycle.nextStart === 'string'
    && cycle.nextStart <= first.startedOn);
}

// The sample the forward prediction learns from: every usable cycle that no
// hormonal method touched at any point. Unlike `baselineCycles` it is not frozen
// at a boundary, so natural cycles she has from now on keep counting.
//
// The WHOLE cycle must be clear of a hormonal method, not merely its start.
// `buildCycles` resolves a cycle's governing episode at its start, so a cycle
// that began off birth control and ended at the first period after a method went
// in would look natural while its length was produced entirely by the method.
// This is the same bug found and fixed in `baselineCycles` (see its comment), so
// the test is interval intersection: [startedOn, endedOn ?? infinity] against
// [cycle.start, cycle.nextStart - 1].
//
// The upper bound is exclusive of nextStart because nextStart is the first day
// of the NEXT cycle: a method starting the day a period begins cannot have
// influenced the cycle that period ended. The lower bound stays closed, so an
// episode whose inclusive endedOn falls on cycle.start still drops the cycle
// (hormones linger; excluding is the conservative direction). For a single
// open-ended episode this reduces to cycle.nextStart <= first.startedOn, which
// is exactly baselineCycles' second condition, so the two samples agree on the
// boundary.
//
// Hormonal means not "no method" and an effect other than 'none'. An unknown or
// missing effect counts as hormonal, the same fail-safe as `sigmaForEffect`.
export function naturalCycles(cycles, doc) {
  const hormonal = (doc?.birthControl ?? []).filter(
    episode => !isNoMethod(episode) && episode.expectedEffect !== 'none',
  );
  return usableCycles(cycles).filter(cycle => !hormonal.some(
    episode => episode.startedOn < cycle.nextStart
      && (episode.endedOn == null || episode.endedOn >= cycle.start),
  ));
}

// The last logged period start at or before `iso`. A period that begins on the
// day a method starts began under the natural cycle, so the boundary is
// inclusive. Shared so `predict` and `divergence` cannot drift apart about what
// an anchor is — they are shown side by side on one screen.
export function lastPeriodStartOnOrBefore(doc, iso) {
  let found = null;
  for (const start of [...(doc.spans ?? [])].map(s => s.start).sort((a, b) => a.localeCompare(b))) {
    if (start <= iso) found = start;
    else break;
  }
  return found;
}

// Adaptation looks only at the current episode: an implant tells you nothing
// about how a pill will behave, so a method change resets the learning.
export function episodeCycles(cycles, doc, todayISO) {
  const episode = currentEpisode(doc, todayISO);
  if (episode === null) return [];
  const end = episode.endedOn ?? null;
  return usableCycles(cycles).filter(
    cycle => cycle.start >= episode.startedOn && (end === null || cycle.start <= end),
  );
}
