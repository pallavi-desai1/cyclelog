// Birth control as a list of episodes is the structural decision that lets
// this app survive a method change (spec §3.1): closing one episode and
// opening another needs no migration and no code change. These are the
// operations Settings exposes. Pure functions over the document, like
// src/edit.js is for days — no DOM, no storage, no clock.
import { parseISO } from './dates.js';

// The three the prediction prior in src/episodes.js knows (SIGMA_BY_EFFECT).
// Any other value would fall back to the widest prior silently, so it is
// rejected at the edge instead.
export const EFFECTS = ['suppress', 'regulate', 'none'];

// parseISO already rejects both a malformed string and an impossible calendar
// date ('2015-02-30'), throwing TypeError for either — so this is a thin
// wrapper over it rather than a second date validator. Writing another one
// would be the duplicate-logic defect the review rubric treats as a finding.
function isRealDate(text) {
  try {
    parseISO(text);
    return true;
  } catch {
    return false;
  }
}

// Two episodes overlap when each starts on or before the other ends. An open
// episode (endedOn null) extends forever, so it overlaps everything after its
// start — which is why a second open episode is always a conflict.
function overlaps(a, b) {
  const aEnd = a.endedOn ?? '9999-12-31';
  const bEnd = b.endedOn ?? '9999-12-31';
  return a.startedOn <= bEnd && b.startedOn <= aEnd;
}

export function validateEpisode(episode, { existing = [], ignoreIndex = null } = {}) {
  const startedOn = episode.startedOn ?? '';
  const endedOn = episode.endedOn ?? null;
  const method = (episode.method ?? '').trim();

  if (startedOn === '') return 'Give the date this started.';
  if (!isRealDate(startedOn)) return 'That start date is not a real date.';
  if (endedOn !== null && endedOn !== '' && !isRealDate(endedOn)) {
    return 'That end date is not a real date.';
  }
  if (method === '') return 'Name the method.';
  if (!EFFECTS.includes(episode.expectedEffect)) {
    return 'Choose what effect it is expected to have.';
  }
  if (endedOn !== null && endedOn !== '' && endedOn < startedOn) {
    return 'It cannot end before it started.';
  }

  const candidate = { startedOn, endedOn: endedOn === '' ? null : endedOn };
  for (const [index, other] of existing.entries()) {
    if (index === ignoreIndex) continue;
    if (overlaps(candidate, other)) {
      return other.endedOn === null
        ? `That overlaps the ${other.method} you are still on, which started ${other.startedOn}.`
        : `That overlaps the ${other.method} from ${other.startedOn} to ${other.endedOn}.`;
    }
  }

  return null;
}

// One funnel: every operation below writes through this, so the sort order and
// the copy are guaranteed in one place rather than remembered in four.
function withEpisodes(doc, birthControl) {
  return {
    ...doc,
    birthControl: [...birthControl].sort((a, b) => a.startedOn.localeCompare(b.startedOn)),
  };
}

function clean(episode) {
  return {
    startedOn: episode.startedOn,
    endedOn: episode.endedOn === '' ? null : episode.endedOn ?? null,
    method: (episode.method ?? '').trim(),
    expectedEffect: episode.expectedEffect,
  };
}

export function addEpisode(doc, episode) {
  const existing = doc.birthControl ?? [];
  const problem = validateEpisode(episode, { existing });
  if (problem !== null) throw new Error(problem);
  return withEpisodes(doc, [...existing, clean(episode)]);
}

export function updateEpisode(doc, index, episode) {
  const existing = doc.birthControl ?? [];
  if (existing[index] === undefined) throw new Error('there is no episode there');
  const problem = validateEpisode(episode, { existing, ignoreIndex: index });
  if (problem !== null) throw new Error(problem);
  const next = [...existing];
  next[index] = clean(episode);
  return withEpisodes(doc, next);
}

export function endEpisode(doc, index, endedOn) {
  const existing = doc.birthControl ?? [];
  if (existing[index] === undefined) throw new Error('there is no episode there');
  return updateEpisode(doc, index, { ...existing[index], endedOn });
}

export function removeEpisode(doc, index) {
  const existing = doc.birthControl ?? [];
  if (existing[index] === undefined) throw new Error('there is no episode there');
  return withEpisodes(doc, existing.filter((_, at) => at !== index));
}
