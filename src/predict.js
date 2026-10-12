import { addDays } from './dates.js';
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
  reason,
});

export function lastPeriodStart(doc) {
  const spans = [...(doc.spans ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  return spans.length > 0 ? spans[spans.length - 1].start : null;
}

export function projectForward(anchorISO, lengthDays, todayISO, maxSteps = MAX_PROJECTIONS) {
  if (!anchorISO) return null;
  if (!Number.isFinite(lengthDays)) return null;
  const step = Math.round(lengthDays);
  if (!(step > 0)) return null;

  let date = addDays(anchorISO, step);
  let steps = 1;
  while (date < todayISO) {
    if (steps >= maxSteps) return null;
    date = addDays(date, step);
    steps += 1;
  }
  return date;
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
  // of the cycle following the last baseline cycle.
  const last = sample[sample.length - 1];
  const anchor = last.nextStart ?? last.start;

  return {
    available: true,
    model: 'baseline',
    date: projectForward(anchor, length, todayISO),
    length,
    sigma,
    confidence: confidencePercent(sigma, nEff),
    nEff,
    anchor,
    weight: null,
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
    return {
      ...base,
      model: 'no-episode',
      anchor,
      date: projectForward(anchor, base.length, todayISO),
      weight: 0,
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
    // w is 0 here, so the episode term contributes nothing. Short-circuit
    // rather than computing 0 * mean-of-nothing, which would be 0 * NaN = NaN.
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

  return {
    available: true,
    model: 'adapted',
    date: projectForward(anchor, length, todayISO),
    length,
    sigma,
    confidence: confidencePercent(sigma, nEff),
    nEff,
    anchor,
    weight: w,
    reason: null,
  };
}

export function predict(cycles, doc, todayISO) {
  return {
    baseline: baselineModel(cycles, doc, todayISO),
    adapted: adaptedModel(cycles, doc, todayISO),
  };
}
