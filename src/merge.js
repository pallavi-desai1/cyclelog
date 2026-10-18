const PRECEDENCE = { legacy: 0, clue: 1, manual: 2 };
const SCALAR_FIELDS = ['flow', 'cramps', 'spotting', 'discharge'];

// The full set of day fields mergeDay knows how to handle: the four scalar
// fields above, plus every other field blankDay defines. Exported so a test
// can assert this set stays in lockstep with blankDay's shape — a field added
// to one and not the other would silently inherit the loser's stale value
// through mergeDay's `{ ...loser }` spread, with no error.
export const MERGE_DAY_FIELDS = [...SCALAR_FIELDS, 'tests', 'mood', 'pain', 'medicine', 'pms', 'notes', 'source', 'precision'];

function rank(source) {
  return PRECEDENCE[source] ?? 0;
}

// Free text is never discarded. A note is the user's own words about her own
// body, and no precedence rule can know which sentence matters, so two
// different notes are kept together rather than one winning. Identical notes
// are deduped so a re-import does not double them.
function mergeNotes(winnerNotes, loserNotes) {
  const first = (winnerNotes ?? '').trim();
  const second = (loserNotes ?? '').trim();
  if (!second || first === second) return first;
  if (!first) return second;
  return `${first}\n\n${second}`;
}

// Test results are enums, so they cannot be combined the way notes can: the
// winner's value stands and the discarded one is recorded, which keeps the
// invariant uniform — no non-null value is ever dropped without an audit entry.
function pickTest(winner, loser, field, date, conflicts) {
  const won = winner.tests?.[field] ?? null;
  const lost = loser.tests?.[field] ?? null;
  if (won === null) return lost;
  if (lost !== null && lost !== won) {
    conflicts.push({ date, field: `tests.${field}`, kept: won, discarded: lost });
  }
  return won;
}

function mergeDay(existing, incoming, date, conflicts) {
  const winner = rank(incoming.source) >= rank(existing.source) ? incoming : existing;
  const loser = winner === incoming ? existing : incoming;

  const merged = { ...loser };

  for (const field of SCALAR_FIELDS) {
    if (winner[field] !== null && winner[field] !== undefined) {
      if (loser[field] !== null && loser[field] !== undefined && loser[field] !== winner[field]) {
        conflicts.push({ date, field, kept: winner[field], discarded: loser[field] });
      }
      merged[field] = winner[field];
    }
  }

  merged.tests = {
    ovulation: pickTest(winner, loser, 'ovulation', date, conflicts),
    pregnancy: pickTest(winner, loser, 'pregnancy', date, conflicts),
  };
  merged.mood = [...new Set([...(existing.mood ?? []), ...(incoming.mood ?? [])])];
  merged.pain = [...new Set([...(existing.pain ?? []), ...(incoming.pain ?? [])])];
  merged.medicine = [...new Set([...(existing.medicine ?? []), ...(incoming.medicine ?? [])])];
  merged.pms = Boolean(existing.pms) || Boolean(incoming.pms);
  merged.notes = mergeNotes(winner.notes, loser.notes);
  merged.source = winner.source;
  merged.precision = winner.precision === 'approx' || loser.precision === 'approx' ? 'approx' : 'exact';

  return merged;
}

function sameItem(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Collapses a concatenated list of spans/gaps/episodes down to one entry per
// key. Re-importing the same seed file is a realistic accident (the install
// flow is "AirDrop the seed to the phone and import it"), and without this,
// a duplicate import doubles every span, halves every cycle length, and
// marks every one of them `excluded: false` — corrupting the mean nothing
// downstream would ever notice.
//
// When two items share a key and are otherwise identical, one is kept
// silently (that is the ordinary re-import case, not a conflict). When they
// share a key but differ, the higher-precedence one is kept and a conflict is
// recorded. Spans carry their own `source` and are ranked by it; gaps and
// birth-control episodes carry no `source` field, so `rankOf` returns 0 for
// both and a tie is broken in favour of whichever is encountered later in
// argument order — the same deterministic rule `mergeDay` uses for same-rank
// scalar conflicts.
function dedupeByKey(items, keyOf, rankOf, field, conflicts) {
  const kept = new Map();

  for (const item of items) {
    const key = keyOf(item);
    const existing = kept.get(key);

    if (!existing) {
      kept.set(key, item);
      continue;
    }

    if (sameItem(existing, item)) continue;

    const winner = rankOf(item) >= rankOf(existing) ? item : existing;
    const loser = winner === item ? existing : item;
    kept.set(key, winner);
    conflicts.push({ date: key, field, kept: winner, discarded: loser });
  }

  return [...kept.values()];
}

export function mergeSources(...sources) {
  const doc = { version: 1, birthControl: [], days: {}, spans: [], gaps: [] };
  const conflicts = [];
  const spans = [];
  const gaps = [];
  const birthControl = [];

  for (const source of sources) {
    for (const [date, entry] of Object.entries(source?.days ?? {})) {
      const existing = doc.days[date];
      doc.days[date] = existing ? mergeDay(existing, entry, date, conflicts) : entry;
    }
    spans.push(...(source?.spans ?? []));
    gaps.push(...(source?.gaps ?? []));
    birthControl.push(...(source?.birthControl ?? []));
  }

  doc.spans = dedupeByKey(spans, span => span.start, span => rank(span.source), 'span', conflicts);
  doc.gaps = dedupeByKey(gaps, gap => gap.from, () => 0, 'gap', conflicts);
  doc.birthControl = dedupeByKey(birthControl, episode => episode.startedOn, () => 0, 'birthControl', conflicts);

  doc.spans.sort((a, b) => a.start.localeCompare(b.start));
  doc.gaps.sort((a, b) => a.from.localeCompare(b.from));
  doc.birthControl.sort((a, b) => a.startedOn.localeCompare(b.startedOn));

  return { doc, conflicts };
}
