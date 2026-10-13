import { addDays, diffDays } from './dates.js';
import { cycleWeight, weightedMedian, weightedSd, effectiveN } from './weighted.js';
import { confidencePercent } from './confidence.js';
import { baselineCycles, episodeCycles, currentEpisode, sigmaForEffect } from './episodes.js';
import { describeLengths } from './stats.js';

// How fast the adapted model trusts the current episode over the baseline.
// w = n/(n+TAU): half credit at three episode cycles, 80% at twelve.
export const TAU = 3;

// A projection loop bound. Twenty-odd years of 21-day cycles is ~350 steps, so
// this is far above any real use while still terminating on bad input.
export const MAX_PROJECTIONS = 2000;

// A period is "late" for three days; past that, on a method expected to suppress
// bleeding, "no period expected" is the better explanation than lateness. A flat
// constant rather than a multiple of sigma — chosen for legibility, and it
// happens to sit near one standard deviation of the owner's baseline.
export const LATE_GRACE_DAYS = 3;

const unavailable = (model, reason) => ({
  available: false,
  model,
  date: null,
  length: null,
  sigma: null,
  confidence: null,
  nEff: 0,
  anchor: null,
  weight: null,
  previousDate: null,
  status: null,
  daysLate: null,
  reason,
});

export function lastPeriodStart(doc) {
  const spans = [...(doc.spans ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  return spans.length > 0 ? spans[spans.length - 1].start : null;
}

export function projectForward(anchorISO, lengthDays, todayISO, maxSteps = MAX_PROJECTIONS) {
  if (!anchorISO) return null;
  if (!Number.isFinite(lengthDays) || !(lengthDays > 0)) return null;

  // Multiply before rounding. Stepping a pre-rounded length drifts up to half a
  // day per cycle — fifteen days over three years at a length of 28.5 — and
  // `divergence.js` projects the same baseline by multiplying, so stepping here
  // would make two numbers on one screen disagree.
  for (let n = 1; n <= maxSteps; n += 1) {
    const date = addDays(anchorISO, Math.round(lengthDays * n));
    if (date >= todayISO) return date;
  }
  return null;
}

// The most recent projection strictly before today, or null if none has passed.
// `projectForward` returns the first projection on or AFTER today, so `date` can
// never be overdue — lateness needs its own lookup rather than being derived.
export function projectPrevious(anchorISO, lengthDays, todayISO, maxSteps = MAX_PROJECTIONS) {
  if (!anchorISO) return null;
  if (!Number.isFinite(lengthDays) || !(lengthDays > 0)) return null;

  let previous = null;
  for (let n = 1; n <= maxSteps; n += 1) {
    const date = addDays(anchorISO, Math.round(lengthDays * n));
    if (date >= todayISO) return previous;
    previous = date;
  }
  return null;
}

// The first projection after the anchor — the date the period was actually due.
// Lateness is measured from here, never from the most recent passed projection:
// that would sawtooth back to 1 at every cycle boundary, so a woman 57 days
// overdue would read "1 day late".
export function firstProjection(anchorISO, lengthDays) {
  if (!anchorISO) return null;
  if (!Number.isFinite(lengthDays) || !(lengthDays > 0)) return null;
  return addDays(anchorISO, Math.round(lengthDays));
}

// `suppressing` is whether the method in force TODAY is expected to suppress
// bleeding. Read at today, not at the cycle's start: a method begun mid-cycle
// would otherwise report "late" forever.
export function predictionStatus(previousDate, todayISO, suppressing) {
  if (!previousDate) return { status: 'upcoming', daysLate: null };
  const daysLate = diffDays(previousDate, todayISO);
  if (daysLate <= 0) return { status: 'upcoming', daysLate: null };
  if (daysLate <= LATE_GRACE_DAYS) return { status: 'late', daysLate };
  // Past the window, only a suppressing method makes absence the expectation.
  return { status: suppressing ? 'not-expected' : 'late', daysLate };
}

export function baselineModel(cycles, doc, todayISO) {
  const sample = baselineCycles(cycles, doc);
  if (sample.length < 2) {
    return unavailable('baseline', `needs at least 2 usable pre-birth-control cycles, has ${sample.length}`);
  }

  const weights = sample.map(cycle => cycleWeight(cycle, todayISO));
  const lengths = sample.map(cycle => cycle.length);
  const nEff = effectiveN(lengths, weights);
  const length = weightedMedian(lengths, weights);

  if (length === null || !(nEff > 0)) {
    return unavailable('baseline', 'every cycle is too old to carry weight');
  }

  // A weighted SD needs two effectively-weighted observations; when it cannot
  // be computed we say "no observed spread" rather than inventing one, and the
  // confidence term treats that as certainty within the window.
  const sigma = weightedSd(lengths, weights) ?? 0;

  // The anchor is the last pre-birth-control period start, which is the start
  // of the cycle following the last baseline cycle. `buildCycles` always
  // populates `nextStart`, so this is present for any cycle it produced -- but
  // falling back to `last.start` would move the anchor a full cycle early and
  // report a counterfactual wrong by ~28 days with nothing to signal it. A
  // missing anchor is a missing prediction, not a different one.
  const last = sample[sample.length - 1];
  const anchor = last.nextStart ?? null;
  if (anchor === null) {
    return unavailable('baseline', 'the last pre-birth-control cycle has no following period start');
  }

  // `available: true` with a `date` of `null` would be representable
  // otherwise, if `projectForward` hits its step cap. `available` must mean
  // "has a usable date", so that case is reported as unavailable instead.
  const date = projectForward(anchor, length, todayISO);
  if (date === null) {
    return unavailable('baseline', 'projection exceeded the step cap without reaching today');
  }

  // `suppressing` is always false here: nothing hypothetical can be "not
  // expected". A counterfactual cycle can only be upcoming or already passed,
  // so `late` is relabelled — calling the ghost "late" would imply the owner is
  // late when the statement is about a cycle that was never going to happen.
  const previousDate = projectPrevious(anchor, length, todayISO);
  const counterfactual = predictionStatus(previousDate, todayISO, false);

  return {
    available: true,
    model: 'baseline',
    date,
    length,
    sigma,
    confidence: confidencePercent(sigma, nEff),
    nEff,
    anchor,
    weight: null,
    previousDate,
    status: counterfactual.status === 'late' ? 'passed' : counterfactual.status,
    daysLate: counterfactual.daysLate,
    reason: null,
  };
}

export function adaptedModel(cycles, doc, todayISO) {
  const base = baselineModel(cycles, doc, todayISO);
  const episode = currentEpisode(doc, todayISO);
  const anchor = lastPeriodStart(doc) ?? base.anchor;

  // Not on any method: the natural-cycle model IS the prediction, just
  // re-anchored on the most recent period.
  if (episode === null) {
    if (!base.available) return { ...base, model: 'no-episode' };
    const noEpisodeDate = projectForward(anchor, base.length, todayISO);
    if (noEpisodeDate === null) {
      return unavailable('no-episode', 'projection exceeded the step cap without reaching today');
    }
    // Re-anchored, so the baseline's own previousDate no longer applies. No
    // method is in force, so absence is never "expected" — a period overdue off
    // birth control is simply late, and keeps counting.
    const nePrevious = projectPrevious(anchor, base.length, todayISO);
    // Counted from the due date so it keeps running; off birth control a period
    // overdue is simply late, and absence is never the expectation.
    const neStatus = predictionStatus(firstProjection(anchor, base.length), todayISO, false);
    return {
      ...base,
      model: 'no-episode',
      anchor,
      date: noEpisodeDate,
      weight: 0,
      previousDate: nePrevious,
      status: neStatus.status,
      daysLate: neStatus.daysLate,
    };
  }

  const sample = episodeCycles(cycles, doc, todayISO);
  const nP = sample.length;
  const w = nP / (nP + TAU);
  const sigmaMethod = sigmaForEffect(episode.expectedEffect);

  // With no baseline and fewer than two episode cycles there is nothing to
  // predict from at all.
  if (!base.available && nP < 2) {
    return unavailable('adapted', `no usable baseline, and only ${nP} cycle(s) on this method`);
  }

  let length;
  let sigmaBlend;
  let nEff;

  if (nP === 0) {
    // w is 0 here, so the episode term contributes nothing either way: today
    // `describeLengths([]).mean` is `null` and `0 * null === 0` by coercion, so
    // the else branch below would also yield the baseline length. This branch is
    // therefore defence in depth, not load-bearing -- kept because relying on
    // `0 * null === 0` is relying on a coercion quirk, and because the guard
    // keeps this correct if `describeLengths` ever returns NaN for an empty
    // sample instead. The test below pins that dependency contract so such a
    // change surfaces here rather than silently making this branch essential.
    length = base.length;
    sigmaBlend = base.sigma;
    nEff = base.nEff;
  } else {
    const stats = describeLengths(sample.map(cycle => cycle.length));
    const sigmaP = nP >= 2 ? (stats.sd ?? 0) : 0;
    if (base.available) {
      length = (1 - w) * base.length + w * stats.mean;
      sigmaBlend = (1 - w) * base.sigma + w * sigmaP;
      nEff = (1 - w) * base.nEff + w * nP;
    } else {
      length = stats.mean;
      sigmaBlend = sigmaP;
      nEff = nP;
    }
  }

  // The method prior is weighted by (1 - w), so uncertainty starts high and
  // shrinks only as the owner's own data on this method replaces it.
  const sigma = Math.sqrt(sigmaBlend ** 2 + (1 - w) * sigmaMethod ** 2);

  if (!Number.isFinite(length) || !Number.isFinite(sigma) || !(nEff > 0)) {
    return unavailable('adapted', 'not enough usable data to form a prediction');
  }

  // Same "available must mean has-a-date" guard as baselineModel.
  const adaptedDate = projectForward(anchor, length, todayISO);
  if (adaptedDate === null) {
    return unavailable('adapted', 'projection exceeded the step cap without reaching today');
  }

  // The episode is the one in force TODAY, resolved at the top of this function
  // by `currentEpisode(doc, todayISO)` — not the episode at the cycle's start.
  // A method begun mid-cycle would otherwise report "late" indefinitely.
  const previousDate = projectPrevious(anchor, length, todayISO);

  // A period logged inside the episode is evidence she is one of the roughly
  // one in five who keep bleeding on an implant. That closes the question
  // "will I bleed at all" for this episode, so the model returns to predicting
  // dates with the widened sigma rather than re-asserting absence after every
  // prediction. The anchor IS the most recent period start, so it sitting after
  // the episode began is exactly that evidence.
  const bledOnThisMethod = anchor > episode.startedOn;
  const suppressing = episode.expectedEffect === 'suppress' && !bledOnThisMethod;

  // Measured from the due date, not `previousDate` — see firstProjection.
  const { status, daysLate } = predictionStatus(
    firstProjection(anchor, length), todayISO, suppressing,
  );

  return {
    available: true,
    model: 'adapted',
    date: adaptedDate,
    length,
    sigma,
    confidence: confidencePercent(sigma, nEff),
    nEff,
    anchor,
    weight: w,
    previousDate,
    status,
    daysLate,
    reason: null,
  };
}

export function predict(cycles, doc, todayISO) {
  return {
    baseline: baselineModel(cycles, doc, todayISO),
    adapted: adaptedModel(cycles, doc, todayISO),
  };
}
