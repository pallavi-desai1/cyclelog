import { describe, it, expect } from 'vitest';
import { erf, confidencePercent, WINDOW_DAYS, SUFFICIENCY_K } from '../src/confidence.js';

describe('erf', () => {
  // Reference values from standard tables; Abramowitz & Stegun 7.1.26 is
  // accurate to about 1.5e-7, so 6 decimal places is a fair bar.
  it('is zero at zero', () => {
    expect(erf(0)).toBeCloseTo(0, 10);
  });

  it('matches the table at 0.5', () => {
    expect(erf(0.5)).toBeCloseTo(0.5204999, 6);
  });

  it('matches the table at 1', () => {
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
  });

  it('matches the table at 2', () => {
    expect(erf(2)).toBeCloseTo(0.9953223, 6);
  });

  it('is odd', () => {
    expect(erf(-1)).toBeCloseTo(-erf(1), 10);
  });

  it('approaches 1 for large arguments', () => {
    expect(erf(6)).toBeCloseTo(1, 6);
  });

  it('never exceeds 1 in magnitude', () => {
    for (const x of [0.1, 1, 3, 10, 50]) {
      expect(Math.abs(erf(x))).toBeLessThanOrEqual(1);
    }
  });
});

describe('confidencePercent', () => {
  it('exposes the window and discount it uses', () => {
    expect(WINDOW_DAYS).toBe(2.5);
    expect(SUFFICIENCY_K).toBe(3);
  });

  it('returns an integer percentage', () => {
    const result = confidencePercent(3, 100);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('falls as the spread widens, with data held constant', () => {
    const tight = confidencePercent(1, 100);
    const loose = confidencePercent(8, 100);
    expect(tight).toBeGreaterThan(loose);
  });

  it('rises as data accumulates, with spread held constant', () => {
    const sparse = confidencePercent(3, 1);
    const rich = confidencePercent(3, 100);
    expect(rich).toBeGreaterThan(sparse);
  });

  it('is monotonic in the data-sufficiency discount', () => {
    const series = [0.5, 1, 3, 6, 12, 50].map(n => confidencePercent(3, n));
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    }
  });

  it('applies the discount as n/(n+3)', () => {
    // sigma tiny enough that erf saturates at 1, isolating the discount term
    expect(confidencePercent(0.0001, 3)).toBe(50);
    expect(confidencePercent(0.0001, 9)).toBe(75);
  });

  // Review Focus 2: identical cycle lengths make sigma zero, and sigma is a
  // divisor. The answer is certainty within the window, not NaN.
  it('treats zero spread as certainty within the window', () => {
    expect(confidencePercent(0, 100)).toBe(Math.round(100 * (100 / 103)));
  });

  it('treats a null spread as zero spread', () => {
    expect(confidencePercent(null, 100)).toBe(confidencePercent(0, 100));
  });

  it('returns null when there is no data at all', () => {
    expect(confidencePercent(3, 0)).toBeNull();
  });

  it('returns null for a negative effective sample size', () => {
    expect(confidencePercent(3, -1)).toBeNull();
  });

  it('stays within 0 and 100 across extreme inputs', () => {
    const inputs = [[0, 0.001], [0, 1e6], [1e6, 1e6], [0.0001, 1e6], [40, 2]];
    for (const [sigma, nEff] of inputs) {
      const result = confidencePercent(sigma, nEff);
      expect(result).not.toBeNull();
      expect(Number.isNaN(result)).toBe(false);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }
  });

  it('never returns NaN for a non-finite spread', () => {
    expect(Number.isNaN(confidencePercent(Infinity, 10))).toBe(false);
    expect(Number.isNaN(confidencePercent(NaN, 10))).toBe(false);
  });

  it('reports a wide spread with plenty of data as a low but non-zero number', () => {
    const result = confidencePercent(14, 50);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(25);
  });
});
