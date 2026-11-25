import { describe, it, expect } from 'vitest';
import { diffDays } from '../src/dates.js';
import {
  LUTEAL_DAYS, WINDOW_DAYS, DESCENT_POSITION,
  descentFor, windowFor, firstPositiveTest, applyTestOverride,
} from '../src/phase.js';

const diffInclusive = (a, b) => diffDays(a, b) + 1;

describe('constants', () => {
  it('pins the owner’s numbers', () => {
    expect(LUTEAL_DAYS).toBe(14);
    expect(WINDOW_DAYS).toBe(6);
    expect(DESCENT_POSITION).toBe(5);
  });
});

describe('descentFor', () => {
  it('counts back a fixed luteal phase from the next period start', () => {
    expect(descentFor('2015-03-29')).toBe('2015-03-15');
  });
});

describe('windowFor', () => {
  it('puts descent on the fifth of six days', () => {
    const w = windowFor('2015-03-15', '2015-03-01');
    expect(w).toEqual({ from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16' });
    expect(diffInclusive(w.from, w.to)).toBe(WINDOW_DAYS);
    expect(diffInclusive(w.from, w.descent)).toBe(DESCENT_POSITION);
  });

  it('omits the window when descent lands on or before the cycle start', () => {
    // A 14-day cycle: 2015-03-15 minus 14 is the cycle’s own start.
    expect(windowFor(descentFor('2015-03-15'), '2015-03-01')).toBeNull();
  });

  it('clamps the window’s start to the cycle start rather than reaching into the previous cycle', () => {
    // A 15-day cycle: descent is day 2, so descent - 4 precedes the cycle.
    const w = windowFor(descentFor('2015-03-16'), '2015-03-01');
    expect(w).toEqual({ from: '2015-03-01', descent: '2015-03-02', to: '2015-03-03' });
  });
});

describe('firstPositiveTest', () => {
  const doc = { days: {
    '2015-03-05': { tests: { ovulation: 'negative' } },
    '2015-03-20': { tests: { ovulation: 'positive' } },
    '2015-03-24': { tests: { ovulation: 'positive' } },
    '2015-04-02': { tests: { ovulation: 'positive' } },
  } };

  it('finds the earliest positive inside the cycle, the surge', () => {
    expect(firstPositiveTest(doc, '2015-03-01', '2015-03-29')).toBe('2015-03-20');
  });

  it('excludes the next cycle’s start from the search', () => {
    expect(firstPositiveTest(doc, '2015-03-29', '2015-04-26')).toBe('2015-04-02');
  });

  it('does not count a positive on the next cycle’s own start day', () => {
    const edge = { days: { '2015-03-29': { tests: { ovulation: 'positive' } } } };
    expect(firstPositiveTest(edge, '2015-03-01', '2015-03-29')).toBeNull();
    expect(firstPositiveTest(edge, '2015-03-29', '2015-04-26')).toBe('2015-03-29');
  });

  it('ignores a negative result', () => {
    expect(firstPositiveTest(doc, '2015-03-01', '2015-03-10')).toBeNull();
  });

  it('tolerates a document with no days at all', () => {
    expect(firstPositiveTest({}, '2015-03-01', '2015-03-29')).toBeNull();
    expect(firstPositiveTest({ days: undefined }, '2015-03-01', '2015-03-29')).toBeNull();
  });
});

describe('applyTestOverride', () => {
  const w = { from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16' };

  it('leaves the window alone when the test falls inside it', () => {
    expect(applyTestOverride(w, '2015-03-13', '2015-03-01')).toEqual({ ...w, fromTest: false });
  });

  it('leaves the window alone on its first and last day', () => {
    expect(applyTestOverride(w, '2015-03-11', '2015-03-01').fromTest).toBe(false);
    expect(applyTestOverride(w, '2015-03-16', '2015-03-01').fromTest).toBe(false);
  });

  it('recentres on the test date when it falls outside', () => {
    expect(applyTestOverride(w, '2015-03-22', '2015-03-01')).toEqual({
      from: '2015-03-18', descent: '2015-03-22', to: '2015-03-23', fromTest: true,
    });
  });

  it('reports no override when there is no test', () => {
    expect(applyTestOverride(w, null, '2015-03-01')).toEqual({ ...w, fromTest: false });
  });
});
