import { describe, it, expect } from 'vitest';
import { periodStartsDuringEpisodes, divergenceSeries, meanShift } from '../src/divergence.js';

const span = (start) => ({ start, end: null, precision: 'exact', endPrecision: null, source: 'clue' });
const episode = (method, startedOn, endedOn = null) => ({ method, startedOn, endedOn, expectedEffect: 'suppress' });
const doc = (overrides = {}) => ({ version: 1, birthControl: [], days: {}, spans: [], gaps: [], ...overrides });

const baseline = { available: true, anchor: '2015-12-01', length: 28 };

describe('periodStartsDuringEpisodes', () => {
  it('returns only starts on or after an episode began, in order', () => {
    const d = doc({
      spans: [span('2015-11-01'), span('2016-01-05'), span('2016-02-10')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    expect(periodStartsDuringEpisodes(d).map(x => x.start)).toEqual(['2016-01-05', '2016-02-10']);
  });

  it('labels each start with the method in force at the transition', () => {
    const d = doc({
      spans: [span('2016-06-01'), span('2016-06-02')],
      birthControl: [episode('pill', '2016-01-01', '2016-06-01'), episode('implant', '2016-06-02')],
    });
    expect(periodStartsDuringEpisodes(d).map(x => x.method)).toEqual(['pill', 'implant']);
  });

  it('sorts unsorted spans', () => {
    const d = doc({
      spans: [span('2016-02-10'), span('2016-01-05')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    expect(periodStartsDuringEpisodes(d).map(x => x.start)).toEqual(['2016-01-05', '2016-02-10']);
  });

  it('excludes a start that falls in a gap between episodes', () => {
    const d = doc({
      spans: [span('2016-03-15')],
      birthControl: [episode('pill', '2016-01-01', '2016-02-01')],
    });
    expect(periodStartsDuringEpisodes(d)).toEqual([]);
  });

  it('returns an empty array with no episodes', () => {
    expect(periodStartsDuringEpisodes(doc({ spans: [span('2016-01-05')] }))).toEqual([]);
  });
});

describe('divergenceSeries', () => {
  it('pairs each actual start with the nth baseline projection', () => {
    const d = doc({
      spans: [span('2015-12-01'), span('2016-01-05'), span('2016-02-10')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    const series = divergenceSeries(d, baseline);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ index: 1, actual: '2016-01-05', baseline: '2015-12-29' });
    expect(series[1]).toMatchObject({ index: 2, actual: '2016-02-10', baseline: '2016-01-26' });
  });

  it('reports a positive delta when the period came later than the baseline', () => {
    const d = doc({ spans: [span('2016-01-05')], birthControl: [episode('implant', '2016-01-01')] });
    // baseline projection 1 is 2015-12-29; actual is 7 days later
    expect(divergenceSeries(d, baseline)[0].delta).toBe(7);
  });

  it('reports a negative delta when the period came earlier', () => {
    const d = doc({ spans: [span('2015-12-20')], birthControl: [episode('implant', '2015-12-15')] });
    expect(divergenceSeries(d, baseline)[0].delta).toBe(-9);
  });

  it('reports zero when the period arrived exactly on the baseline', () => {
    const d = doc({ spans: [span('2015-12-29')], birthControl: [episode('implant', '2015-12-15')] });
    expect(divergenceSeries(d, baseline)[0].delta).toBe(0);
  });

  it('returns an empty series when the baseline is unavailable', () => {
    const d = doc({ spans: [span('2016-01-05')], birthControl: [episode('implant', '2016-01-01')] });
    expect(divergenceSeries(d, { available: false, anchor: null, length: null })).toEqual([]);
  });

  it('returns an empty series when nothing has been logged on a method', () => {
    expect(divergenceSeries(doc(), baseline)).toEqual([]);
  });

  // Multiply-then-round, not round-then-multiply. At a length of 28.5 the two
  // agree on the first projection and diverge from the second onward: rounding
  // the step first gives 2016-01-28, which is a day adrift, and six days adrift
  // by the twelfth cycle.
  it('projects a fractional length without accumulating drift', () => {
    const d = doc({
      spans: [span('2015-12-01'), span('2016-01-05'), span('2016-02-10')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    const series = divergenceSeries(d, { available: true, anchor: '2015-12-01', length: 28.5 });
    expect(series.map(p => p.baseline)).toEqual(['2015-12-30', '2016-01-27']);
  });

  // A break in methods must not shift a later episode's projections. Numbering
  // restarts per episode and each anchors on the last period before it began,
  // so the natural period inside the gap is excluded and the implant's first
  // row is measured from it rather than from the frozen baseline anchor.
  it('restarts numbering and re-anchors after a gap between episodes', () => {
    const d = doc({
      spans: [span('2015-05-01'), span('2015-07-05'), span('2015-10-01'), span('2016-02-01')],
      birthControl: [
        episode('pill', '2015-06-01', '2015-08-31'),
        episode('implant', '2016-01-01'),
      ],
    });
    const series = divergenceSeries(d, baseline);
    expect(series.map(p => p.actual)).toEqual(['2015-07-05', '2016-02-01']);
    expect(series.map(p => p.index)).toEqual([1, 1]);
    expect(series.map(p => p.baseline)).toEqual(['2015-05-29', '2015-10-29']);
    expect(series.map(p => p.delta)).toEqual([37, 95]);
  });

  it('never produces NaN deltas', () => {
    const d = doc({
      spans: [span('2016-01-05'), span('2016-02-10')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    for (const point of divergenceSeries(d, baseline)) {
      expect(Number.isNaN(point.delta)).toBe(false);
    }
  });
});

describe('meanShift', () => {
  it('averages the deltas', () => {
    expect(meanShift([{ delta: 4 }, { delta: 6 }, { delta: 8 }])).toBe(6);
  });

  it('handles negative and positive deltas together', () => {
    expect(meanShift([{ delta: -3 }, { delta: 3 }])).toBe(0);
  });

  it('returns null for an empty series', () => {
    expect(meanShift([])).toBeNull();
  });

  it('never returns NaN', () => {
    expect(Number.isNaN(meanShift([]))).toBe(false);
  });
});
