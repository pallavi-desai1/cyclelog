import { describe, it, expect } from 'vitest';
import {
  SIGMA_BY_EFFECT, sortedEpisodes, firstEpisode, currentEpisode,
  sigmaForEffect, usableCycles, baselineCycles, episodeCycles, naturalCycles,
} from '../src/episodes.js';

const cycle = (start, length, extra = {}) => ({
  start, length, precision: 'exact', excluded: false, ...extra,
});
const episode = (method, startedOn, endedOn = null, expectedEffect = 'suppress') =>
  ({ method, startedOn, endedOn, expectedEffect });
const doc = (overrides = {}) => ({ version: 1, birthControl: [], days: {}, spans: [], gaps: [], ...overrides });

describe('sigmaForEffect', () => {
  it('maps the three documented effects', () => {
    expect(sigmaForEffect('suppress')).toBe(7);
    expect(sigmaForEffect('regulate')).toBe(3);
    expect(sigmaForEffect('none')).toBe(0);
    expect(SIGMA_BY_EFFECT.suppress).toBe(7);
  });

  // An unrecognised method should widen the spread, not narrow it: a wider
  // prior lowers confidence, which is the honest direction when we do not know
  // how a method behaves.
  it('falls back to the most conservative prior for an unknown effect', () => {
    expect(sigmaForEffect('something-new')).toBe(7);
    expect(sigmaForEffect(undefined)).toBe(7);
  });
});

describe('sortedEpisodes and firstEpisode', () => {
  it('sorts episodes by start date regardless of input order', () => {
    const d = doc({ birthControl: [episode('implant', '2016-06-01'), episode('pill', '2015-01-01')] });
    expect(sortedEpisodes(d).map(e => e.method)).toEqual(['pill', 'implant']);
    expect(firstEpisode(d).method).toBe('pill');
  });

  it('returns null when there are no episodes', () => {
    expect(firstEpisode(doc())).toBeNull();
    expect(sortedEpisodes(doc())).toEqual([]);
  });

  it('does not mutate the document', () => {
    const d = doc({ birthControl: [episode('implant', '2016-06-01'), episode('pill', '2015-01-01')] });
    sortedEpisodes(d);
    expect(d.birthControl[0].method).toBe('implant');
  });
});

describe('currentEpisode', () => {
  const d = doc({
    birthControl: [episode('pill', '2015-01-01', '2015-12-31', 'regulate'), episode('implant', '2016-06-01')],
  });

  it('finds the episode in force', () => {
    expect(currentEpisode(d, '2015-06-01').method).toBe('pill');
    expect(currentEpisode(d, '2016-07-01').method).toBe('implant');
  });

  it('returns null before any episode and between episodes', () => {
    expect(currentEpisode(d, '2014-01-01')).toBeNull();
    expect(currentEpisode(d, '2016-03-01')).toBeNull();
  });
});

describe('usableCycles', () => {
  it('keeps only complete, non-excluded, positive-length cycles', () => {
    const input = [
      cycle('2015-01-01', 28),
      cycle('2015-02-01', 63, { excluded: true }),
      cycle('2015-03-01', null),
      cycle('2015-04-01', 0),
      cycle('2015-05-01', -5),
      cycle('2015-06-01', 29),
    ];
    expect(usableCycles(input).map(c => c.start)).toEqual(['2015-01-01', '2015-06-01']);
  });

  it('returns an empty array for no cycles', () => {
    expect(usableCycles([])).toEqual([]);
  });
});

describe('baselineCycles', () => {
  // nextStart on the pre-episode cycles matters now: the whole cycle, not just
  // its start, must precede the first episode -- see baselineCycles' own
  // comment in src/episodes.js.
  const cycles = [
    cycle('2015-01-01', 28, { nextStart: '2015-02-01' }),
    cycle('2015-02-01', 30, { nextStart: '2015-03-03' }),
    cycle('2016-07-01', 40), // during the implant episode
  ];

  it('returns only cycles starting before the first episode', () => {
    const d = doc({ birthControl: [episode('implant', '2016-06-01')] });
    expect(baselineCycles(cycles, d).map(c => c.start)).toEqual(['2015-01-01', '2015-02-01']);
  });

  it('returns every usable cycle when there has never been an episode', () => {
    expect(baselineCycles(cycles, doc())).toHaveLength(3);
  });

  it('is frozen at the FIRST episode, not the current one', () => {
    const d = doc({
      birthControl: [episode('pill', '2015-06-01', '2015-12-31', 'regulate'), episode('implant', '2016-06-01')],
    });
    // 2016-01-01 is what makes this test discriminate. It falls after the pill
    // ended and before the implant began, so filtering on the FIRST episode
    // excludes it while filtering on the CURRENT episode would wrongly include
    // it. Without this cycle both rules return the same two cycles — every
    // other fixture here postdates both episode starts — and the test would
    // pass against an implementation that uses the wrong episode entirely.
    const spanningGap = [...cycles, cycle('2016-01-01', 29)];
    expect(baselineCycles(spanningGap, d).map(c => c.start)).toEqual(['2015-01-01', '2015-02-01']);
  });

  it('excludes gap-flagged cycles even when they predate the episode', () => {
    const d = doc({ birthControl: [episode('implant', '2016-06-01')] });
    const withExcluded = [...cycles, cycle('2015-03-01', 63, { excluded: true })];
    expect(baselineCycles(withExcluded, d).some(c => c.excluded)).toBe(false);
  });

  it('returns an empty array when the first episode predates all cycles', () => {
    const d = doc({ birthControl: [episode('implant', '2014-01-01')] });
    expect(baselineCycles(cycles, d)).toEqual([]);
  });
});

describe('episodeCycles', () => {
  const cycles = [
    cycle('2015-01-01', 28),
    cycle('2016-07-01', 40),
    cycle('2016-08-15', 45),
  ];

  it('returns cycles starting within the current episode', () => {
    const d = doc({ birthControl: [episode('implant', '2016-06-01')] });
    expect(episodeCycles(cycles, d, '2016-10-01').map(c => c.start)).toEqual(['2016-07-01', '2016-08-15']);
  });

  it('returns an empty array when no episode is in force', () => {
    expect(episodeCycles(cycles, doc(), '2016-10-01')).toEqual([]);
  });

  // Review Focus 4: the first weeks of a new episode have no cycles yet, and
  // that is the normal case, not an edge case.
  it('returns an empty array for an episode with no cycles yet', () => {
    const d = doc({ birthControl: [episode('implant', '2016-09-01')] });
    expect(episodeCycles(cycles, d, '2016-09-10')).toEqual([]);
  });

  it('includes a cycle starting exactly on the episode start date', () => {
    const d = doc({ birthControl: [episode('implant', '2016-07-01')] });
    expect(episodeCycles(cycles, d, '2016-10-01').map(c => c.start)).toEqual(['2016-07-01', '2016-08-15']);
  });

  // The upper boundary needs a CLOSED episode to be testable at all. Without
  // this, every fixture uses the open-ended implant and a mutant filtering
  // `cycle.start < end` instead of `<= end` passes the whole suite. Today the
  // owner has one open episode — but the episode model exists to survive a
  // method change, which is precisely when closed windows appear.
  it('includes a cycle starting exactly on the episode end date', () => {
    const d = doc({ birthControl: [episode('pill', '2015-01-01', '2016-07-01', 'regulate')] });
    expect(episodeCycles(cycles, d, '2016-07-01').map(c => c.start))
      .toEqual(['2015-01-01', '2016-07-01']);
  });

  it('excludes a cycle starting the day after the episode ended', () => {
    const d = doc({ birthControl: [episode('pill', '2015-01-01', '2016-06-30', 'regulate')] });
    expect(episodeCycles(cycles, d, '2016-06-30').map(c => c.start)).toEqual(['2015-01-01']);
  });

  it('counts only the current episode, not an earlier one', () => {
    const d = doc({
      birthControl: [episode('pill', '2015-01-01', '2015-06-30', 'regulate'), episode('implant', '2016-06-01')],
    });
    expect(episodeCycles(cycles, d, '2016-10-01').map(c => c.start)).toEqual(['2016-07-01', '2016-08-15']);
  });
});

it('firstEpisode skips a no-method row recorded before any real method', () => {
  const d = { birthControl: [
    { method: 'nothing', startedOn: '2015-01-01', endedOn: '2015-05-01', expectedEffect: 'none' },
    { method: 'implant', startedOn: '2015-05-01', endedOn: null, expectedEffect: 'suppress' },
  ] };
  expect(firstEpisode(d).method).toBe('implant');
});

describe('naturalCycles', () => {
  const bc = { birthControl: [
    { method: 'implant', startedOn: '2015-06-01', endedOn: '2015-07-15', expectedEffect: 'suppress' },
    { method: 'nothing', startedOn: '2015-07-15', endedOn: null, expectedEffect: 'none' },
  ] };
  const cyc = [
    { start: '2015-04-20', nextStart: '2015-05-20', length: 30 },
    { start: '2015-05-20', nextStart: '2015-06-18', length: 29 }, // straddles the implant going in
    { start: '2015-06-18', nextStart: '2015-07-20', length: 32 }, // wholly on the implant
    { start: '2015-07-20', nextStart: '2015-08-18', length: 29 }, // after it came out
  ];
  const one = (extra) => ({ birthControl: [{ method: 'pill', startedOn: '2015-01-01', endedOn: null, expectedEffect: 'regulate', ...extra }] });

  it('keeps only cycles no hormonal method touches at any point', () => {
    expect(naturalCycles(cyc, bc).map(c => c.start)).toEqual(['2015-04-20', '2015-07-20']);
  });

  it('keeps every cycle when no method was ever recorded', () => {
    expect(naturalCycles(cyc, {}).map(c => c.start)).toEqual(cyc.map(c => c.start));
  });

  it('ignores a no-method row entirely', () => {
    const only = { birthControl: [{ method: 'nothing', startedOn: '2015-01-01', endedOn: null, expectedEffect: 'none' }] };
    expect(naturalCycles(cyc, only)).toHaveLength(4);
  });

  it('keeps a cycle under a method with no hormonal effect', () => {
    const condoms = { birthControl: [{ method: 'condoms', startedOn: '2015-01-01', endedOn: null, expectedEffect: 'none' }] };
    expect(naturalCycles(cyc, condoms)).toHaveLength(4);
  });

  it('drops a cycle a hormonal method touches but does not contain', () => {
    const brief = { birthControl: [{ method: 'pill', startedOn: '2015-05-25', endedOn: '2015-05-26', expectedEffect: 'regulate' }] };
    expect(naturalCycles(cyc, brief).map(c => c.start)).not.toContain('2015-05-20');
  });

  it('excludes unusable cycles, as the other samples do', () => {
    const excluded = [{ start: '2015-04-20', nextStart: '2015-05-20', length: 30, excluded: true }];
    expect(naturalCycles(excluded, {})).toEqual([]);
  });

  it('treats an unrecognised or missing effect as hormonal', () => {
    expect(naturalCycles(cyc, one({ expectedEffect: 'mystery' }))).toEqual([]);
    expect(naturalCycles(cyc, one({ expectedEffect: undefined }))).toEqual([]);
  });

  it('counts an episode ending on the cycle start day as touching it', () => {
    const d = one({ startedOn: '2015-03-01', endedOn: '2015-04-20' });
    expect(naturalCycles(cyc, d).map(c => c.start)).not.toContain('2015-04-20');
  });

  it('counts an episode starting on the cycle nextStart day as touching it', () => {
    const d = one({ startedOn: '2015-05-20', endedOn: '2015-05-21' });
    expect(naturalCycles(cyc, d).map(c => c.start)).not.toContain('2015-04-20');
  });
});
