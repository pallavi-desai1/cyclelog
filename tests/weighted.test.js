import { describe, it, expect } from 'vitest';
import {
  HALF_LIFE_DAYS, APPROX_WEIGHT,
  recencyWeight, cycleWeight, effectiveN,
  weightedMean, weightedMedian, weightedSd,
} from '../src/weighted.js';
import { describeLengths } from '../src/stats.js';

const cycle = (start, length, precision = 'exact') => ({ start, length, precision, excluded: false });

describe('recencyWeight', () => {
  it('weights the reference date itself at 1', () => {
    expect(recencyWeight('2016-01-01', '2016-01-01')).toBe(1);
  });

  it('halves the weight after one half-life', () => {
    // 2015-01-01 to 2016-07-02 is exactly 548 days.
    expect(recencyWeight('2015-01-01', '2016-07-02')).toBeCloseTo(0.5, 6);
  });

  it('quarters the weight after two half-lives', () => {
    // 2015-01-01 to 2016-12-31 is exactly 730 days, so at a 365-day half-life
    // this is two half-lives. The expectation is the literal 0.25 rather than
    // `0.5 ** (730/365)`, which would merely restate the implementation.
    expect(recencyWeight('2015-01-01', '2016-12-31', 365)).toBeCloseTo(0.25, 10);
  });

  it('decays monotonically with age', () => {
    const r = '2016-12-31';
    expect(recencyWeight('2016-12-01', r)).toBeGreaterThan(recencyWeight('2016-06-01', r));
  });

  it('never returns a weight above 1 for a future date', () => {
    expect(recencyWeight('2016-06-01', '2016-01-01')).toBe(1);
  });

  it('accepts a custom half-life', () => {
    expect(recencyWeight('2016-01-01', '2016-01-31', 30)).toBeCloseTo(0.5, 6);
  });
});

describe('cycleWeight', () => {
  it('multiplies recency by a full weight for an exact cycle', () => {
    expect(cycleWeight(cycle('2016-01-01', 28), '2016-01-01')).toBe(1);
  });

  // Asserts the literal 0.5, not APPROX_WEIGHT. Comparing against the module's
  // own exported constant would pass for any value of that constant, so it
  // could not catch a mis-wired multiply.
  it('halves the weight of an approximate cycle', () => {
    expect(cycleWeight(cycle('2016-01-01', 28, 'approx'), '2016-01-01')).toBe(0.5);
  });

  it('pins the approximate-date weight itself', () => {
    expect(APPROX_WEIGHT).toBe(0.5);
  });

  it('exposes the half-life it uses', () => {
    expect(HALF_LIFE_DAYS).toBe(548);
  });
});

describe('effectiveN', () => {
  it('sums the weights of usable observations', () => {
    expect(effectiveN([28, 29, 30], [1, 1, 0.5])).toBeCloseTo(2.5, 10);
  });

  it('is zero for an empty sample', () => {
    expect(effectiveN([], [])).toBe(0);
  });

  // nEff must describe the same sample as the statistic it is printed beside:
  // an observation the median and SD drop must not be counted here either.
  it('ignores the weight of a non-finite value', () => {
    expect(effectiveN([28, NaN, 30], [1, 1, 1])).toBe(2);
  });

  it('ignores negative weights', () => {
    expect(effectiveN([28, 29], [1, -5])).toBe(1);
  });
});

describe('weightedMean', () => {
  it('equals the plain mean when weights are equal', () => {
    expect(weightedMean([27, 28, 30], [1, 1, 1])).toBeCloseTo(28.3333, 4);
  });

  it('is pulled by a heavier observation', () => {
    expect(weightedMean([20, 30], [3, 1])).toBeCloseTo(22.5, 10);
  });

  it('returns null when the weights sum to zero', () => {
    expect(weightedMean([27, 28], [0, 0])).toBeNull();
  });

  // A zero weight is a no-op whether or not it is filtered, so only a negative
  // weight can tell `w > 0` apart from `w >= 0`.
  it('ignores a negative weight rather than subtracting it', () => {
    expect(weightedMean([20, 30], [-1, 1])).toBe(30);
  });

  it('returns null for an empty sample', () => {
    expect(weightedMean([], [])).toBeNull();
  });
});

describe('weightedMedian', () => {
  it('equals the plain median for equal weights, odd count', () => {
    expect(weightedMedian([27, 28, 30], [1, 1, 1])).toBe(28);
  });

  it('averages the middle pair for equal weights, even count', () => {
    expect(weightedMedian([26, 28, 30, 32], [1, 1, 1, 1])).toBe(29);
  });

  it('is order independent', () => {
    expect(weightedMedian([30, 27, 28], [1, 2, 3])).toBe(weightedMedian([28, 27, 30], [3, 2, 1]));
  });

  it('moves to the heavily weighted value', () => {
    expect(weightedMedian([21, 29], [9, 1])).toBe(21);
  });

  it('ignores zero-weighted observations', () => {
    expect(weightedMedian([21, 28, 35], [0, 1, 0])).toBe(28);
  });

  // Review Focus 3: every weight underflowing must not divide by zero.
  it('returns null when all weights are zero', () => {
    expect(weightedMedian([27, 28, 30], [0, 0, 0])).toBeNull();
  });

  it('returns null for an empty sample', () => {
    expect(weightedMedian([], [])).toBeNull();
  });

  it('returns the single value for a one-element sample', () => {
    expect(weightedMedian([28], [1])).toBe(28);
  });
});

describe('weightedSd', () => {
  // This is the property that keeps the weighted and unweighted paths honest:
  // with equal weights the reliability-weights estimator reduces exactly to the
  // n-1 sample SD that stats.js already computes.
  it('equals the unweighted sample SD when weights are equal', () => {
    const values = [27, 28, 30, 31];
    const plain = describeLengths(values).sd;
    expect(weightedSd(values, [1, 1, 1, 1])).toBeCloseTo(plain, 10);
    expect(weightedSd(values, [1, 1, 1, 1])).toBeCloseTo(1.8257, 4);
  });

  it('is unchanged by scaling every weight by the same factor', () => {
    const values = [27, 28, 30, 31];
    expect(weightedSd(values, [2, 2, 2, 2])).toBeCloseTo(weightedSd(values, [1, 1, 1, 1]), 10);
  });

  it('is zero when every value is identical', () => {
    expect(weightedSd([28, 28, 28], [1, 1, 1])).toBe(0);
  });

  it('returns null for a single observation', () => {
    expect(weightedSd([28], [1])).toBeNull();
  });

  // Not the denominator guard: pairs() strips the zero-weighted points first,
  // so this lands on the "fewer than two observations" branch. Labelled
  // accurately so nobody reads it as covering something it does not.
  it('returns null when only one observation carries any weight', () => {
    expect(weightedSd([27, 28, 30], [1, 0, 0])).toBeNull();
  });

  // Review Focus 3: the denominator V1 - V2/V1 is strictly positive for any two
  // finite positive weights, so the only way to reach the guard is float
  // cancellation at extreme magnitudes — where it must yield null, not
  // -Infinity leaking into a confidence percentage.
  it('returns null when extreme weight magnitudes cancel the denominator', () => {
    expect(weightedSd([27, 28], [1e300, 1])).toBeNull();
  });

  it('returns null when all weights are zero', () => {
    expect(weightedSd([27, 28, 30], [0, 0, 0])).toBeNull();
  });

  it('never returns NaN or Infinity across degenerate samples', () => {
    const samples = [[[], []], [[28], [1]], [[28, 28], [1, 1]], [[27, 28], [0, 0]], [[27, 28], [1, 0]]];
    for (const [values, weights] of samples) {
      for (const fn of [weightedMean, weightedMedian, weightedSd]) {
        const result = fn(values, weights);
        expect(Number.isNaN(result)).toBe(false);
        expect(result === Infinity || result === -Infinity).toBe(false);
      }
    }
  });
});
