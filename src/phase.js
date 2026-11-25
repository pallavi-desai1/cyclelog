// Fertile-window arithmetic. Pure: no DOM, no clock; every date is an argument.
// Must never import predict.js (predict.js imports this module).
import { addDays } from './dates.js';
import { lastPeriodStartOnOrBefore } from './episodes.js';

// Luteal phase is the steadier half of the cycle, so ovulation is counted
// back from the next period rather than forward from the last one.
export const LUTEAL_DAYS = 14;
export const WINDOW_DAYS = 6;
// 1-based position of the descent day inside the window: window = descent-4 … descent+1.
export const DESCENT_POSITION = 5;

export function descentFor(nextStartISO) {
  return addDays(nextStartISO, -LUTEAL_DAYS);
}

export function windowFor(descentISO, cycleStartISO) {
  // Descent on or before the cycle's own first day means there is no window
  // inside this cycle at all.
  if (descentISO <= cycleStartISO) return null;
  const earliest = addDays(descentISO, -(DESCENT_POSITION - 1));
  // This clamp is NOT the truncation the spec forbids. The spec forbids cutting
  // a window at a birth-control method boundary, because a partial window there
  // overstates precision. Clamping at the cycle start only declines to claim
  // days that belong to the previous cycle. Do not "fix" one into the other.
  const from = earliest < cycleStartISO ? cycleStartISO : earliest;
  return { from, descent: descentISO, to: addDays(descentISO, WINDOW_DAYS - DESCENT_POSITION) };
}

// The earliest positive is the LH surge; later positives are the same surge.
// The next cycle's start is excluded: it belongs to the following cycle.
export function firstPositiveTest(doc, cycleStartISO, nextStartISO) {
  const days = doc?.days;
  if (!days) return null;
  let first = null;
  for (const [date, entry] of Object.entries(days)) {
    if (date < cycleStartISO || date >= nextStartISO) continue;
    if (entry?.tests?.ovulation !== 'positive') continue;
    if (first === null || date < first) first = date;
  }
  return first;
}

// Contract: always returns a usable {from, descent, to, fromTest}; never null,
// never partial. Callers (the prediction hook) rely on this.
export function applyTestOverride(window, testISO, cycleStartISO) {
  if (testISO == null || (testISO >= window.from && testISO <= window.to)) {
    return { ...window, fromTest: false };
  }
  // A test outside the window wins: it is an observation, the window a guess.
  const recentred = windowFor(testISO, cycleStartISO);
  // A positive on the cycle's first day or two cannot anchor a window (descent
  // would land on or before the cycle start). Keep the arithmetic window then:
  // dropping it would erase fertile marks the arithmetic flags, and hiding a
  // flagged day is the one direction this feature may not fail in. Such a test
  // is more likely a mis-log or odd surge; it still shows in the day panel.
  if (recentred === null) return { ...window, fromTest: false };
  return { ...recentred, fromTest: true };
}

// Which birth-control episode governs `iso`, and what effect it expects.
//
// This DELIBERATELY duplicates the resolution rule of `episodeAt` in
// src/cycles.js (later start wins; a tie on start date goes to the episode
// still open; `endedOn` is inclusive). It is a ruled decision, not an
// oversight: fertile-window suppression must read `expectedEffect` WITHOUT
// passing through method-name resolution. Under the narrowest share scope the
// partner's copy has the method name stripped, so routing through `episodeAt`
// would silently switch suppression off on his phone. If the rule changes in
// cycles.js, change it here too.
const isOpenEpisode = e => e.endedOn === null || e.endedOn === undefined;

function governs(e, incumbent) {
  if (e.startedOn !== incumbent.startedOn) return e.startedOn > incumbent.startedOn;
  if (isOpenEpisode(e) !== isOpenEpisode(incumbent)) return isOpenEpisode(e);
  return true;
}

// Returns { covered, effect }: whether any episode covers `iso`, and the
// governing one's expectedEffect (undefined when absent).
function governingEffect(doc, iso) {
  let latest = null;
  for (const e of doc?.birthControl ?? []) {
    if (e.startedOn > iso || (!isOpenEpisode(e) && e.endedOn < iso)) continue;
    if (latest === null || governs(e, latest)) latest = e;
  }
  return latest === null ? { covered: false } : { covered: true, effect: latest.expectedEffect };
}

// Only no covering episode, or one with effect 'none', leaves a window shown.
// Anything else, including a missing or unrecognised value, suppresses:
// imported documents are not guaranteed a validated effect, and hiding a
// flagged day is the direction this feature may not fail in.
function suppressed(doc, iso) {
  const { covered, effect } = governingEffect(doc, iso);
  return covered && effect !== 'none';
}

// One window per cycle with a known next start, overlapping [fromISO, toISO].
// `nextStartFor` is supplied by the caller (logged next period, or the pinned
// projection for the current cycle) so this module needs no clock and no
// import of predict.js. Suppression is judged at the descent day only: a window
// is shown whole or not at all, since a window cut at a method boundary would
// read as a narrower, more precise claim than the six days really are.
export function cycleWindows(doc, { nextStartFor, fromISO, toISO }) {
  const starts = (doc?.spans ?? []).map(s => s.start).sort();
  const out = [];
  for (const cycleStart of starts) {
    const nextStart = nextStartFor(cycleStart);
    if (nextStart == null) continue;
    const base = windowFor(descentFor(nextStart), cycleStart);
    if (base === null) continue;
    const w = applyTestOverride(base, firstPositiveTest(doc, cycleStart, nextStart), cycleStart);
    if (w.from > toISO || w.to < fromISO) continue;
    if (suppressed(doc, w.descent)) continue;
    out.push({ ...w, cycleStart });
  }
  return out;
}

// Names the phase of `iso`. `windows` is the output of cycleWindows.
// A logged bleeding day outranks the arithmetic: it is an observation. In a
// short cycle the window can open while she is still bleeding; the day is then
// named 'period' while cycleWindows still carries the fertile mark, so nothing
// the arithmetic flags is hidden. An open span covers its start day only
// (`end ?? start`, as everywhere else in the app).
export function phaseAt(doc, iso, windows) {
  if ((doc?.spans ?? []).some(s => s.start <= iso && iso <= (s.end ?? s.start))) return 'period';
  const cycleStart = lastPeriodStartOnOrBefore(doc ?? {}, iso);
  if (cycleStart === null) return 'unknown';
  const w = windows.find(x => x.cycleStart === cycleStart);
  if (!w) return 'unknown';
  if (iso < w.from) return 'follicular';
  if (iso > w.to) return 'luteal';
  return 'fertile';
}
