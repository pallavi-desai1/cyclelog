import { describe, it, expect } from 'vitest';
import {
  WEEKDAYS, MONTH_NAMES, MAX_PROJECTED, monthOf, shiftMonth, monthLabel, monthGrid,
  projectedDates, monthRange, yearsInRange, clampMonth,
} from '../src/calendar.js';
import { addDays } from '../src/dates.js';

const doc = (overrides = {}) => ({
  version: 1,
  days: {},
  spans: [],
  gaps: [],
  birthControl: [],
  ...overrides,
});

const flat = grid => grid.weeks.flat();
const cellFor = (grid, date) => flat(grid).find(cell => cell.date === date);

describe('month arithmetic', () => {
  it('takes the month from a date', () => {
    expect(monthOf('2015-03-26')).toBe('2015-03');
  });

  it('steps forward and back', () => {
    expect(shiftMonth('2015-03', 1)).toBe('2015-04');
    expect(shiftMonth('2015-03', -1)).toBe('2015-02');
  });

  it('crosses the year boundary in both directions', () => {
    expect(shiftMonth('2015-12', 1)).toBe('2016-01');
    expect(shiftMonth('2015-01', -1)).toBe('2014-12');
  });

  it('names the month for a human', () => {
    expect(monthLabel('2015-03')).toBe('March 2015');
    expect(monthLabel('2015-12')).toBe('December 2015');
  });

  it('starts the week on Sunday', () => {
    expect(WEEKDAYS[0]).toBe('Sun');
    expect(WEEKDAYS).toHaveLength(7);
  });
});

describe('the grid', () => {
  const grid = () => monthGrid(doc(), { month: '2015-03', todayISO: '2015-03-26' });

  it('is whole weeks of seven days', () => {
    for (const week of grid().weeks) expect(week).toHaveLength(7);
  });

  it('begins on the Sunday on or before the first of the month', () => {
    // 1 March 2015 was a Sunday, so that month begins exactly on the 1st.
    expect(grid().weeks[0][0].date).toBe('2015-03-01');
  });

  it('pads the leading days of a month that does not start on Sunday', () => {
    // 1 April 2015 was a Wednesday: the grid opens on Sunday 29 March.
    const april = monthGrid(doc(), { month: '2015-04', todayISO: '2015-04-01' });
    expect(april.weeks[0][0].date).toBe('2015-03-29');
    expect(april.weeks[0][0].inMonth).toBe(false);
    expect(april.weeks[0][3].date).toBe('2015-04-01');
    expect(april.weeks[0][3].inMonth).toBe(true);
  });

  it('runs to the Saturday on or after the last of the month', () => {
    const april = monthGrid(doc(), { month: '2015-04', todayISO: '2015-04-01' });
    const last = april.weeks[april.weeks.length - 1][6];
    expect(last.date).toBe('2015-05-02');
    expect(last.inMonth).toBe(false);
  });

  it('contains every day of the month exactly once', () => {
    const inMonth = flat(grid()).filter(cell => cell.inMonth).map(cell => cell.date);
    expect(inMonth).toHaveLength(31);
    expect(new Set(inMonth).size).toBe(31);
    expect(inMonth[0]).toBe('2015-03-01');
    expect(inMonth[30]).toBe('2015-03-31');
  });

  it('handles a leap February', () => {
    const february = monthGrid(doc(), { month: '2016-02', todayISO: '2016-02-01' });
    const inMonth = flat(february).filter(cell => cell.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[28].date).toBe('2016-02-29');
  });

  it('carries the day number for display', () => {
    expect(cellFor(grid(), '2015-03-26').day).toBe(26);
  });

  it('labels the month', () => {
    expect(grid().month).toBe('2015-03');
    expect(grid().label).toBe('March 2015');
  });

  it('marks today, and only today', () => {
    const marked = flat(grid()).filter(cell => cell.isToday);
    expect(marked.map(cell => cell.date)).toEqual(['2015-03-26']);
  });

  it('marks no day as today when today is in another month', () => {
    const february = monthGrid(doc(), { month: '2015-02', todayISO: '2015-03-26' });
    expect(flat(february).some(cell => cell.isToday)).toBe(false);
  });
});

describe('period days', () => {
  const withSpan = doc({
    spans: [{ start: '2015-03-26', end: '2015-03-30', source: 'test' }],
  });
  const grid = () => monthGrid(withSpan, { month: '2015-03', todayISO: '2015-03-26' });

  it('marks every day of a span, inclusive of both ends', () => {
    const bleeding = flat(grid()).filter(cell => cell.isPeriod).map(cell => cell.date);
    expect(bleeding).toEqual([
      '2015-03-26', '2015-03-27', '2015-03-28', '2015-03-29', '2015-03-30',
    ]);
  });

  it('marks only the start when a period has no logged end', () => {
    const open = doc({ spans: [{ start: '2015-03-26', end: null, source: 'test' }] });
    const marked = flat(monthGrid(open, { month: '2015-03', todayISO: '2015-03-26' }))
      .filter(cell => cell.isPeriod).map(cell => cell.date);
    expect(marked).toEqual(['2015-03-26']);
  });

  it('marks the part of a span that reaches into the next month', () => {
    const crossing = doc({ spans: [{ start: '2015-03-30', end: '2015-04-02', source: 'test' }] });
    const april = monthGrid(crossing, { month: '2015-04', todayISO: '2015-04-05' });
    const bleeding = flat(april).filter(cell => cell.isPeriod && cell.inMonth).map(cell => cell.date);
    expect(bleeding).toEqual(['2015-04-01', '2015-04-02']);
  });
});

describe('what was logged on a day', () => {
  const logged = doc({
    days: {
      '2015-03-26': { flow: 'heavy', spotting: null, pms: false },
      '2015-03-27': { flow: 'light', spotting: 'brown', pms: false },
      '2015-03-20': { flow: null, spotting: null, pms: true },
    },
  });
  const grid = () => monthGrid(logged, { month: '2015-03', todayISO: '2015-03-26' });

  it('carries flow intensity', () => {
    expect(cellFor(grid(), '2015-03-26').flow).toBe('heavy');
    expect(cellFor(grid(), '2015-03-27').flow).toBe('light');
  });

  it('carries spotting', () => {
    expect(cellFor(grid(), '2015-03-27').spotting).toBe('brown');
    expect(cellFor(grid(), '2015-03-26').spotting).toBeNull();
  });

  it('carries PMS', () => {
    expect(cellFor(grid(), '2015-03-20').pms).toBe(true);
    expect(cellFor(grid(), '2015-03-26').pms).toBe(false);
  });

  it('says whether anything was logged at all', () => {
    expect(cellFor(grid(), '2015-03-26').hasEntry).toBe(true);
    expect(cellFor(grid(), '2015-03-25').hasEntry).toBe(false);
  });

  it('leaves a day with no entry empty rather than undefined', () => {
    const empty = cellFor(grid(), '2015-03-25');
    expect(empty.flow).toBeNull();
    expect(empty.spotting).toBeNull();
    expect(empty.pms).toBe(false);
  });
});

describe('predictions on the grid', () => {
  const options = {
    month: '2015-04', todayISO: '2015-04-01',
    adaptedDate: '2015-04-23', baselineDates: ['2015-04-20'],
  };

  it('marks the adapted prediction', () => {
    const grid = monthGrid(doc(), options);
    expect(cellFor(grid, '2015-04-23').predicted).toBe(true);
    expect(cellFor(grid, '2015-04-22').predicted).toBe(false);
  });

  // The counterfactual is a separate mark, never the same one: §10.3 wants it
  // dashed against the adapted prediction's solid outline, so that the two are
  // distinguishable without relying on colour.
  it('marks the counterfactual separately', () => {
    const grid = monthGrid(doc(), options);
    expect(cellFor(grid, '2015-04-20').baseline).toBe(true);
    expect(cellFor(grid, '2015-04-20').predicted).toBe(false);
    expect(cellFor(grid, '2015-04-23').baseline).toBe(false);
  });

  it('marks both on one day when they coincide', () => {
    const grid = monthGrid(doc(), {
      ...options, adaptedDate: '2015-04-23', baselineDates: ['2015-04-23'],
    });
    const cell = cellFor(grid, '2015-04-23');
    expect(cell.predicted).toBe(true);
    expect(cell.baseline).toBe(true);
  });

  it('marks nothing when there is no prediction', () => {
    const grid = monthGrid(doc(), { month: '2015-04', todayISO: '2015-04-01' });
    expect(flat(grid).some(cell => cell.predicted || cell.baseline)).toBe(false);
  });

  it('shows a prediction that falls in the padding of another month', () => {
    const grid = monthGrid(doc(), {
      month: '2015-03', todayISO: '2015-03-26', adaptedDate: '2015-04-01',
    });
    const cell = cellFor(grid, '2015-04-01');
    expect(cell.inMonth).toBe(false);
    expect(cell.predicted).toBe(true);
  });
});

describe('projectedDates — the counterfactual cadence', () => {
  it('returns the ghost dates that fall inside a window', () => {
    // 28-day cadence anchored on 1 January.
    expect(projectedDates('2015-01-01', 28, '2015-01-01', '2015-03-31'))
      .toEqual(['2015-01-29', '2015-02-26', '2015-03-26']);
  });

  // The anchor is a period that actually happened. Marking it as a
  // counterfactual claims a prediction where there is an observation — and
  // on the calendar it drew a ghost on a day she really bled.
  it('never marks the anchor itself', () => {
    expect(projectedDates('2015-01-01', 28, '2015-01-01', '2015-03-31'))
      .not.toContain('2015-01-01');
  });

  it('starts one whole cycle after the anchor', () => {
    expect(projectedDates('2015-01-01', 28, '2015-01-01', '2015-12-31')[0])
      .toBe('2015-01-29');
  });

  it('includes a date on either boundary', () => {
    expect(projectedDates('2015-01-01', 28, '2015-01-29', '2015-02-26'))
      .toEqual(['2015-01-29', '2015-02-26']);
  });

  it('returns nothing for a window before the anchor', () => {
    expect(projectedDates('2015-06-01', 28, '2015-01-01', '2015-05-31')).toEqual([]);
  });

  it('returns nothing for a window between two occurrences', () => {
    expect(projectedDates('2015-01-01', 28, '2015-01-05', '2015-01-20')).toEqual([]);
  });

  // The bug this pins has been found twice in this codebase: rounding each
  // step and adding them accumulates error, while multiplying first and
  // rounding once does not. Over three years it is a fortnight adrift.
  it('multiplies before rounding, so it does not drift over years', () => {
    const dates = projectedDates('2015-01-01', 28.4, '2015-01-01', '2017-12-31');
    const accumulated = [];
    let walk = addDays('2015-01-01', Math.round(28.4));
    for (let i = 0; i < dates.length; i++) {
      accumulated.push(walk);
      walk = addDays(walk, Math.round(28.4));
    }
    expect(dates[dates.length - 1]).not.toBe(accumulated[accumulated.length - 1]);
    // The 38th occurrence sits at round(38 * 28.4) days from the anchor,
    // not at 38 additions of round(28.4).
    expect(dates[37]).toBe(addDays('2015-01-01', Math.round(38 * 28.4)));
  });

  it('refuses a length that is not a positive number', () => {
    expect(projectedDates('2015-01-01', 0, '2015-01-01', '2015-12-31')).toEqual([]);
    expect(projectedDates('2015-01-01', null, '2015-01-01', '2015-12-31')).toEqual([]);
  });

  it('refuses a missing anchor', () => {
    expect(projectedDates(null, 28, '2015-01-01', '2015-12-31')).toEqual([]);
  });

  it('stops at a cap rather than looping forever on a tiny length', () => {
    const dates = projectedDates('2015-01-01', 0.4, '2015-01-01', '2099-12-31');
    expect(dates.length).toBeLessThanOrEqual(MAX_PROJECTED);
  });
});

describe('the counterfactual across a whole month', () => {
  const grid = (baselineDates) => monthGrid(doc(), {
    month: '2015-03', todayISO: '2015-03-10', baselineDates,
  });

  it('marks every ghost date given, not just the next one', () => {
    const marked = flat(grid(['2015-03-05', '2015-03-26']))
      .filter(cell => cell.baseline).map(cell => cell.date);
    expect(marked).toEqual(['2015-03-05', '2015-03-26']);
  });

  it('marks none when the cadence is unknown', () => {
    expect(flat(grid([])).some(cell => cell.baseline)).toBe(false);
  });
});

describe('positive tests on the grid', () => {
  const tested = doc({
    days: {
      '2015-03-05': { tests: { ovulation: 'positive', pregnancy: null } },
      '2015-03-06': { tests: { ovulation: null, pregnancy: 'positive' } },
      '2015-03-07': { tests: { ovulation: 'negative', pregnancy: 'negative' } },
      '2015-03-08': { flow: 'light' },
    },
  });
  const grid = () => monthGrid(tested, { month: '2015-03', todayISO: '2015-03-10' });

  it('marks a positive ovulation test', () => {
    expect(cellFor(grid(), '2015-03-05').testPositive).toBe(true);
  });

  it('marks a positive pregnancy test', () => {
    expect(cellFor(grid(), '2015-03-06').testPositive).toBe(true);
  });

  it('does not mark a negative one', () => {
    expect(cellFor(grid(), '2015-03-07').testPositive).toBe(false);
  });

  it('does not mark a day with no test at all', () => {
    expect(cellFor(grid(), '2015-03-08').testPositive).toBe(false);
    expect(cellFor(grid(), '2015-03-09').testPositive).toBe(false);
  });
});

describe('the months worth offering', () => {
  const history = doc({
    spans: [
      { start: '2015-03-26', end: '2015-03-30', source: 'test' },
      { start: '2016-02-01', end: '2016-02-04', source: 'test' },
    ],
    days: { '2015-01-14': { flow: 'light' }, '2016-05-02': { pms: true } },
    birthControl: [{ startedOn: '2016-04-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }],
  });

  it('starts at the earliest month anything was recorded', () => {
    // The January day entry predates the March span.
    expect(monthRange(history, '2016-06-10').first).toBe('2015-01');
  });

  it('runs to a little past today, so the next prediction is reachable', () => {
    expect(monthRange(history, '2016-06-10').last).toBe('2016-08');
  });

  it('includes today even when it precedes everything recorded', () => {
    const future = doc({ spans: [{ start: '2016-02-01', end: null, source: 'test' }] });
    expect(monthRange(future, '2015-01-10').first).toBe('2015-01');
  });

  it('covers a document with nothing in it at all', () => {
    const range = monthRange(doc(), '2015-06-10');
    expect(range.first).toBe('2015-06');
    expect(range.last).toBe('2015-08');
  });

  it('lists every year in the range, inclusive', () => {
    expect(yearsInRange({ first: '2015-01', last: '2016-08' })).toEqual([2015, 2016]);
    expect(yearsInRange({ first: '2015-11', last: '2015-12' })).toEqual([2015]);
  });

  it('names the months for a human', () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe('January');
    expect(MONTH_NAMES[11]).toBe('December');
  });
});

describe('clampMonth', () => {
  const range = { first: '2015-01', last: '2016-08' };

  it('leaves a month inside the range alone', () => {
    expect(clampMonth('2015-07', range)).toBe('2015-07');
  });

  it('pulls a month before the range up to the first', () => {
    expect(clampMonth('2014-06', range)).toBe('2015-01');
  });

  it('pulls a month after the range down to the last', () => {
    expect(clampMonth('2017-01', range)).toBe('2016-08');
  });

  // Picking a month and a year separately can land outside the range — for
  // instance December of the final year when the range ends in August.
  it('handles the two-select combination that overshoots', () => {
    expect(clampMonth('2016-12', range)).toBe('2016-08');
  });
});
