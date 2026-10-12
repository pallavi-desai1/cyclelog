import { describe, it, expect } from 'vitest';
import { deriveSpans } from '../src/spans.js';
import { blankDay } from '../src/importers/clue.js';

const day = (source, extra = {}) => ({ ...blankDay(source), flow: 'light', ...extra });

describe('deriveSpans', () => {
  it('derives clue as the source when every contributing day is clue', () => {
    const days = {
      '2016-01-01': day('clue'),
      '2016-01-02': day('clue'),
    };
    const spans = deriveSpans(days);
    expect(spans).toMatchObject([{ start: '2016-01-01', end: '2016-01-02', source: 'clue' }]);
  });

  it('derives manual when contributing days disagree on source', () => {
    const days = {
      '2016-01-01': day('legacy'),
      '2016-01-02': day('clue'),
    };
    const spans = deriveSpans(days);
    expect(spans).toMatchObject([{ start: '2016-01-01', end: '2016-01-02', source: 'manual' }]);
  });

  it('marks a span approximate when any contributing day is approximate', () => {
    const days = {
      '2016-01-01': day('legacy', { precision: 'exact' }),
      '2016-01-02': day('legacy', { precision: 'approx' }),
    };
    const spans = deriveSpans(days);
    expect(spans).toMatchObject([{ start: '2016-01-01', end: '2016-01-02', precision: 'approx', endPrecision: 'approx' }]);
  });

  it('keeps a span exact when every contributing day is exact', () => {
    const days = {
      '2016-01-01': day('clue', { precision: 'exact' }),
      '2016-01-02': day('clue', { precision: 'exact' }),
    };
    const spans = deriveSpans(days);
    expect(spans[0].precision).toBe('exact');
  });

  it('returns no spans for no days', () => {
    expect(deriveSpans({})).toEqual([]);
  });
});
