// Fertile-window arithmetic. Pure: no DOM, no clock; every date is an argument.
// Must never import predict.js (predict.js imports this module).
import { addDays } from './dates.js';

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

export function applyTestOverride(window, testISO, cycleStartISO) {
  if (testISO == null || (testISO >= window.from && testISO <= window.to)) {
    return { ...window, fromTest: false };
  }
  // A test outside the window wins: it is an observation, the window a guess.
  const recentred = windowFor(testISO, cycleStartISO);
  return { ...recentred, fromTest: true };
}
