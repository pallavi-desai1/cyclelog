import { describe, it, expect } from 'vitest';
import {
  TAU, LATE_GRACE_DAYS, lastPeriodStart, projectForward, projectPrevious,
  predictionStatus, baselineModel, adaptedModel, predict,
} from '../src/predict.js';
import { describeLengths } from '../src/stats.js';
import { lastPeriodStartOnOrBefore } from '../src/episodes.js';

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

  // I4: multiply before rounding. At length 28.5 the 25th step is
  // round(28.5 * 25) = 713 days out, landing on 2016-12-14. Rounding the
  // step first (round(28.5) = 29, half a day high every cycle) lands on
  // 2016-12-26 by then -- twelve days of accumulated drift over the same
  // twenty-five cycles.
  it('multiplies before rounding over many steps at a fractional length', () => {
    expect(projectForward('2015-01-01', 28.5, '2016-12-10')).toBe('2016-12-14');
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
  //
  // After C1a, baselineCycles itself requires every surviving cycle to carry a
  // valid nextStart whenever a first episode exists -- so stripping nextStart
  // from only the LAST chronological cycle while an episode is present just
  // drops that one cycle from the sample; the new last-of-sample already has
  // a valid nextStart and the model succeeds. The anchor-null branch this test
  // guards is only still reachable through baselineCycles' no-episode
  // fallback (it returns usableCycles unfiltered when there is no first
  // episode at all), so this test now uses a doc with no birth-control
  // history to exercise it.
  it('is unavailable when the last baseline cycle has no following start', () => {
    const noEpisode = doc();
    const noNextLast = regularCycles.map(
      (c, i) => (i === regularCycles.length - 1 ? (({ nextStart, ...rest }) => rest)(c) : c),
    );
    const result = baselineModel(noNextLast, noEpisode, '2016-06-01');
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

  // The straddling cycle is what makes this discriminate: it starts before the
  // episode and ends after it, so the old `start <` rule admitted it while the
  // correct whole-cycle rule rejects it. Without it, a buggy and a correct
  // implementation produce identical output. Asserts sigma, nEff and anchor too
  // -- those are the fields contamination actually moves. '2015-11-20' is used
  // (not '2015-11-05', which collides with regularCycles' last start) so the
  // straddling cycle starts before the 2016-01-01 episode and ends
  // ('2016-02-20') after it.
  it('does not move when a cycle straddles the first episode', () => {
    const before = baselineModel(regularCycles, d, '2016-06-01');
    const straddling = [...regularCycles,
      { ...cycle('2015-11-20', 107), nextStart: '2016-02-20' }];
    const after = baselineModel(straddling, d, '2016-06-01');
    expect(after.length).toBe(before.length);
    expect(after.sigma).toBe(before.sigma);
    expect(after.nEff).toBe(before.nEff);
    expect(after.anchor).toBe(before.anchor);
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

  // Minor 2: `available: true` with `date: null` would be representable if
  // projectForward hits its step cap. `available` must mean "has a usable
  // date" -- a today far enough out that MAX_PROJECTIONS (2000 cycles of ~28
  // days) cannot reach it must report unavailable, not a null date.
  it('is unavailable rather than available-with-a-null-date when the step cap is hit', () => {
    const result = baselineModel(regularCycles, d, '2200-01-01');
    expect(result.available).toBe(false);
    expect(result.date).toBeNull();
    expect(result.reason).toMatch(/step cap/i);
  });

  // C1b: predict.js derives its anchor from `last.nextStart`; divergence.js
  // derives its anchor from the shared `lastPeriodStartOnOrBefore`. They must
  // agree even at the boundary -- a period starting exactly on the day the
  // episode started. Built so the last baseline cycle's nextStart lands
  // exactly on the episode's startedOn (the inclusive case C1a allows), and a
  // span is logged on that same date.
  it('agrees with lastPeriodStartOnOrBefore when a period starts exactly on the episode start date', () => {
    const boundary = doc({
      spans: [span('2015-01-01', '2015-01-04'), span('2016-01-01', '2016-01-04')],
      birthControl: [episode('implant', '2016-01-01')],
    });
    const boundaryCycles = [
      cycle('2015-01-01', 28, { nextStart: '2015-01-29' }),
      cycle('2015-01-29', 28, { nextStart: '2016-01-01' }),
    ];
    const result = baselineModel(boundaryCycles, boundary, '2016-06-01');
    expect(result.available).toBe(true);
    expect(result.anchor).toBe('2016-01-01');
    expect(lastPeriodStartOnOrBefore(boundary, '2016-01-01')).toBe('2016-01-01');
    expect(result.anchor).toBe(lastPeriodStartOnOrBefore(boundary, '2016-01-01'));
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
    // The premise of the side-by-side screen is that the two models can
    // actually land on different dates, not just different lengths.
    expect(result.adapted.date).not.toBe(result.baseline.date);
  });

  it('is deterministic across repeated calls', () => {
    expect(predict(regularCycles, d, '2016-02-01')).toEqual(predict(regularCycles, d, '2016-02-01'));
  });
});

describe('projectPrevious', () => {
  it('returns the most recent projection strictly before today', () => {
    expect(projectPrevious('2015-01-01', 28, '2015-02-10')).toBe('2015-01-29');
  });

  it('returns null when the first projection is still ahead', () => {
    expect(projectPrevious('2015-01-01', 28, '2015-01-15')).toBeNull();
  });

  it('returns null when the first projection is exactly today', () => {
    // `date` owns today; `previousDate` is strictly in the past.
    expect(projectPrevious('2015-01-01', 28, '2015-01-29')).toBeNull();
  });

  it('multiplies before rounding, like projectForward', () => {
    // Measured: at a length of 28.5 multiplying gives 2015-04-25, while stepping
    // a pre-rounded 29 gives 2015-04-27. Two days apart by the fourth cycle.
    expect(projectPrevious('2015-01-01', 28.5, '2015-05-01')).toBe('2015-04-25');
  });

  it('returns null for a non-positive or non-finite length', () => {
    expect(projectPrevious('2015-01-01', 0, '2015-06-01')).toBeNull();
    expect(projectPrevious('2015-01-01', NaN, '2015-06-01')).toBeNull();
  });

  it('returns null for a missing anchor', () => {
    expect(projectPrevious(null, 28, '2015-06-01')).toBeNull();
  });

  it('gives up at the step cap rather than looping', () => {
    // 2015-06-01, not a 2020s date: the privacy guard flags 2018-2026 in tracked
    // content. Three one-day steps from the anchor reach 2015-01-04, so any later
    // today exhausts the cap and returns null — the property under test is
    // unchanged.
    expect(projectPrevious('2015-01-01', 1, '2015-06-01', 3)).toBeNull();
  });
});

describe('predictionStatus', () => {
  it('exposes a grace window of three days', () => {
    expect(LATE_GRACE_DAYS).toBe(3);
  });

  it('is upcoming when nothing has passed', () => {
    expect(predictionStatus(null, '2015-02-01', true)).toEqual({ status: 'upcoming', daysLate: null });
  });

  it('is upcoming when the passed date is today', () => {
    expect(predictionStatus('2015-02-01', '2015-02-01', true)).toEqual({ status: 'upcoming', daysLate: null });
  });

  it('is late one day past', () => {
    expect(predictionStatus('2015-02-01', '2015-02-02', true)).toEqual({ status: 'late', daysLate: 1 });
  });

  // Review Focus 2: the boundary. Exactly 3 is late, exactly 4 is not-expected.
  // A `< 3` mutation would make day 3 not-expected and pass a looser test.
  it('is still late at exactly three days past', () => {
    expect(predictionStatus('2015-02-01', '2015-02-04', true)).toEqual({ status: 'late', daysLate: 3 });
  });

  it('becomes not-expected at four days past on a suppressing method', () => {
    expect(predictionStatus('2015-02-01', '2015-02-05', true)).toEqual({ status: 'not-expected', daysLate: 4 });
  });

  it('keeps counting late past the window when the method does not suppress', () => {
    expect(predictionStatus('2015-02-01', '2015-03-01', false)).toEqual({ status: 'late', daysLate: 28 });
  });

  // Measures from whatever date it is given; the MODEL decides which date that
  // is, and the model-level tests below are what prove the count accumulates.
  // An earlier version of this test asserted 63 days here and read as proof of
  // cumulative counting while only exercising this function's subtraction.
  it('counts from the date it is given, however far back', () => {
    expect(predictionStatus('2015-02-01', '2015-04-05', true).daysLate).toBe(63);
  });
});

describe('model status fields', () => {
  // The episode begins AFTER the last logged period, which mirrors the owner's
  // real situation: her method was started several weeks into a cycle, with
  // nothing logged since. A fixture where she has already bled on the method is
  // a different case, covered in its own describe block below. (Deliberately
  // described rather than dated — the privacy guard flags real dates in tracked
  // content, and it caught an earlier draft of this very comment.)
  const suppressDoc = doc({
    spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
    birthControl: [episode('implant', '2016-01-20', null, 'suppress')],
  });

  // Review Focus 1: `date` is always ahead, `previousDate` always behind.
  // Lateness cannot be derived from `date`, which is why both exist.
  it('never reports a date in the past, and a previousDate that is not', () => {
    const today = '2016-02-20';
    const { adapted } = predict(regularCycles, suppressDoc, today);
    expect(adapted.date >= today).toBe(true);
    expect(adapted.previousDate < today).toBe(true);
  });

  it('reports the adapted model late inside the grace window', () => {
    // last period 2016-01-05, length 28 -> due 2016-02-02; two days past it
    const { adapted } = predict(regularCycles, suppressDoc, '2016-02-04');
    expect(adapted.status).toBe('late');
    expect(adapted.daysLate).toBe(2);
  });

  it('reports the adapted model not-expected past the window on an implant', () => {
    const { adapted } = predict(regularCycles, suppressDoc, '2016-02-20');
    expect(adapted.status).toBe('not-expected');
    expect(adapted.daysLate).toBe(18);
  });

  // Review Focus 3: the episode must be read at today, not at the cycle's start.
  // Here the method starts AFTER the last period, so a status computed from the
  // episode at the period's start would see no method and report `late`.
  it('reads the suppressing method in force today, not at the cycle start', () => {
    const startedAfter = doc({
      spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
      birthControl: [episode('implant', '2016-01-20', null, 'suppress')],
    });
    expect(predict(regularCycles, startedAfter, '2016-02-20').adapted.status).toBe('not-expected');
  });

  it('keeps counting late on a non-suppressing method', () => {
    const pill = doc({
      spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
      birthControl: [episode('pill', '2016-01-01', null, 'regulate')],
    });
    expect(predict(regularCycles, pill, '2016-02-20').adapted.status).toBe('late');
  });

  // The baseline is a counterfactual: it can pass, but it can never be late and
  // is never "not expected".
  it('uses passed, not late, for the baseline', () => {
    const { baseline } = predict(regularCycles, suppressDoc, '2016-02-20');
    expect(['upcoming', 'passed']).toContain(baseline.status);
    expect(baseline.status).toBe('passed');
  });

  // Asserts positively, not `not.toBe('not-expected')` — that form passes
  // trivially while the field is still undefined, so it proves nothing until
  // after the implementation exists. At this date the baseline's last
  // projection (2016-05-19) is 13 days past, which is beyond the grace window;
  // a baseline wired with suppression would therefore say 'not-expected' here,
  // and this says 'passed'.
  it('calls the baseline passed, never not-expected, past the grace window', () => {
    const { baseline } = predict(regularCycles, suppressDoc, '2016-06-01');
    expect(baseline.status).toBe('passed');
    expect(baseline.daysLate).toBe(13);
  });

  // Review Focus 4: a new user has nothing behind her.
  it('is upcoming with no passed projection', () => {
    const fresh = doc({
      spans: [span('2016-01-05', '2016-01-08')],
      birthControl: [episode('implant', '2016-01-01', null, 'suppress')],
    });
    const { adapted } = predict(regularCycles, fresh, '2016-01-10');
    expect(adapted.status).toBe('upcoming');
    expect(adapted.previousDate).toBeNull();
    expect(adapted.daysLate).toBeNull();
  });

  it('leaves the status null on an unavailable prediction', () => {
    const { baseline } = predict([], suppressDoc, '2016-02-20');
    expect(baseline.available).toBe(false);
    expect(baseline.status).toBeNull();
    expect(baseline.previousDate).toBeNull();
    expect(baseline.daysLate).toBeNull();
  });

  it('never returns NaN in any status field', () => {
    for (const today of ['2016-01-10', '2016-02-04', '2016-02-20', '2017-06-01']) {
      const { baseline, adapted } = predict(regularCycles, suppressDoc, today);
      for (const model of [baseline, adapted]) {
        for (const value of Object.values(model)) expect(Number.isNaN(value)).toBe(false);
      }
    }
  });
});

describe('overdue counting accumulates', () => {
  const offMethod = doc({
    spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
  });
  const onImplant = doc({
    spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
    birthControl: [episode('implant', '2016-01-20', null, 'suppress')],
  });

  // The headline figure must keep running. Measured from the most recent passed
  // projection it sawtooths: 28, then 1, then 27, then 1 — so a woman 57 days
  // without a period off birth control was told "1 DAY LATE".
  it('keeps counting past a second projection boundary', () => {
    // last period 2016-01-05, length 28, so due 2016-02-02; 2016-03-02 is 29
    // days past that and 57 days since the period itself.
    expect(predict(regularCycles, offMethod, '2016-03-02').adapted.daysLate).toBe(29);
  });

  it('never resets the count while a period stays missing', () => {
    let last = 0;
    for (const today of ['2016-02-04', '2016-03-01', '2016-03-02', '2016-03-28', '2016-05-01']) {
      const { daysLate } = predict(regularCycles, offMethod, today).adapted;
      expect(daysLate).toBeGreaterThan(last);
      last = daysLate;
    }
  });

  // Spec 6.2a justifies populating daysLate in this state with "no period in
  // 63 days is clinically relevant". The old implementation capped at 27.
  it('counts amenorrhea from the due date, not the last projection', () => {
    const { adapted } = predict(regularCycles, onImplant, '2016-03-20');
    expect(adapted.status).toBe('not-expected');
    expect(adapted.daysLate).toBe(47);
  });

  // The ghost's sawtooth is specified and correct: spec 6.2a says its daysLate
  // cycles 1..27 as each projection passes. The adapted fix must not change it.
  it('leaves the baseline cycling within one cycle length', () => {
    for (const today of ['2016-03-20', '2016-09-01', '2017-06-01']) {
      const { baseline } = predict(regularCycles, onImplant, today);
      expect(baseline.daysLate).toBeLessThan(28);
      expect(baseline.daysLate).toBeGreaterThan(0);
    }
  });
});

describe('bleeding on a suppressing method', () => {
  // Spec 6.2a: "Roughly one in five implant users keep bleeding. A single
  // logged period is evidence the owner is in that group, so the model returns
  // to predicting dates." Previously she was told NO PERIOD EXPECTED again four
  // days after every prediction, despite documented monthly bleeding.
  const bleeding = doc({
    spans: [
      span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08'),
      span('2016-02-10', '2016-02-13'), span('2016-03-20', '2016-03-23'),
    ],
    birthControl: [episode('implant', '2016-01-01', null, 'suppress')],
  });

  it('predicts dates once a period has been logged on the method', () => {
    expect(predict(regularCycles, bleeding, '2016-04-25').adapted.status).toBe('late');
    expect(predict(regularCycles, bleeding, '2016-05-20').adapted.status).toBe('late');
  });

  it('still reports not-expected when nothing has been logged on the method', () => {
    const nothingYet = doc({
      spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
      birthControl: [episode('implant', '2016-01-20', null, 'suppress')],
    });
    expect(predict(regularCycles, nothingYet, '2016-02-20').adapted.status).toBe('not-expected');
  });

  // Review Focus: `suppressing` is `=== 'suppress'`, so a third effect must not
  // accidentally qualify. A copper IUD does not suppress bleeding.
  it('keeps counting late on a method expected to do nothing to the cycle', () => {
    const copper = doc({
      spans: [span('2015-12-01', '2015-12-04'), span('2016-01-05', '2016-01-08')],
      birthControl: [episode('copper-iud', '2016-01-20', null, 'none')],
    });
    expect(predict(regularCycles, copper, '2016-02-20').adapted.status).toBe('late');
  });
});
