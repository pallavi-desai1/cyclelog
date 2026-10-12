import { describe, it, expect } from 'vitest';
import {
  TAU, lastPeriodStart, projectForward, baselineModel, adaptedModel, predict,
} from '../src/predict.js';
import { describeLengths } from '../src/stats.js';

const span = (start, end) => ({ start, end, precision: 'exact', endPrecision: 'exact', source: 'clue' });
const cycle = (start, length, extra = {}) => ({
  start, length, precision: 'exact', excluded: false, ...extra,
});
const episode = (method, startedOn, endedOn = null, expectedEffect = 'suppress') =>
  ({ method, startedOn, endedOn, expectedEffect });
const doc = (overrides = {}) => ({ version: 1, birthControl: [], days: {}, spans: [], gaps: [], ...overrides });

// Twelve 28-day cycles through 2015, written out so every expected value below
// is a literal rather than something recomputed from the implementation. The
// last cycle's nextStart (2015-12-03) is the last pre-birth-control period
// start, which is what the baseline anchors on.
const REGULAR_STARTS = [
  '2015-01-01', '2015-01-29', '2015-02-26', '2015-03-26', '2015-04-23', '2015-05-21',
  '2015-06-18', '2015-07-16', '2015-08-13', '2015-09-10', '2015-10-08', '2015-11-05',
];
const LAST_BASELINE_NEXT_START = '2015-12-03';

const regularCycles = REGULAR_STARTS.map((start, i) => ({
  ...cycle(start, 28),
  nextStart: REGULAR_STARTS[i + 1] ?? LAST_BASELINE_NEXT_START,
}));

describe('constants', () => {
  // Pinned as a bare literal. The w = n/(n+TAU) test below builds its
  // expectation from this export, so it would survive TAU itself being wrong.
  it('uses a prior weight of three cycles', () => {
    expect(TAU).toBe(3);
  });
});

describe('lastPeriodStart', () => {
  it('returns the latest span start regardless of input order', () => {
    const d = doc({ spans: [span('2015-03-01', '2015-03-04'), span('2015-01-01', '2015-01-04')] });
    expect(lastPeriodStart(d)).toBe('2015-03-01');
  });

  it('returns null when there are no spans', () => {
    expect(lastPeriodStart(doc())).toBeNull();
  });
});

describe('projectForward', () => {
  it('advances to the first date on or after today', () => {
    expect(projectForward('2015-01-01', 28, '2015-02-10')).toBe('2015-02-26');
  });

  it('returns the anchor plus one length when today is the anchor', () => {
    expect(projectForward('2015-01-01', 28, '2015-01-01')).toBe('2015-01-29');
  });

  it('rounds a fractional length to whole days', () => {
    expect(projectForward('2015-01-01', 28.4, '2015-01-15')).toBe('2015-01-29');
  });

  it('projects across a long gap without drifting', () => {
    // 2015-01-01 plus 13 * 28 days
    expect(projectForward('2015-01-01', 28, '2015-12-01')).toBe('2015-12-03');
  });

  // Review Focus 5: a non-positive or non-finite length must not spin forever.
  it('returns null for a non-positive length', () => {
    expect(projectForward('2015-01-01', 0, '2015-06-01')).toBeNull();
    expect(projectForward('2015-01-01', -5, '2015-06-01')).toBeNull();
  });

  it('returns null for a non-finite length', () => {
    expect(projectForward('2015-01-01', NaN, '2015-06-01')).toBeNull();
    expect(projectForward('2015-01-01', Infinity, '2015-06-01')).toBeNull();
  });

  it('returns null for a missing anchor', () => {
    expect(projectForward(null, 28, '2015-06-01')).toBeNull();
  });

  it('gives up rather than looping past the step cap', () => {
    expect(projectForward('2015-01-01', 1, '2015-06-01', 3)).toBeNull();
  });
});

describe('baselineModel', () => {
  const d = doc({
    spans: [span('2015-01-01', '2015-01-04')],
    birthControl: [episode('implant', '2016-01-01')],
  });

  it('predicts from the weighted median of pre-episode cycles', () => {
    const result = baselineModel(regularCycles, d, '2016-06-01');
    expect(result.available).toBe(true);
    expect(result.model).toBe('baseline');
    expect(result.length).toBe(28);
  });

  it('anchors on the last pre-episode period start', () => {
    const result = baselineModel(regularCycles, d, '2016-06-01');
    expect(result.anchor).toBe('2015-12-03');
  });

  it('projects from the anchor to the first 28-day multiple on or after today', () => {
    const result = baselineModel(regularCycles, d, '2016-06-01');
    // 2015-12-03 plus 7 * 28 days. Six steps lands on 2016-05-19, before today.
    expect(result.date).toBe('2016-06-16');
  });

  // An exact figure, not a range: confidencePercent clamps its own output to
  // 0-100, so a range assertion holds however wrong the sigma and nEff feeding
  // it are. 72 is nEff 7.64 against zero spread, i.e. the discount term alone.
  it('reports the confidence the weighted sample supports', () => {
    expect(baselineModel(regularCycles, d, '2016-06-01').confidence).toBe(72);
  });

  // A missing anchor must produce no prediction rather than one that is a full
  // cycle early. buildCycles never omits nextStart, so this guards the path a
  // future producer -- manual entry, a partial sync -- could introduce.
  it('is unavailable when the last baseline cycle has no following start', () => {
    const noNext = regularCycles.map(({ nextStart, ...rest }) => rest);
    const result = baselineModel(noNext, d, '2016-06-01');
    expect(result.available).toBe(false);
    expect(result.date).toBeNull();
    expect(result.reason).toMatch(/no following period start/i);
  });

  it('gives high confidence to perfectly regular history', () => {
    const result = baselineModel(regularCycles, d, '2016-06-01');
    expect(result.sigma).toBe(0);
    // Zero spread makes the window term 1, so the figure is the data-sufficiency
    // discount alone: nEff/(nEff+3) with nEff around 7.6 after recency decay.
    expect(result.confidence).toBeGreaterThan(60);
    expect(result.confidence).toBeLessThan(85);
  });

  it('gives lower confidence to erratic history with the same cycle count', () => {
    const erratic = regularCycles.map((c, i) => ({ ...c, length: i % 2 === 0 ? 21 : 37 }));
    const steady = baselineModel(regularCycles, d, '2016-06-01');
    const noisy = baselineModel(erratic, d, '2016-06-01');
    expect(noisy.confidence).toBeLessThan(steady.confidence);
  });

  it('does not move when cycles are added after the first episode', () => {
    const before = baselineModel(regularCycles, d, '2016-06-01');
    const withLater = [...regularCycles, cycle('2016-02-01', 45), cycle('2016-04-01', 50)];
    const after = baselineModel(withLater, d, '2016-06-01');
    expect(after.length).toBe(before.length);
    expect(after.date).toBe(before.date);
  });

  // Review Focus 1: a new user, or a filter that excludes everything.
  it('is unavailable with no cycles, and says why', () => {
    const result = baselineModel([], d, '2016-06-01');
    expect(result.available).toBe(false);
    expect(result.date).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.reason).toMatch(/at least 2/i);
  });

  it('is unavailable with a single cycle', () => {
    expect(baselineModel([cycle('2015-01-01', 28)], d, '2016-06-01').available).toBe(false);
  });

  it('is unavailable when every cycle is excluded', () => {
    const allExcluded = regularCycles.map(c => ({ ...c, excluded: true }));
    expect(baselineModel(allExcluded, d, '2016-06-01').available).toBe(false);
  });

  it('never returns NaN in any field', () => {
    for (const sample of [[], [cycle('2015-01-01', 28)], regularCycles]) {
      for (const value of Object.values(baselineModel(sample, d, '2016-06-01'))) {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });
});

describe('adaptedModel', () => {
  const baseDoc = doc({
    spans: [span('2015-01-01', '2015-01-04')],
    birthControl: [episode('implant', '2016-01-01', null, 'suppress')],
  });

  // Pins the dependency the n_P = 0 branch rests on. If describeLengths ever
  // returns NaN for an empty sample instead of null, predict's short-circuit
  // stops being merely defensive and this test says so loudly.
  it('depends on describeLengths returning null, not NaN, for an empty sample', () => {
    const empty = describeLengths([]);
    expect(empty.mean).toBeNull();
    expect(Number.isNaN(empty.mean)).toBe(false);
    expect(0 * empty.mean).toBe(0);
  });

  // Review Focus 4: n_P = 0 is the normal state in a new episode, and the
  // blend must not evaluate 0 * NaN.
  it('reduces exactly to the baseline length when the episode has no cycles', () => {
    const base = baselineModel(regularCycles, baseDoc, '2016-02-01');
    const adapted = adaptedModel(regularCycles, baseDoc, '2016-02-01');
    expect(adapted.length).toBe(base.length);
    expect(Number.isNaN(adapted.length)).toBe(false);
    expect(adapted.weight).toBe(0);
  });

  it('widens the spread beyond the baseline when the episode is new', () => {
    const base = baselineModel(regularCycles, baseDoc, '2016-02-01');
    const adapted = adaptedModel(regularCycles, baseDoc, '2016-02-01');
    expect(adapted.sigma).toBeGreaterThan(base.sigma);
  });

  it('is less confident than the baseline when the episode is new', () => {
    const base = baselineModel(regularCycles, baseDoc, '2016-02-01');
    const adapted = adaptedModel(regularCycles, baseDoc, '2016-02-01');
    expect(adapted.confidence).toBeLessThan(base.confidence);
  });

  it('weights the episode at w = n/(n+TAU)', () => {
    const withOne = [...regularCycles, cycle('2016-01-15', 40)];
    expect(adaptedModel(withOne, baseDoc, '2016-03-01').weight).toBeCloseTo(1 / (1 + TAU), 10);
    const withThree = [...regularCycles, cycle('2016-01-15', 40), cycle('2016-02-24', 40), cycle('2016-04-04', 40)];
    expect(adaptedModel(withThree, baseDoc, '2016-06-01').weight).toBeCloseTo(3 / (3 + TAU), 10);
  });

  // The exact blended value, not a range. With three episode cycles w is 0.5,
  // so the length is 0.5*28 + 0.5*40 = 34. A range of (28, 40) would pass for
  // almost any wrong weight -- a w of 0.1 gives 29.2, comfortably inside it.
  it('drifts the length to the exact blend of baseline and episode mean', () => {
    const withEpisode = [...regularCycles, cycle('2016-01-15', 40), cycle('2016-02-24', 40), cycle('2016-04-04', 40)];
    const adapted = adaptedModel(withEpisode, baseDoc, '2016-06-01');
    expect(adapted.weight).toBe(0.5);
    expect(adapted.length).toBe(34);
  });

  // Review Focus 4: a single episode cycle has no sample SD.
  it('handles exactly one episode cycle without NaN', () => {
    const withOne = [...regularCycles, cycle('2016-01-15', 40)];
    const adapted = adaptedModel(withOne, baseDoc, '2016-03-01');
    expect(Number.isNaN(adapted.sigma)).toBe(false);
    expect(Number.isNaN(adapted.length)).toBe(false);
    expect(adapted.confidence).not.toBeNull();
  });

  it('narrows the method prior as episode data accumulates', () => {
    const few = [...regularCycles, cycle('2016-01-15', 28)];
    const many = [...regularCycles,
      cycle('2016-01-15', 28), cycle('2016-02-12', 28), cycle('2016-03-11', 28),
      cycle('2016-04-08', 28), cycle('2016-05-06', 28), cycle('2016-06-03', 28)];
    const sparse = adaptedModel(few, baseDoc, '2016-07-01');
    const rich = adaptedModel(many, baseDoc, '2016-07-01');
    expect(rich.sigma).toBeLessThan(sparse.sigma);
    expect(rich.confidence).toBeGreaterThan(sparse.confidence);
  });

  it('uses the regulate prior for a cyclic method', () => {
    const regulated = doc({
      spans: [span('2015-01-01', '2015-01-04')],
      birthControl: [episode('pill', '2016-01-01', null, 'regulate')],
    });
    const suppressed = adaptedModel(regularCycles, baseDoc, '2016-02-01');
    const regulatedResult = adaptedModel(regularCycles, regulated, '2016-02-01');
    expect(regulatedResult.sigma).toBeLessThan(suppressed.sigma);
  });

  it('falls back to the baseline when no episode is in force', () => {
    const noEpisode = doc({ spans: [span('2015-01-01', '2015-01-04')] });
    const adapted = adaptedModel(regularCycles, noEpisode, '2016-02-01');
    expect(adapted.available).toBe(true);
    expect(adapted.model).toBe('no-episode');
    expect(adapted.weight).toBe(0);
  });

  it('anchors on the most recent period start, including during the episode', () => {
    const d = doc({
      spans: [span('2015-01-01', '2015-01-04'), span('2016-01-15', '2016-01-18')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    expect(adaptedModel(regularCycles, d, '2016-02-01').anchor).toBe('2016-01-15');
  });

  it('is unavailable when there is neither baseline nor episode data', () => {
    const result = adaptedModel([], baseDoc, '2016-02-01');
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('never returns NaN in any field across degenerate inputs', () => {
    const cases = [[], [cycle('2015-01-01', 28)], regularCycles,
      [...regularCycles, cycle('2016-01-15', 40)]];
    for (const sample of cases) {
      for (const value of Object.values(adaptedModel(sample, baseDoc, '2016-06-01'))) {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });
});

describe('predict', () => {
  const d = doc({
    spans: [span('2015-01-01', '2015-01-04'), span('2016-01-15', '2016-01-18')],
    birthControl: [episode('implant', '2016-01-01')],
  });

  it('returns both models together', () => {
    const result = predict(regularCycles, d, '2016-02-01');
    expect(result.baseline.model).toBe('baseline');
    expect(result.adapted.model).toBe('adapted');
  });

  it('gives the two models different dates once they diverge', () => {
    const withEpisode = [...regularCycles, cycle('2016-01-15', 45), cycle('2016-02-29', 45), cycle('2016-04-14', 45)];
    const result = predict(withEpisode, d, '2016-06-01');
    expect(result.adapted.length).not.toBe(result.baseline.length);
  });

  it('is deterministic across repeated calls', () => {
    expect(predict(regularCycles, d, '2016-02-01')).toEqual(predict(regularCycles, d, '2016-02-01'));
  });
});
