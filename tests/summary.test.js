import { describe, it, expect } from 'vitest';
import { days, buildSummary, uncertaintyCaveat } from '../src/summary.js';
import { addDays } from '../src/dates.js';

// De-identified fixture: 28-day cycles in 2015, outside the range of any real
// data in this repository. The expected figures below were obtained two ways:
// the original ones by running the predict/cycles/stats modules on this fixture,
// and every figure changed since then by deriving it from the fixture by hand.
// Neither is an independent check on the other; re-derive before editing one.
const spans = () => [
  { start: '2015-01-01', end: null, source: 'test' },
  { start: '2015-01-29', end: null, source: 'test' },
  { start: '2015-02-26', end: null, source: 'test' },
  { start: '2015-03-26', end: '2015-03-30', source: 'test' },
];

const doc = (birthControl = []) => ({
  version: 1, days: {}, spans: spans(), gaps: [], birthControl,
});

const SUPPRESS = [{ startedOn: '2015-06-01', endedOn: null, method: 'implant', expectedEffect: 'suppress' }];
const REGULATE = [{ startedOn: '2015-06-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }];
const EARLY_PILL = [{ startedOn: '2015-04-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }];

describe('days', () => {
  it('says "1 day", because "1 days late" reads as a bug in the app', () => {
    expect(days(1)).toBe('1 day');
  });

  it('pluralises everything else', () => {
    expect(days(0)).toBe('0 days');
    expect(days(2)).toBe('2 days');
    expect(days(83)).toBe('83 days');
  });
});

describe('the doctor-appointment facts', () => {
  const summary = () => buildSummary(doc(SUPPRESS), '2015-07-15');

  it('leads with the last period start', () => {
    expect(summary().lastPeriod.start).toBe('2015-03-26');
  });

  it('reports its end and length when the end was logged', () => {
    expect(summary().lastPeriod.end).toBe('2015-03-30');
    expect(summary().lastPeriod.lengthDays).toBe(5);
  });

  it('leaves the length null when the period has no logged end', () => {
    const open = doc(SUPPRESS);
    open.spans[3].end = null;
    const last = buildSummary(open, '2015-07-15').lastPeriod;
    expect(last.end).toBeNull();
    expect(last.lengthDays).toBeNull();
  });

  it('reports the current cycle day', () => {
    expect(summary().lastPeriod.dayOfCycle).toBe(112);
  });

  it('reports the cycle statistics', () => {
    expect(summary().history).toEqual({
      usableCycles: 3, excludedCount: 0, median: 28, mean: 28, last12Median: 28,
    });
  });

  it('names the method in force', () => {
    expect(summary().method).toEqual({
      method: 'implant', startedOn: '2015-06-01', expectedEffect: 'suppress',
    });
  });

  it('reports no method when none is in force', () => {
    expect(buildSummary(doc(), '2015-04-20').method).toBeNull();
  });

  // Critical 4 (whole-branch review): a document shared at the `dates`
  // scope carries an episode with no `method` field at all — the
  // projection strips the name but keeps startedOn/endedOn/expectedEffect,
  // which his predictions still need. That must produce no method object
  // at all, not one with an undefined name a renderer would print as an
  // empty label.
  it('produces no method object when the episode has no method name, as a scope-narrowed share carries', () => {
    const noName = [{ startedOn: '2015-06-01', endedOn: null, expectedEffect: 'suppress' }];
    expect(buildSummary(doc(noName), '2015-07-15').method).toBeNull();
  });

  it('has no last period when nothing is logged', () => {
    const empty = { version: 1, days: {}, spans: [], gaps: [], birthControl: [] };
    expect(buildSummary(empty, '2015-07-15').lastPeriod).toBeNull();
  });

  it('includes the date it was built for', () => {
    expect(summary().asOf).toBe('2015-07-15');
  });
});

describe('the headline', () => {
  it('says how many days late, when a period is overdue on a regulating method', () => {
    const { headline } = buildSummary(doc(REGULATE), '2015-07-15');
    expect(headline).toEqual({ kind: 'late', text: '83 days late', daysLate: 83 });
  });

  it('says "1 day late" on the first day overdue', () => {
    const { headline } = buildSummary(doc(EARLY_PILL), '2015-04-24');
    expect(headline).toEqual({ kind: 'late', text: '1 day late', daysLate: 1 });
  });

  // Her instruction, and the spec's §6.2b: name the reality instead of
  // widening the uncertainty until the prediction means nothing.
  it('says no period is expected on a suppressing method', () => {
    const { headline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(headline).toEqual({ kind: 'no-period', text: 'No period expected', daysLate: 83 });
  });

  it('keeps the day count in the no-period state, since that is the clinical fact', () => {
    expect(buildSummary(doc(SUPPRESS), '2015-07-15').headline.daysLate).toBe(83);
  });

  it('says it is on time before the due date', () => {
    const { headline } = buildSummary(doc(EARLY_PILL), '2015-04-20');
    expect(headline).toEqual({ kind: 'on-time', text: 'On time so far', daysLate: null });
  });

  it('says so plainly when there is not enough data to predict', () => {
    const thin = { version: 1, days: {}, spans: [{ start: '2015-01-01', end: null, source: 'test' }], gaps: [], birthControl: [] };
    const { headline } = buildSummary(thin, '2015-02-01');
    expect(headline.kind).toBe('unavailable');
    expect(headline.text).toBe('Not enough data yet');
    expect(headline.daysLate).toBeNull();
  });
});

describe('the adapted prediction', () => {
  it('carries the date, length, spread and confidence', () => {
    const { adapted } = buildSummary(doc(REGULATE), '2015-07-15');
    expect(adapted.available).toBe(true);
    expect(adapted.date).toBe('2015-07-16');
    expect(adapted.length).toBe(28);
    expect(adapted.sigma).toBe(3);
    expect(adapted.confidence).toBe(25);
    expect(adapted.status).toBe('late');
  });

  // Spec §6.2b, enforced in the data rather than trusted to the renderer.
  it('withholds the confidence figure in the no-period state', () => {
    const { adapted } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(adapted.status).toBe('not-expected');
    expect(adapted.confidence).toBeNull();
  });

  it('still carries the date and spread in the no-period state', () => {
    const { adapted } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(adapted.date).toBe('2015-07-16');
    expect(adapted.sigma).toBe(7);
  });

  it('reports a wider spread on a suppressing method than a regulating one', () => {
    const suppress = buildSummary(doc(SUPPRESS), '2015-07-15').adapted;
    const regulate = buildSummary(doc(REGULATE), '2015-07-15').adapted;
    expect(suppress.sigma).toBeGreaterThan(regulate.sigma);
  });

  it('names the model, so a changed method is visible rather than silent', () => {
    expect(buildSummary(doc(REGULATE), '2015-07-15').adapted.model).toBe('adapted');
    expect(buildSummary(doc(), '2015-04-20').adapted.model).toBe('no-episode');
  });

  it('carries the reason when unavailable', () => {
    const thin = { version: 1, days: {}, spans: [], gaps: [], birthControl: [] };
    const { adapted } = buildSummary(thin, '2015-07-15');
    expect(adapted.available).toBe(false);
    expect(adapted.reason).toMatch(/\S/);
    expect(adapted.date).toBeNull();
  });
});

describe('the baseline prediction', () => {
  it('reports the next counterfactual date with its confidence', () => {
    const { baseline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(baseline.available).toBe(true);
    expect(baseline.date).toBe('2015-07-16');
    expect(baseline.confidence).toBe(42);
    expect(baseline.length).toBe(28);
  });

  // The ghost is never "late": a cycle that was never going to happen cannot
  // be overdue, and saying so would imply she is late when the statement is
  // about the counterfactual.
  it('reports when a period would have come, not that one is late', () => {
    const { baseline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(baseline.wouldHaveStarted).toBe('2015-06-18');
    expect(baseline.daysAgo).toBe(27);
    expect(JSON.stringify(baseline)).not.toContain('late');
  });

  it('leaves both null when the counterfactual is still upcoming', () => {
    const { baseline } = buildSummary(doc(EARLY_PILL), '2015-04-20');
    expect(baseline.wouldHaveStarted).toBeNull();
    expect(baseline.daysAgo).toBeNull();
  });

  it('carries the reason when there is no usable natural-cycle history', () => {
    const thin = { version: 1, days: {}, spans: [{ start: '2015-01-01', end: null, source: 'test' }], gaps: [], birthControl: [] };
    const { baseline } = buildSummary(thin, '2015-02-01');
    expect(baseline.available).toBe(false);
    expect(baseline.reason).toMatch(/\S/);
  });
});

describe('divergence', () => {
  it('is empty before any period arrives on a method', () => {
    const { divergence } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(divergence.points).toEqual([]);
    expect(divergence.meanShift).toBeNull();
    expect(divergence.byEpisode).toEqual([]);
  });

  it('measures the shift once a period arrives on a method', () => {
    const withBleed = doc(EARLY_PILL);
    // Four days later than the baseline's 2015-04-23 projection.
    withBleed.spans.push({ start: '2015-04-27', end: null, source: 'test' });
    const { divergence } = buildSummary(withBleed, '2015-05-10');
    expect(divergence.points).toHaveLength(1);
    expect(divergence.points[0].delta).toBe(4);
    expect(divergence.meanShift).toBe(4);
    expect(divergence.byEpisode[0].method).toBe('pill');
  });
});

describe('the whole summary', () => {
  it('offers a renderer nothing it could print as a percentage', () => {
    const { adapted, headline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(headline.kind).toBe('no-period');
    expect(adapted.confidence).toBeNull();
    expect(headline.text).not.toContain('%');
  });

  it('is serialisable, so the export and the view share one shape', () => {
    const summary = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(JSON.parse(JSON.stringify(summary)).lastPeriod.start).toBe('2015-03-26');
  });
});

describe('the baseline anchor', () => {
  it('is exposed, so the calendar can project the cadence across any month', () => {
    const { baseline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(baseline.anchor).toBe('2015-03-26');
  });

  it('is null when there is no usable natural-cycle history', () => {
    const thin = { version: 1, days: {}, spans: [], gaps: [], birthControl: [] };
    expect(buildSummary(thin, '2015-07-15').baseline.anchor).toBeNull();
  });

  it('is the last pre-birth-control period start, not the next projection', () => {
    const { baseline } = buildSummary(doc(SUPPRESS), '2015-07-15');
    expect(baseline.anchor).not.toBe(baseline.date);
    expect(baseline.anchor < baseline.date).toBe(true);
  });
});

const SAMPLE = 'This prediction is based on only a few cycles, '
  + 'so these days could be off by several days or more.';

describe('uncertaintyCaveat boundaries', () => {
  const m = (sigma, nEff) => ({ available: true, sigma, nEff });

  it('does not fire the spread caveat at sigma exactly 2', () => {
    // 2 > 2 is false; nEff 10 is not thin, so nothing fires.
    expect(uncertaintyCaveat(m(2, 10))).toBeNull();
  });

  it('fires the spread caveat just above 2, rounded', () => {
    expect(uncertaintyCaveat(m(2.1, 10))).toBe(
      'Your recent cycles vary by about \u00b1 2 days, so these days could be off by that much or more.',
    );
  });

  it('does not fire the sample caveat at nEff exactly 6', () => {
    // 6 < 6 is false; sigma 0 is not spread.
    expect(uncertaintyCaveat(m(0, 6))).toBeNull();
  });

  it('fires the sample caveat just below 6', () => {
    expect(uncertaintyCaveat(m(0, 5.99))).toBe(SAMPLE);
  });

  it('gives the sample string, never a number, when the model is unavailable', () => {
    expect(uncertaintyCaveat({ available: false, sigma: null, nEff: 0 })).toBe(SAMPLE);
  });
});

const SETTLING = 'Your cycles are still settling after stopping a hormonal method, '
  + 'so these days could be off by a week or more.';

describe('uncertaintyCaveat while cycles settle after a hormonal method', () => {
  const m = (sigma, nEff) => ({ available: true, sigma, nEff });

  it('wins over the spread string', () => {
    expect(uncertaintyCaveat(m(5, 10), true)).toBe(SETTLING);
  });

  it('wins over the sample string', () => {
    expect(uncertaintyCaveat(m(0, 2), true)).toBe(SETTLING);
    expect(uncertaintyCaveat({ available: false, sigma: null, nEff: 0 }, true)).toBe(SETTLING);
  });

  it('fires even when the model looks perfectly confident', () => {
    expect(uncertaintyCaveat(m(0, 20), true)).toBe(SETTLING);
  });

  it('leaves the two existing strings alone when not settling', () => {
    expect(uncertaintyCaveat(m(0, 20), false)).toBeNull();
    expect(uncertaintyCaveat(m(0, 20))).toBeNull();
  });
});

describe('summary.phase.caveat after a hormonal method ends', () => {
  // Cycles of the given lengths, starting 2015-01-01 (the last has no next start).
  const spansFor = (lengths, first = '2015-01-01') => {
    const out = [{ start: first }];
    for (const n of lengths) out.push({ start: addDays(out[out.length - 1].start, n) });
    return out;
  };
  const EPISODE_END = '2015-03-01';
  const episode = (effect, endedOn = EPISODE_END) => ({
    method: 'implant', startedOn: '2015-01-01', endedOn, expectedEffect: effect,
  });
  // Four completed cycles of 28 days, all starting after the episode ended.
  const after = (birthControl, lengths = [28, 28, 28, 28]) => ({
    version: 1, days: {}, gaps: [], birthControl, spans: spansFor(lengths, '2015-03-10'),
  });
  const caveat = (d, today) => buildSummary(d, today).phase.caveat.uncertainty;

  it('fires the day she comes off, though 28 long cycles look confident (the reported case)', () => {
    const lengths = [];
    for (let i = 0; i < 28; i++) lengths.push([26, 31, 28, 29, 27, 30][i % 6]);
    const d = { version: 1, days: {}, gaps: [], spans: spansFor(lengths),
      birthControl: [{ method: 'implant', startedOn: '2017-04-01', endedOn: '2017-06-01', expectedEffect: 'suppress' }] };
    const s = buildSummary(d, '2017-07-01');
    expect(s.adapted.sigma).toBeLessThanOrEqual(2);
    expect(s.adapted.nEff).toBeGreaterThanOrEqual(6);
    expect(s.phase.caveat.uncertainty).toBe(SETTLING);
  });

  it('fires 180 days after the method ended', () => {
    expect(caveat(after([episode('suppress')]), addDays(EPISODE_END, 180))).toBe(SETTLING);
  });

  it('does not fire 181 days after, once three natural cycles have completed', () => {
    expect(caveat(after([episode('suppress')]), addDays(EPISODE_END, 181))).not.toBe(SETTLING);
  });

  it('fires past 180 days while fewer than three natural cycles have completed since', () => {
    // Two completed cycles (the third span has no next start yet).
    const d = after([episode('regulate')], [28, 28]);
    expect(caveat(d, addDays(EPISODE_END, 300))).toBe(SETTLING);
  });

  it('counts only cycles completed after the method ended, not her pre-method ones', () => {
    const d = {
      version: 1, days: {}, gaps: [],
      spans: [...spansFor([28, 28, 28, 28]), { start: '2015-06-01' }, { start: '2015-06-29' }, { start: '2015-07-27' }],
      birthControl: [{ method: 'pill', startedOn: '2015-05-01', endedOn: '2015-05-20', expectedEffect: 'regulate' }],
    };
    // Pre-method starts: 01-01, 01-29, 02-26, 03-26, 04-23. Two cycles complete after 05-20.
    expect(caveat(d, addDays('2015-05-20', 300))).toBe(SETTLING);
  });

  it('stops firing past 180 days at three completed natural cycles', () => {
    const d = after([episode('regulate')], [28, 28, 28]);
    expect(caveat(d, addDays(EPISODE_END, 300))).not.toBe(SETTLING);
  });

  it('does not fire for a method with no hormonal effect', () => {
    expect(caveat(after([episode('none')]), addDays(EPISODE_END, 30))).not.toBe(SETTLING);
  });

  it('does not fire while she is still on the method', () => {
    expect(caveat(after([episode('suppress', null)]), addDays(EPISODE_END, 30))).not.toBe(SETTLING);
  });

  it('does not fire after a switch from one hormonal method straight to another', () => {
    const d = after([episode('suppress', '2015-03-05'),
      { method: 'pill', startedOn: '2015-03-05', endedOn: null, expectedEffect: 'regulate' }]);
    expect(caveat(d, '2015-04-01')).not.toBe(SETTLING);
  });

  it('ignores a "nothing" row', () => {
    const d = after([{ method: 'nothing', startedOn: '2015-01-01', endedOn: EPISODE_END, expectedEffect: 'suppress' }]);
    expect(caveat(d, addDays(EPISODE_END, 30))).not.toBe(SETTLING);
  });

  it('still fires on the partner\'s copy, where the method name is stripped', () => {
    const { method, ...stripped } = episode('suppress');
    expect(caveat(after([stripped]), addDays(EPISODE_END, 30))).toBe(SETTLING);
  });

  it('does not fire with no episodes at all', () => {
    expect(caveat(after([]), '2015-08-01')).not.toBe(SETTLING);
  });
});

describe('summary.phase', () => {
  const pdoc = () => ({
    spans: [{ start: '2015-01-01' }, { start: '2015-01-29' }, { start: '2015-02-26' }],
  });
  const FIXED = 'Fertile days are predicted from your own past cycle lengths. '
    + 'This is not contraception \u2014 a day without a mark is not a safe day.';

  it('names the phase and the day of the cycle', () => {
    const s = buildSummary(pdoc(), '2015-03-01');
    expect(s.phase.name).toBe('follicular');
    expect(s.phase.cycleDay).toBe(4);
  });

  it('carries the current window', () => {
    // Anchor 2015-02-26 at 28 days predicts 2015-03-26; descent 2015-03-12.
    expect(buildSummary(pdoc(), '2015-03-12').phase.window)
      .toEqual({ from: '2015-03-08', descent: '2015-03-12', to: '2015-03-13' });
    expect(buildSummary(pdoc(), '2015-03-12').phase.name).toBe('fertile');
  });

  it('holds the window still while the period is late, instead of walking it forward', () => {
    // Period due 2015-03-26. On 2015-03-30 it is 4 days late; projectForward
    // would give 2015-04-23 (descent 04-09). The pinned window stays 03-08..03-13
    // and the day falls into the luteal phase.
    const late = buildSummary(pdoc(), '2015-03-30').phase;
    expect(late.window).toEqual({ from: '2015-03-08', descent: '2015-03-12', to: '2015-03-13' });
    expect(late.name).toBe('luteal');
    // A day marked fertile yesterday-of-the-window is not un-marked by the clock.
    expect(buildSummary(pdoc(), '2015-04-20').phase.window)
      .toEqual({ from: '2015-03-08', descent: '2015-03-12', to: '2015-03-13' });
  });

  it('re-centres the window and flags fromTest when a positive test lies outside it', () => {
    const d = pdoc();
    d.days = { '2015-03-16': { tests: { ovulation: 'positive' } } };
    const s = buildSummary(d, '2015-03-16');
    // Window recentred: descent 03-16, from 03-12, to 03-17.
    expect(s.phase.window).toEqual({ from: '2015-03-12', descent: '2015-03-16', to: '2015-03-17' });
    expect(s.phase.fromTest).toBe(true);
    expect(s.adapted.fromTest).toBe(true);
    expect(buildSummary(pdoc(), '2015-03-16').phase.fromTest).toBe(false);
  });

  it('still moves the predicted date to the test day plus fourteen', () => {
    const d = pdoc();
    d.days = { '2015-03-16': { tests: { ovulation: 'positive' } } };
    // 03-16 + 14 = 03-30 (arithmetic was 03-26).
    expect(buildSummary(d, '2015-03-16').adapted.date).toBe('2015-03-30');
    expect(buildSummary(pdoc(), '2015-03-16').adapted.date).toBe('2015-03-26');
  });

  it('leaves the window unmoved and fromTest false when the test is inside it', () => {
    const d = pdoc();
    d.days = { '2015-03-10': { tests: { ovulation: 'positive' } } };
    const s = buildSummary(d, '2015-03-10');
    expect(s.phase.window).toEqual({ from: '2015-03-08', descent: '2015-03-12', to: '2015-03-13' });
    expect(s.phase.fromTest).toBe(false);
    expect(s.adapted.date).toBe('2015-03-26');
  });

  it('always carries the fixed caveat, verbatim', () => {
    expect(buildSummary(pdoc(), '2015-03-01').phase.caveat.fixed).toBe(FIXED);
    expect(buildSummary({}, '2015-03-01').phase.caveat.fixed).toBe(FIXED);
  });

  it('says the sample is thin, not that the cycles vary, when every cycle is the same length', () => {
    // Two 28-day cycles: sigma is exactly 0 and nEff < 2, so the caveat fires on
    // sample size alone. A "± 0 days" claim here would be a false precision.
    const c = buildSummary(pdoc(), '2015-03-01').phase.caveat.uncertainty;
    expect(c).toBe('This prediction is based on only a few cycles, '
      + 'so these days could be off by several days or more.');
    expect(c).not.toMatch(/±/);
  });

  it('names the spread, with the model\u2019s own rounded sigma, when cycles vary', () => {
    // Cycles of 24 and 32 days. Weights 0.5^(age/365): ages 59 and 35 days give
    // 0.8940 and 0.9357. Weighted mean 28.09; sum w(x-m)^2 = 29.26; denominator
    // v1 - v2/v1 = 1.8297 - 0.9153 = 0.9144; variance 32.0; sigma 5.66 -> N = 6.
    const d = { spans: [{ start: '2015-01-01' }, { start: '2015-01-25' }, { start: '2015-02-26' }] };
    const s = buildSummary(d, '2015-03-01');
    expect(s.adapted.sigma).toBeGreaterThan(5.5);
    expect(s.adapted.sigma).toBeLessThan(5.8);
    expect(s.phase.caveat.uncertainty).toBe(
      'Your recent cycles vary by about \u00b1 6 days, so these days could be off by that much or more.',
    );
  });

  it('adds no uncertainty caveat when the cycles are regular and the sample is large', () => {
    // 13 starts 28 days apart from 2015-01-01 -> 12 usable cycles, all 28 days:
    // sigma = 0. Today is the last start (day 337 of the year, 336 days after the
    // first), so the oldest cycle is 336 days old and every weight is at least
    // 0.5^(336/365) = 0.528; nEff >= 12*0.528 = 6.3 > 6.
    const starts = Array.from({ length: 13 }, (_, i) => {
      const d = new Date(Date.UTC(2015, 0, 1 + 28 * i));
      return d.toISOString().slice(0, 10);
    });
    const d = { spans: starts.map(start => ({ start })) };
    expect(starts[12]).toBe('2015-12-03');
    const s = buildSummary(d, starts[12]);
    expect(s.adapted.sigma).toBe(0);
    expect(s.adapted.nEff).toBeGreaterThan(6);
    expect(s.phase.caveat.uncertainty).toBeNull();
  });

  it('exposes the anchor the forward projections run from', () => {
    expect(buildSummary(pdoc(), '2015-03-01').adapted.anchor).toBe('2015-02-26');
  });

  it('reports no phase when nothing is logged', () => {
    const s = buildSummary({}, '2015-03-01');
    expect(s.phase.name).toBe('unknown');
    expect(s.phase.cycleDay).toBeNull();
    expect(s.phase.window).toBeNull();
    // Unavailable model: sigma is null, and no number may be claimed.
    expect(s.phase.caveat.uncertainty).toBe(SAMPLE);
  });
});

describe('the caveat copy she will actually read', () => {
  const real = [
    buildSummary(doc(SUPPRESS), '2015-07-15').phase.caveat.fixed,
    uncertaintyCaveat({ available: true, sigma: 5, nEff: 10 }),
    uncertaintyCaveat({ available: true, sigma: 0, nEff: 2 }),
  ];

  it('has all three strings to check', () => {
    for (const text of real) expect(text).toMatch(/\S/);
    expect(new Set(real).size).toBe(3);
  });

  // The fixed copy says "is not a safe day" to deny it, so the phrase is
  // allowed only in that negated form.
  it('never says an unmarked day is safe, or that a day is not fertile or infertile', () => {
    for (const text of real) {
      expect(text.replace(/not a safe day/gi, '')).not.toMatch(/safe day/i);
      expect(text).not.toMatch(/not fertile|infertile/i);
    }
  });
});
