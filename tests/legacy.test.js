import { describe, it, expect } from 'vitest';
import { parseLegacyLog } from '../src/importers/legacy.js';

describe('parseLegacyLog', () => {
  it('pairs an explicit-year start and stop into one span', () => {
    const { spans } = parseLegacyLog(`
      March 4th, 2015 - started
      March 9th, 2015 - stopped
    `);
    expect(spans).toEqual([{
      start: '2015-03-04', end: '2015-03-09',
      precision: 'exact', endPrecision: 'exact', source: 'legacy',
    }]);
  });

  it('carries the year forward when a line omits it', () => {
    const { spans } = parseLegacyLog(`
      March 4th, 2015 - started
      March 9th, 2015 - stopped

      April 6th - started
      April 11th - stopped
    `);
    expect(spans[1].start).toBe('2015-04-06');
    expect(spans[1].end).toBe('2015-04-11');
  });

  it('takes the year from a bare-year section header', () => {
    const { spans } = parseLegacyLog(`
      December 2nd, 2015 - started
      December 7th, 2015 - stopped

      2016

      January 8th - started
      January 13th - stopped
    `);
    expect(spans[1].start).toBe('2016-01-08');
  });

  it('rolls a month forward a year when dates would go backwards', () => {
    const { spans } = parseLegacyLog(`
      December 20th, 2015 - started
      December 25th, 2015 - stopped

      January 15th - started
      January 20th - stopped
    `);
    expect(spans[1].start).toBe('2016-01-15');
  });

  it('spans a start and stop that cross a month boundary', () => {
    const { spans } = parseLegacyLog(`
      2016

      January 29th - started
      February 3rd - stopped
    `);
    expect(spans[0]).toMatchObject({ start: '2016-01-29', end: '2016-02-03' });
  });

  it('treats the "stooped" typo as an end marker', () => {
    const { spans } = parseLegacyLog(`
      May 2nd, 2016 - started
      May 7th, 2016 - stooped
    `);
    expect(spans[0].end).toBe('2016-05-07');
  });

  it('flags (approx) on a start date', () => {
    const { spans } = parseLegacyLog(`
      June 3rd, 2016 (approx) - started
      June 8th, 2016 - stopped
    `);
    expect(spans[0].precision).toBe('approx');
    expect(spans[0].endPrecision).toBe('exact');
  });

  it('flags (approx.) and (est) as approximate', () => {
    const { spans } = parseLegacyLog(`
      July 1st, 2016 - started
      July 6th, 2016 (approx.) - stopped

      August 1st, 2016 - started
      August 6th, 2016 (est) - stopped
    `);
    expect(spans[0].endPrecision).toBe('approx');
    expect(spans[1].endPrecision).toBe('approx');
  });

  it('resolves a slashed two-day start to the later day, flagged approximate', () => {
    const { spans } = parseLegacyLog(`
      September 14th/15th, 2016 (midnight) - started
      September 19th, 2016 - stopped
    `);
    expect(spans[0].start).toBe('2016-09-15');
    expect(spans[0].precision).toBe('approx');
  });

  // The first dated entry must carry its own year, via an explicit year or a
  // preceding section header. Inferring one backwards from a later line is a
  // guess that can be a full year wrong, so the parser warns instead. This test
  // exists to stop anyone adding such a guess.
  it('warns rather than guessing when the first date has no year anywhere', () => {
    const { spans, warnings } = parseLegacyLog(`
      September 14th - started
      September 19th - stopped
    `);
    expect(spans).toEqual([]);
    expect(warnings.join(' ')).toMatch(/no year available/i);
  });

  // Review Focus 4: a span with no end must survive, not swallow the next start.
  it('leaves the end null when the stop date is unknown', () => {
    const { spans, warnings } = parseLegacyLog(`
      October 2nd, 2016 - started
      Unknown stop date

      November 1st, 2016 - started
      November 6th, 2016 - stopped
    `);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: '2016-10-02', end: null, endPrecision: null });
    expect(spans[1]).toMatchObject({ start: '2016-11-01', end: '2016-11-06' });
    expect(warnings.join(' ')).toMatch(/unknown stop date/i);
  });

  it('records a gap from "<Month> - not logged"', () => {
    const { gaps } = parseLegacyLog(`
      2016

      February - not logged
    `);
    expect(gaps).toEqual([{ from: '2016-02-01', to: '2016-02-29', reason: 'not logged' }]);
  });

  it('records a gap from "No dates logged for <Month>"', () => {
    const { gaps } = parseLegacyLog(`
      2017

      No dates logged for December
    `);
    expect(gaps).toEqual([{ from: '2017-12-01', to: '2017-12-31', reason: 'not logged' }]);
  });

  it('ignores the heading lines and blank lines', () => {
    const { spans, gaps, warnings } = parseLegacyLog(`
      Tracking
      Period

      March 4th, 2015 - started
      March 9th, 2015 - stopped
    `);
    expect(spans).toHaveLength(1);
    expect(gaps).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('returns empty results for empty input', () => {
    expect(parseLegacyLog('')).toEqual({ spans: [], gaps: [], warnings: [] });
  });

  it('warns about an end with no preceding start', () => {
    const { spans, warnings } = parseLegacyLog('April 3rd, 2016 - stopped');
    expect(spans).toEqual([]);
    expect(warnings.join(' ')).toMatch(/without a start/i);
  });

  // Finding 10: these two warning branches had no covering test, while every
  // other warning path did. An untested warning branch is an untested
  // announcement of data loss.
  it('warns when a gap line names no month', () => {
    const { gaps, warnings } = parseLegacyLog(`
      2016

      not logged
    `);
    expect(gaps).toEqual([]);
    expect(warnings.join(' ')).toMatch(/could not place gap line/i);
  });

  it('warns when a start/stop line carries no parseable date', () => {
    const { spans, warnings } = parseLegacyLog('started');
    expect(spans).toEqual([]);
    expect(warnings.join(' ')).toMatch(/could not parse a date from/i);
  });

  // Finding 7: gap lines and date lines used two different year-resolution
  // rules. Once a date line has rolled lastYear past sectionYear, a
  // following gap line resolved with `sectionYear ?? lastYear` would land in
  // the earlier (wrong) year, silently excusing the wrong cycle from the
  // average. Gap lines now resolve the year the same way date lines do.
  it('places a gap line in the rolled-forward year, not the stale section year', () => {
    const { gaps, warnings } = parseLegacyLog(`
      2015

      December 20th - started
      December 25th - stopped

      2016

      January 15th - started
      January 20th - stopped

      February - not logged
    `);
    expect(gaps).toEqual([{ from: '2016-02-01', to: '2016-02-29', reason: 'not logged' }]);
    expect(warnings.join(' ')).not.toMatch(/ambiguous/i);
  });

  it('warns when a gap line\'s section year and rolled-forward year disagree', () => {
    const { gaps, warnings } = parseLegacyLog(`
      2015

      December 20th - started
      December 25th - stopped

      January 15th - started
      January 20th - stopped

      2015

      February - not logged
    `);
    expect(gaps).toEqual([{ from: '2016-02-01', to: '2016-02-29', reason: 'not logged' }]);
    expect(warnings.join(' ')).toMatch(/ambiguous year for gap line/i);
    expect(warnings.join(' ')).toMatch(/2015/);
    expect(warnings.join(' ')).toMatch(/2016/);
  });
});
