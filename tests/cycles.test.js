import { describe, it, expect } from 'vitest';
import { buildCycles, currentCycle, episodeAt } from '../src/cycles.js';
import { blankDay } from '../src/importers/clue.js';

const span = (start, end, extra = {}) => ({
  start, end, precision: 'exact', endPrecision: 'exact', source: 'clue', ...extra,
});

const doc = (overrides = {}) => ({
  version: 1, birthControl: [], days: {}, spans: [], gaps: [], ...overrides,
});

describe('buildCycles', () => {
  it('computes length from one start to the next', () => {
    const cycles = buildCycles(doc({ spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')] }));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ start: '2016-01-01', nextStart: '2016-01-29', length: 28 });
  });

  it('reports period length from the span itself', () => {
    const cycles = buildCycles(doc({ spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')] }));
    expect(cycles[0].periodLength).toBe(4);
  });

  it('returns no cycles for a single span', () => {
    expect(buildCycles(doc({ spans: [span('2016-01-01', '2016-01-04')] }))).toEqual([]);
  });

  it('returns no cycles for no spans', () => {
    expect(buildCycles(doc())).toEqual([]);
  });

  it('orders cycles chronologically even when spans arrive unsorted', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-03-01', '2016-03-04'), span('2016-01-01', '2016-01-04'), span('2016-02-01', '2016-02-04')],
    }));
    expect(cycles.map(c => c.start)).toEqual(['2016-01-01', '2016-02-01']);
  });

  it('excludes a cycle whose interval overlaps a gap', () => {
    const cycles = buildCycles(doc({
      spans: [span('2015-12-11', '2015-12-15'), span('2016-02-12', '2016-02-16'), span('2016-03-14', '2016-03-18')],
      gaps: [{ from: '2016-01-01', to: '2016-01-31', reason: 'not logged' }],
    }));
    expect(cycles[0]).toMatchObject({ start: '2015-12-11', length: 63, excluded: true });
    expect(cycles[0].excludedReason).toMatch(/not logged/);
    expect(cycles[1]).toMatchObject({ start: '2016-02-12', excluded: false, excludedReason: null });
  });

  it('does not exclude a cycle that merely sits after a gap', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-02-12', '2016-02-16'), span('2016-03-14', '2016-03-18')],
      gaps: [{ from: '2016-01-01', to: '2016-01-31', reason: 'not logged' }],
    }));
    expect(cycles[0].excluded).toBe(false);
  });

  // The four tests below pin the exact boundary equalities in the overlap rule.
  // Without them, mutating `<=`/`>=` to strict `<`/`>` passes the whole suite,
  // because no other fixture lands on a boundary — and this is the rule that
  // decides which cycles count toward every average and prediction.
  const twoSpans = { spans: [span('2016-02-12', '2016-02-16'), span('2016-03-14', '2016-03-18')] };
  const gapOf = (from, to) => [{ from, to, reason: 'not logged' }];

  it('excludes a cycle when a gap ends exactly on its start', () => {
    const cycles = buildCycles(doc({ ...twoSpans, gaps: gapOf('2016-01-01', '2016-02-12') }));
    expect(cycles[0].excluded).toBe(true);
  });

  it('does not exclude when a gap ends the day before its start', () => {
    const cycles = buildCycles(doc({ ...twoSpans, gaps: gapOf('2016-01-01', '2016-02-11') }));
    expect(cycles[0].excluded).toBe(false);
  });

  it('excludes a cycle when a gap begins exactly on the next start', () => {
    const cycles = buildCycles(doc({ ...twoSpans, gaps: gapOf('2016-03-14', '2016-03-20') }));
    expect(cycles[0].excluded).toBe(true);
  });

  it('does not exclude when a gap begins the day after the next start', () => {
    const cycles = buildCycles(doc({ ...twoSpans, gaps: gapOf('2016-03-15', '2016-03-20') }));
    expect(cycles[0].excluded).toBe(false);
  });

  // Review Focus 4: a span with no end must not produce NaN or a negative length.
  it('handles a span with no end date', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-01-01', null, { endPrecision: null }), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0].periodLength).toBeNull();
    expect(cycles[0].length).toBe(28);
    expect(Number.isNaN(cycles[0].length)).toBe(false);
  });

  it('marks a cycle approximate when either boundary is approximate', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-01-01', '2016-01-04', { precision: 'approx' }), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0].precision).toBe('approx');
  });

  it('attaches the birth-control method in force at the cycle start', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01'), span('2016-02-26', '2016-03-01')],
      birthControl: [{ method: 'implant', startedOn: '2016-01-15', endedOn: null, expectedEffect: 'suppress' }],
    }));
    expect(cycles[0].episodeMethod).toBeNull();
    expect(cycles[1].episodeMethod).toBe('implant');
  });

  it('summarises symptoms within the cycle window only', () => {
    const days = {
      '2016-01-01': { ...blankDay('clue'), flow: 'light', cramps: 'severe' },
      '2016-01-02': { ...blankDay('clue'), flow: 'heavy', cramps: 'mild', pms: true },
      '2016-01-20': { ...blankDay('clue'), spotting: 'brown', pms: true },
      '2016-01-29': { ...blankDay('clue'), flow: 'medium', cramps: 'severe' },
    };
    const cycles = buildCycles(doc({
      days, spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0]).toMatchObject({ peakFlow: 'heavy', crampDays: 2, pmsDays: 2, spottingDays: 1 });
  });

  it('does not count cramps recorded as none', () => {
    const days = { '2016-01-01': { ...blankDay('clue'), flow: 'light', cramps: 'none' } };
    const cycles = buildCycles(doc({ days, spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')] }));
    expect(cycles[0].crampDays).toBe(0);
  });

  // Finding 3: periodEndPrecision must be carried onto the cycle so an
  // approximate legacy end date (exact start, guessed end) stays visible even
  // though the cycle's own `precision` (start-to-start) is exact.
  it('carries an approximate period end without affecting cycle precision', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-01-01', '2016-01-04', { endPrecision: 'approx' }), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0].periodEndPrecision).toBe('approx');
    expect(cycles[0].precision).toBe('exact');
  });

  it('reports a null periodEndPrecision when the span has no end', () => {
    const cycles = buildCycles(doc({
      spans: [span('2016-01-01', null, { endPrecision: null }), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0].periodEndPrecision).toBeNull();
  });

  // Finding 9: an unranked flow value must not stick as peakFlow and block a
  // later heavy day from displacing it.
  it('lets a ranked flow value displace an unranked one', () => {
    const days = {
      '2016-01-01': { ...blankDay('clue'), flow: 'spotting_only' },
      '2016-01-02': { ...blankDay('clue'), flow: 'heavy' },
    };
    const cycles = buildCycles(doc({
      days, spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')],
    }));
    expect(cycles[0].peakFlow).toBe('heavy');
  });
});

describe('currentCycle', () => {
  it('reports the day of the cycle in progress', () => {
    const result = currentCycle(doc({ spans: [span('2016-01-01', '2016-01-04'), span('2016-01-29', '2016-02-01')] }), '2016-02-05');
    expect(result).toMatchObject({ start: '2016-01-29', dayOfCycle: 8, periodLength: 4 });
  });

  it('reports day 1 on the start date itself', () => {
    const result = currentCycle(doc({ spans: [span('2016-01-29', '2016-02-01')] }), '2016-01-29');
    expect(result.dayOfCycle).toBe(1);
  });

  it('returns null when there are no spans', () => {
    expect(currentCycle(doc(), '2016-02-05')).toBeNull();
  });

  // Review Focus 4: the period in progress has no end date yet.
  it('handles a period still in progress', () => {
    const result = currentCycle(doc({ spans: [span('2016-01-29', null, { endPrecision: null })] }), '2016-01-31');
    expect(result).toMatchObject({ periodEnd: null, periodLength: null, dayOfCycle: 3 });
  });

  // Finding 2: currentCycle describes *now*, not the period's start. A
  // birth-control episode started after the last logged period must still be
  // reported as the method in force today.
  it('reports a birth-control episode that started after the last period', () => {
    const result = currentCycle(doc({
      spans: [span('2016-01-01', '2016-01-04')],
      birthControl: [{ method: 'implant', startedOn: '2016-01-10', endedOn: null, expectedEffect: 'suppress' }],
    }), '2016-01-20');
    expect(result.episodeMethod).toBe('implant');
  });

  // Finding 3: periodEndPrecision belongs on CurrentCycle too.
  it('carries periodEndPrecision on the current cycle', () => {
    const result = currentCycle(doc({ spans: [span('2016-01-29', '2016-02-01', { endPrecision: 'approx' })] }), '2016-02-02');
    expect(result.periodEndPrecision).toBe('approx');
  });
});

describe('episodeAt', () => {
  const withEpisodes = doc({
    birthControl: [
      { method: 'pill', startedOn: '2015-01-01', endedOn: '2015-12-31', expectedEffect: 'regulate' },
      { method: 'implant', startedOn: '2016-06-01', endedOn: null, expectedEffect: 'suppress' },
    ],
  });

  it('finds the episode containing a date', () => {
    expect(episodeAt(withEpisodes, '2015-06-01').method).toBe('pill');
    expect(episodeAt(withEpisodes, '2016-07-01').method).toBe('implant');
  });

  it('returns null between and before episodes', () => {
    expect(episodeAt(withEpisodes, '2014-01-01')).toBeNull();
    expect(episodeAt(withEpisodes, '2016-03-01')).toBeNull();
  });

  it('includes the boundary dates', () => {
    expect(episodeAt(withEpisodes, '2015-01-01').method).toBe('pill');
    expect(episodeAt(withEpisodes, '2015-12-31').method).toBe('pill');
  });
});
