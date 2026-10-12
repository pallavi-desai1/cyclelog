import { describe, it, expect } from 'vitest';
import { describeLengths, cycleStats } from '../src/stats.js';

const cycle = (length, excluded = false) => ({ length, excluded });

describe('describeLengths', () => {
  it('describes an odd-sized sample', () => {
    expect(describeLengths([27, 28, 30])).toMatchObject({ n: 3, median: 28, min: 27, max: 30 });
  });

  it('averages the middle pair for an even-sized sample', () => {
    expect(describeLengths([26, 28, 30, 32]).median).toBe(29);
  });

  it('computes the mean', () => {
    expect(describeLengths([27, 28, 30]).mean).toBeCloseTo(28.3333, 3);
  });

  it('computes the sample standard deviation', () => {
    // mean 29, deviations -2,-1,1,2 → sum of squares 10, /3 → 3.3333, sqrt → 1.8257
    expect(describeLengths([27, 28, 30, 31]).sd).toBeCloseTo(1.8257, 3);
  });

  it('is order independent', () => {
    expect(describeLengths([30, 27, 28])).toEqual(describeLengths([27, 28, 30]));
  });

  // Review Focus 5: tiny samples must yield nulls, never NaN or Infinity.
  it('returns nulls for an empty sample', () => {
    expect(describeLengths([])).toEqual({ n: 0, mean: null, median: null, min: null, max: null, sd: null });
  });

  it('returns a null standard deviation for a single value', () => {
    expect(describeLengths([28])).toEqual({ n: 1, mean: 28, median: 28, min: 28, max: 28, sd: null });
  });

  it('never returns NaN', () => {
    for (const sample of [[], [28], [28, 28]]) {
      for (const value of Object.values(describeLengths(sample))) {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it('returns zero standard deviation for identical values', () => {
    expect(describeLengths([28, 28, 28]).sd).toBe(0);
  });
});

describe('cycleStats', () => {
  it('ignores excluded cycles and counts them', () => {
    const result = cycleStats([cycle(28), cycle(63, true), cycle(30)]);
    expect(result.all).toMatchObject({ n: 2, min: 28, max: 30 });
    expect(result.excludedCount).toBe(1);
  });

  it('restricts last12 to the twelve most recent included cycles', () => {
    const cycles = Array.from({ length: 20 }, (_, i) => cycle(20 + i));
    expect(cycleStats(cycles).last12).toMatchObject({ n: 12, min: 28, max: 39 });
  });

  it('makes last12 equal all when fewer than twelve cycles exist', () => {
    const result = cycleStats([cycle(28), cycle(30)]);
    expect(result.last12).toEqual(result.all);
  });

  // Review Focus 5: a filter that excludes everything must not blow up.
  it('handles every cycle being excluded', () => {
    const result = cycleStats([cycle(63, true)]);
    expect(result.all.n).toBe(0);
    expect(result.all.mean).toBeNull();
    expect(result.excludedCount).toBe(1);
  });

  it('handles no cycles at all', () => {
    expect(cycleStats([])).toMatchObject({ excludedCount: 0, all: { n: 0, mean: null } });
  });

  it('ignores cycles with a null length', () => {
    expect(cycleStats([{ length: null, excluded: false }, cycle(28)]).all.n).toBe(1);
  });

  // Finding 4b: a zero or negative cycle length is a symptom of duplicated
  // data (see merge.js's span dedup), not a real measurement, and must never
  // reach the mean. Defence in depth — the merge layer should prevent these
  // from existing at all.
  it('excludes zero-length and negative-length cycles from all', () => {
    const result = cycleStats([cycle(0), cycle(-3), cycle(28)]);
    expect(result.all.n).toBe(1);
    expect(result.all.mean).toBe(28);
  });
});
