import { describe, it, expect } from 'vitest';
import { parseISO, toISO, addDays, diffDays, lastDayOfMonth, pad2 } from '../src/dates.js';

describe('dates', () => {
  it('round-trips an ISO date', () => {
    expect(toISO(parseISO('2026-03-15'))).toBe('2026-03-15');
  });

  it('adds a day across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('adds a day across a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('subtracts days with a negative offset', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('diffs days across a year boundary', () => {
    expect(diffDays('2016-11-16', '2017-01-06')).toBe(51);
  });

  it('returns a negative diff when the second date precedes the first', () => {
    expect(diffDays('2017-01-06', '2016-11-16')).toBe(-51);
  });

  // Review Focus 1. These three tests assert against UTC ground truth rather
  // than round-tripping. Round-trip assertions are useless here: a local-time
  // implementation is local-in/local-out and so round-trips perfectly, while
  // Math.round() absorbs the hour lost to DST. Each test below fails against an
  // implementation built on new Date(y, m, d) + getFullYear/getMonth/getDate.
  //
  // `withTZ` pins the timezone and asserts the pin took effect — without that
  // guard, a runner that ignores process.env.TZ would make these tests pass
  // vacuously and we would never know.
  const withTZ = (tz, assertions) => {
    const original = process.env.TZ;
    process.env.TZ = tz;
    try {
      expect(new Date(Date.UTC(2026, 2, 15)).getHours()).not.toBe(0);
      assertions();
    } finally {
      process.env.TZ = original;
    }
  };

  it('parses to UTC midnight exactly, not local midnight', () => {
    withTZ('America/Los_Angeles', () => {
      expect(parseISO('2026-03-15')).toBe(Date.UTC(2026, 2, 15));
    });
  });

  it('formats a timestamp by its UTC date, not its local date', () => {
    withTZ('America/Los_Angeles', () => {
      // UTC midnight on 15 March is the afternoon of 14 March in Los Angeles,
      // so a local-time formatter returns '2026-03-14' here.
      expect(toISO(Date.UTC(2026, 2, 15))).toBe('2026-03-15');
    });
  });

  it('keeps a whole-day difference whole across a DST transition', () => {
    // DST begins 8 March 2026 in Los Angeles, so 7 to 9 March spans 47 local
    // hours. The epoch assertion is what catches it: diffDays alone cannot,
    // because Math.round(47/24) is also 2.
    withTZ('America/Los_Angeles', () => {
      expect(parseISO('2026-03-09') - parseISO('2026-03-07')).toBe(2 * 86400000);
      expect(diffDays('2026-03-07', '2026-03-09')).toBe(2);
      expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    });
  });

  it('rejects a malformed date rather than returning NaN', () => {
    expect(() => parseISO('15/03/2026')).toThrow(TypeError);
    expect(() => parseISO('2026-3-15')).toThrow(TypeError);
  });

  // Finding 5: parseISO validated the YYYY-MM-DD shape but not the calendar.
  // Date.UTC silently rolls an impossible date forward (30 Feb becomes 2
  // March), so the string sorts lexicographically as February while every
  // arithmetic result behaves as March — exactly the kind of disagreement
  // that must throw instead of propagating.
  it('rejects a calendar-impossible date like February 30th', () => {
    expect(() => parseISO('2026-02-30')).toThrow(TypeError);
  });

  it('rejects a calendar-impossible month', () => {
    expect(() => parseISO('2026-13-01')).toThrow(TypeError);
  });

  it('accepts a real leap day', () => {
    expect(() => parseISO('2024-02-29')).not.toThrow();
  });

  it('returns the last day of a short month', () => {
    expect(lastDayOfMonth(2021, 2)).toBe('2021-02-28');
  });

  it('returns the last day of a leap February', () => {
    expect(lastDayOfMonth(2024, 2)).toBe('2024-02-29');
  });

  it('returns the last day of December', () => {
    expect(lastDayOfMonth(2021, 12)).toBe('2021-12-31');
  });

  it('pads single digits to two characters', () => {
    expect(pad2(3)).toBe('03');
    expect(pad2(12)).toBe('12');
  });
});
