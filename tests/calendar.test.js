import { describe, it, expect } from 'vitest';
import { WEEKDAYS, monthOf, shiftMonth, monthLabel, monthGrid } from '../src/calendar.js';

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
    adaptedDate: '2015-04-23', baselineDate: '2015-04-20',
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
      ...options, adaptedDate: '2015-04-23', baselineDate: '2015-04-23',
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
