// The prediction is "within +/- 2 days", continuity-corrected to 2.5 so the
// window covers whole days either side of the predicted date.
export const WINDOW_DAYS = 2.5;

// Discount factor n/(n+k): with k = 3, three effective cycles buy half credit.
export const SUFFICIENCY_K = 3;

// Abramowitz & Stegun 7.1.26. JavaScript has no built-in erf; this
// approximation is accurate to about 1.5e-7, far beyond what a percentage
// rounded to a whole number needs.
export function erf(x) {
  // erf(0) = 0 is an exact identity, but the approximation below returns about
  // 1e-9 there — small enough to be harmless and large enough to look like a
  // bug to anyone who prints it. Short-circuit so the identity holds exactly.
  if (x === 0) return 0;
  // NaN is neither > 0 nor < 0, so `x > 0 ? 1 : -1` would silently return -1
  // for it -- a wrong number that happens to satisfy the no-NaN rule rather
  // than a correct one. ±Infinity really is ±1 mathematically, so only NaN is
  // rejected here.
  if (Number.isNaN(x)) throw new TypeError('erf requires a number, got NaN');
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-z * z));
}

export function confidencePercent(sigma, nEff, windowDays = WINDOW_DAYS, k = SUFFICIENCY_K) {
  if (!Number.isFinite(nEff) || nEff <= 0) return null;

  const sufficiency = nEff / (nEff + k);

  // A zero or unknown spread means the model sees no variation at all, so the
  // probability of landing inside the window is 1. Dividing by it would give
  // Infinity, and erf(Infinity) is 1 anyway — short-circuit rather than rely on
  // that. A non-finite spread is treated as no information: probability 0.
  let p;
  if (sigma === null || sigma === undefined || sigma === 0) p = 1;
  else if (!Number.isFinite(sigma)) p = 0;
  else p = erf(windowDays / (Math.abs(sigma) * Math.SQRT2));

  const percent = Math.round(100 * p * sufficiency);
  // The clamp is defensive twice over: p and sufficiency are both within [0,1]
  // so the product cannot leave [0,100], but Math.max also normalises a
  // theoretical -0 to 0, which the project's no-negative-zero rule requires.
  return Math.min(100, Math.max(0, percent));
}
