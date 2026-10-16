import { describe, it, expect } from 'vitest';
import { dayLabel, dayDetail } from '../src/day.js';

const doc = (overrides = {}) => ({
  version: 1, days: {}, spans: [], gaps: [], birthControl: [], ...overrides,
});

const HISTORY = doc({
  spans: [
    { start: '2015-01-01', end: '2015-01-05', source: 'test' },
    { start: '2015-01-29', end: null, source: 'test' },
    { start: '2015-02-26', end: '2015-03-02', source: 'test' },
  ],
  days: {
    '2015-01-02': {
      flow: 'heavy', cramps: 'strong', spotting: null, pms: false,
      mood: ['sad', 'anxious'], discharge: null,
      tests: { ovulation: null, pregnancy: null }, pain: ['headache'],
      notes: 'rough day', source: 'clue', precision: 'exact',
    },
    '2015-01-20': {
      flow: null, cramps: null, spotting: 'brown', pms: true,
      mood: [], discharge: 'creamy',
      tests: { ovulation: 'positive', pregnancy: 'negative' }, pain: [],
      notes: '', source: 'legacy', precision: 'approx',
    },
  },
  birthControl: [
    { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
  ],
});

const on = (date, options = {}) => dayDetail(HISTORY, date, {
  todayISO: '2015-03-10', ...options,
});

describe('dayLabel', () => {
  it('writes a date a person would say out loud', () => {
    expect(dayLabel('2015-03-26')).toBe('26 March 2015');
  });

  it('does not pad the day number', () => {
    expect(dayLabel('2015-03-05')).toBe('5 March 2015');
  });
});

describe('where the day sits in the cycle', () => {
  it('counts from the period that started it', () => {
    const detail = on('2015-01-03');
    expect(detail.cycleStart).toBe('2015-01-01');
    expect(detail.cycleDay).toBe(3);
  });

  it('calls the first day of a period day one', () => {
    expect(on('2015-01-01').cycleDay).toBe(1);
  });

  it('keeps counting through a long cycle', () => {
    // 26 Feb started the current cycle; 10 March is day 13 of it.
    expect(on('2015-03-10').cycleDay).toBe(13);
  });

  it('has no cycle day before the first period ever logged', () => {
    const detail = on('2014-12-20');
    expect(detail.cycleStart).toBeNull();
    expect(detail.cycleDay).toBeNull();
  });

  it('counts a future day from the last period, since that is still known', () => {
    const detail = on('2015-03-20');
    expect(detail.cycleStart).toBe('2015-02-26');
    expect(detail.cycleDay).toBe(23);
    expect(detail.isFuture).toBe(true);
  });

  it('marks today', () => {
    expect(on('2015-03-10').isToday).toBe(true);
    expect(on('2015-03-09').isToday).toBe(false);
    expect(on('2015-03-09').isFuture).toBe(false);
  });
});

describe('bleeding days', () => {
  it('knows a day inside a period, and which day of it', () => {
    const detail = on('2015-01-03');
    expect(detail.isPeriod).toBe(true);
    expect(detail.periodDay).toBe(3);
  });

  it('knows a day outside any period', () => {
    const detail = on('2015-01-20');
    expect(detail.isPeriod).toBe(false);
    expect(detail.periodDay).toBeNull();
  });

  it('treats a period with no logged end as one day', () => {
    expect(on('2015-01-29').isPeriod).toBe(true);
    expect(on('2015-01-30').isPeriod).toBe(false);
  });
});

describe('what was logged', () => {
  it('lists only the fields that hold something', () => {
    const labels = on('2015-01-02').logged.map(item => item.label);
    expect(labels).toEqual(['Flow', 'Cramps', 'Mood', 'Pain', 'Notes']);
  });

  it('reads the values back', () => {
    const logged = Object.fromEntries(
      on('2015-01-02').logged.map(item => [item.label, item.value]),
    );
    expect(logged.Flow).toBe('heavy');
    expect(logged.Cramps).toBe('strong');
    expect(logged.Mood).toBe('sad, anxious');
    expect(logged.Pain).toBe('headache');
    expect(logged.Notes).toBe('rough day');
  });

  it('lists spotting, PMS, discharge and test results', () => {
    const logged = Object.fromEntries(
      on('2015-01-20').logged.map(item => [item.label, item.value]),
    );
    expect(logged.Spotting).toBe('brown');
    expect(logged.PMS).toBe('yes');
    expect(logged.Discharge).toBe('creamy');
    expect(logged['Ovulation test']).toBe('positive');
    expect(logged['Pregnancy test']).toBe('negative');
  });

  it('is empty for a day with no entry', () => {
    const detail = on('2015-01-15');
    expect(detail.logged).toEqual([]);
    expect(detail.hasEntry).toBe(false);
  });

  it('says where an entry came from', () => {
    expect(on('2015-01-02').source).toBe('clue');
    expect(on('2015-01-15').source).toBeNull();
  });

  // Spec §10.1: imported entries are marked, and approximate dates say so.
  it('flags an approximate date', () => {
    expect(on('2015-01-20').isApproximate).toBe(true);
    expect(on('2015-01-02').isApproximate).toBe(false);
  });
});

describe('context for the day', () => {
  it('names the birth control in force that day', () => {
    expect(on('2015-03-10').method).toEqual({ method: 'pill', startedOn: '2015-02-01' });
  });

  it('has no method before the first episode', () => {
    expect(on('2015-01-02').method).toBeNull();
  });

  it('marks the day a period is expected', () => {
    const detail = on('2015-03-26', { adaptedDate: '2015-03-26' });
    expect(detail.predicted).toBe(true);
    expect(on('2015-03-26').predicted).toBe(false);
  });

  it('marks the counterfactual day separately', () => {
    const detail = on('2015-03-24', { baselineDate: '2015-03-24' });
    expect(detail.baseline).toBe(true);
    expect(detail.predicted).toBe(false);
  });

  it('carries the date and its label', () => {
    const detail = on('2015-03-10');
    expect(detail.date).toBe('2015-03-10');
    expect(detail.label).toBe('10 March 2015');
  });
});
