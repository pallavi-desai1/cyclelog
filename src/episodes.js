import { episodeAt } from './cycles.js';

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
  return [...(doc.birthControl ?? [])].sort((a, b) => a.startedOn.localeCompare(b.startedOn));
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
export function baselineCycles(cycles, doc) {
  const first = firstEpisode(doc);
  const usable = usableCycles(cycles);
  if (first === null) return usable;
  return usable.filter(cycle => cycle.start < first.startedOn);
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
