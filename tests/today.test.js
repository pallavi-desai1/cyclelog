import { describe, it, expect } from 'vitest';
import { localToday } from '../src/today.js';

describe('localToday', () => {
  it('uses local calendar parts, not UTC', () => {
    // 2015-03-26 21:30 local. toISOString() would say the 27th anywhere east
    // of UTC+2:30, and dating a cycle a day off shifts every figure on the
    // summary card.
    const evening = new Date(2015, 2, 26, 21, 30);
    expect(localToday(evening)).toBe('2015-03-26');
  });

  it('pads single-digit months and days', () => {
    expect(localToday(new Date(2015, 0, 5))).toBe('2015-01-05');
  });

  it('handles the last day of a month', () => {
    expect(localToday(new Date(2015, 11, 31, 23, 59))).toBe('2015-12-31');
  });

  it('defaults to now and returns a well-formed date', () => {
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
