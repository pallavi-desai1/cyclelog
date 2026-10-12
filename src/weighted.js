import { diffDays } from './dates.js';

// 18 months. Long enough that nine years of history still informs the model,
// short enough that a pattern which has measurably shortened is respected.
export const HALF_LIFE_DAYS = 548;

// Dates the owner herself marked "approx" in the original log count for half.
export const APPROX_WEIGHT = 0.5;

export function recencyWeight(iso, referenceISO, halfLifeDays = HALF_LIFE_DAYS) {
  const age = diffDays(iso, referenceISO);
  if (age <= 0) return 1;
  return 0.5 ** (age / halfLifeDays);
}

export function cycleWeight(cycle, referenceISO, halfLifeDays = HALF_LIFE_DAYS) {
  const recency = recencyWeight(cycle.start, referenceISO, halfLifeDays);
  const precision = cycle.precision === 'approx' ? APPROX_WEIGHT : 1;
  return recency * precision;
}

function pairs(values, weights) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    const w = weights[i];
    if (Number.isFinite(v) && Number.isFinite(w) && w > 0) out.push({ v, w });
  }
  return out;
}

// Takes values as well as weights, and filters through the same `pairs()` the
// statistics use. Summing weights alone would count an observation whose value
// is non-finite — so nEff would claim a larger sample than the median or SD it
// is reported beside, and the confidence percentage would be overstated.
export function effectiveN(values, weights) {
  return pairs(values, weights).reduce((total, x) => total + x.w, 0);
}

export function weightedMean(values, weights) {
  const p = pairs(values, weights);
  const total = p.reduce((t, x) => t + x.w, 0);
  if (total <= 0) return null;
  return p.reduce((t, x) => t + x.v * x.w, 0) / total;
}

export function weightedMedian(values, weights) {
  const p = pairs(values, weights).sort((a, b) => a.v - b.v);
  const total = p.reduce((t, x) => t + x.w, 0);
  if (total <= 0) return null;

  const half = total / 2;
  let cumulative = 0;
  for (let i = 0; i < p.length; i += 1) {
    cumulative += p[i].w;
    if (cumulative > half) return p[i].v;
    // Exactly half the mass sits at or below this value: average it with the
    // next, mirroring how an even-sized unweighted median behaves.
    if (cumulative === half) {
      const next = p[i + 1];
      // Unreachable in practice: cumulative only equals half at the final index
      // when the total is zero, which the guard above already rejects. Kept as a
      // defensive fallback because an undefined index here would return NaN, and
      // nothing in this project may return NaN.
      return next ? (p[i].v + next.v) / 2 : p[i].v;
    }
  }
  return p[p.length - 1].v;
}

export function weightedSd(values, weights) {
  const p = pairs(values, weights);
  if (p.length < 2) return null;

  const v1 = p.reduce((t, x) => t + x.w, 0);
  const v2 = p.reduce((t, x) => t + x.w * x.w, 0);
  if (v1 <= 0) return null;

  // Unbiased variance for reliability weights. With equal weights the
  // denominator becomes n - 1, so this reduces exactly to the sample SD in
  // stats.js — which is the property its test pins.
  const denominator = v1 - v2 / v1;
  if (!(denominator > 0)) return null;

  const mean = p.reduce((t, x) => t + x.v * x.w, 0) / v1;
  const sumSquares = p.reduce((t, x) => t + x.w * (x.v - mean) ** 2, 0);
  const variance = sumSquares / denominator;
  if (!Number.isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance);
}
