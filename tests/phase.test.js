import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffDays } from '../src/dates.js';
import { firstProjection } from '../src/predict.js';
import {
  LUTEAL_DAYS, WINDOW_DAYS, DESCENT_POSITION,
  descentFor, windowFor, firstPositiveTest, applyTestOverride, cycleWindows, phaseAt, movedNextStart, nextStartForDoc,
} from '../src/phase.js';

const diffInclusive = (a, b) => diffDays(a, b) + 1;

describe('constants', () => {
  it('pins the owner’s numbers', () => {
    expect(LUTEAL_DAYS).toBe(14);
    expect(WINDOW_DAYS).toBe(6);
    expect(DESCENT_POSITION).toBe(5);
  });
});

describe('descentFor', () => {
  it('counts back a fixed luteal phase from the next period start', () => {
    expect(descentFor('2015-03-29')).toBe('2015-03-15');
  });
});

describe('windowFor', () => {
  it('puts descent on the fifth of six days', () => {
    const w = windowFor('2015-03-15', '2015-03-01');
    expect(w).toEqual({ from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16' });
    expect(diffInclusive(w.from, w.to)).toBe(WINDOW_DAYS);
    expect(diffInclusive(w.from, w.descent)).toBe(DESCENT_POSITION);
  });

  it('omits the window when descent lands on or before the cycle start', () => {
    // A 14-day cycle: 2015-03-15 minus 14 is the cycle’s own start.
    expect(windowFor(descentFor('2015-03-15'), '2015-03-01')).toBeNull();
  });

  it('clamps the window’s start to the cycle start rather than reaching into the previous cycle', () => {
    // A 15-day cycle: descent is day 2, so descent - 4 precedes the cycle.
    const w = windowFor(descentFor('2015-03-16'), '2015-03-01');
    expect(w).toEqual({ from: '2015-03-01', descent: '2015-03-02', to: '2015-03-03' });
  });
});

describe('firstPositiveTest', () => {
  const doc = { days: {
    '2015-03-05': { tests: { ovulation: 'negative' } },
    '2015-03-20': { tests: { ovulation: 'positive' } },
    '2015-03-24': { tests: { ovulation: 'positive' } },
    '2015-04-02': { tests: { ovulation: 'positive' } },
  } };

  it('finds the earliest positive inside the cycle, the surge', () => {
    expect(firstPositiveTest(doc, '2015-03-01', '2015-03-29')).toBe('2015-03-20');
  });

  it('excludes the next cycle’s start from the search', () => {
    expect(firstPositiveTest(doc, '2015-03-29', '2015-04-26')).toBe('2015-04-02');
  });

  it('does not count a positive on the next cycle’s own start day', () => {
    const edge = { days: { '2015-03-29': { tests: { ovulation: 'positive' } } } };
    expect(firstPositiveTest(edge, '2015-03-01', '2015-03-29')).toBeNull();
    expect(firstPositiveTest(edge, '2015-03-29', '2015-04-26')).toBe('2015-03-29');
  });

  it('ignores a negative result', () => {
    expect(firstPositiveTest(doc, '2015-03-01', '2015-03-10')).toBeNull();
  });

  it('tolerates a document with no days at all', () => {
    expect(firstPositiveTest({}, '2015-03-01', '2015-03-29')).toBeNull();
    expect(firstPositiveTest({ days: undefined }, '2015-03-01', '2015-03-29')).toBeNull();
  });
});

describe('applyTestOverride', () => {
  const w = { from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16' };

  it('leaves the window alone when the test falls inside it', () => {
    expect(applyTestOverride(w, '2015-03-13', '2015-03-01')).toEqual({ ...w, fromTest: false });
  });

  it('leaves the window alone on its first and last day', () => {
    expect(applyTestOverride(w, '2015-03-11', '2015-03-01').fromTest).toBe(false);
    expect(applyTestOverride(w, '2015-03-16', '2015-03-01').fromTest).toBe(false);
  });

  it('recentres on the test date when it falls outside', () => {
    expect(applyTestOverride(w, '2015-03-22', '2015-03-01')).toEqual({
      from: '2015-03-18', descent: '2015-03-22', to: '2015-03-23', fromTest: true,
    });
  });

  it('keeps the arithmetic window when the test cannot anchor a window', () => {
    // A positive on the cycle's own first day: windowFor would be null.
    expect(applyTestOverride(w, '2015-03-01', '2015-03-01')).toEqual({ ...w, fromTest: false });
    expect(applyTestOverride(w, '2015-03-01', '2015-03-01').from).toBeDefined();
  });

  it('reports no override when there is no test', () => {
    expect(applyTestOverride(w, null, '2015-03-01')).toEqual({ ...w, fromTest: false });
  });
});

describe('cycleWindows', () => {
  const doc = { spans: [{ start: '2015-03-01', end: '2015-03-05' },
                        { start: '2015-03-29', end: '2015-04-02' }] };
  const logged = start => ({ '2015-03-01': '2015-03-29', '2015-03-29': '2015-04-26' }[start] ?? null);

  it('builds one window per cycle that has a next start', () => {
    const windows = cycleWindows(doc, { nextStartFor: logged, fromISO: '2015-03-01', toISO: '2015-04-30' });
    expect(windows.map(w => w.descent)).toEqual(['2015-03-15', '2015-04-12']);
    expect(windows.map(w => w.cycleStart)).toEqual(['2015-03-01', '2015-03-29']);
  });

  it('keeps only windows overlapping the requested range', () => {
    const windows = cycleWindows(doc, { nextStartFor: logged, fromISO: '2015-04-01', toISO: '2015-04-30' });
    expect(windows.map(w => w.descent)).toEqual(['2015-04-12']);
  });

  it('omits a cycle whose next start is unknown', () => {
    const windows = cycleWindows(doc, { nextStartFor: () => null, fromISO: '2015-03-01', toISO: '2015-04-30' });
    expect(windows).toEqual([]);
  });

  it('returns nothing when no period has been logged', () => {
    expect(cycleWindows({}, { nextStartFor: logged, fromISO: '2015-03-01', toISO: '2015-04-30' })).toEqual([]);
  });

  it('skips a cycle too short to hold a window instead of throwing', () => {
    const short = { spans: [{ start: '2015-03-01' }] };
    expect(cycleWindows(short, { nextStartFor: () => '2015-03-10', fromISO: '2015-03-01', toISO: '2015-03-31' })).toEqual([]);
  });

  it('recentres on a positive ovulation test and reports fromTest', () => {
    const tested = { ...doc, days: { '2015-03-22': { tests: { ovulation: 'positive' } } } };
    const windows = cycleWindows(tested, { nextStartFor: logged, fromISO: '2015-03-01', toISO: '2015-03-31' });
    expect(windows[0]).toMatchObject({ descent: '2015-03-22', fromTest: true });
  });

  it('sorts spans before walking them', () => {
    const unsorted = { spans: [doc.spans[1], doc.spans[0]] };
    const windows = cycleWindows(unsorted, { nextStartFor: logged, fromISO: '2015-03-01', toISO: '2015-04-30' });
    expect(windows.map(w => w.cycleStart)).toEqual(['2015-03-01', '2015-03-29']);
  });
});

describe('cycleWindows suppression', () => {
  const spans = [{ start: '2015-03-01', end: '2015-03-05' }, { start: '2015-03-29' }];
  const logged = () => '2015-03-29';
  const range = { nextStartFor: logged, fromISO: '2015-03-01', toISO: '2015-03-31' };
  const withEpisode = episode => ({ spans, birthControl: [episode] });

  it('draws no window when the descent day is governed by a suppressing method', () => {
    const doc = withEpisode({ method: 'implant', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'suppress' });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('draws no window under a regulating method either', () => {
    const doc = withEpisode({ method: 'pill', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'regulate' });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('draws the window under a method with no hormonal effect', () => {
    const doc = withEpisode({ method: 'condoms', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'none' });
    expect(cycleWindows(doc, range).map(w => w.descent)).toEqual(['2015-03-15']);
  });

  it('suppresses on an unrecognised effect, as sigmaForEffect does', () => {
    const doc = withEpisode({ method: 'mystery', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'whatever' });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('suppresses when the effect is missing entirely', () => {
    const doc = withEpisode({ method: 'mystery', startedOn: '2015-03-10', endedOn: null });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('suppresses even when the method name is stripped', () => {
    const doc = withEpisode({ startedOn: '2015-03-10', endedOn: null, expectedEffect: 'suppress' });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('shows the window whole or not at all across a method boundary', () => {
    // The method starts the day after descent, so the descent day is free and
    // the whole six days are drawn rather than the four before the boundary.
    const doc = withEpisode({ method: 'implant', startedOn: '2015-03-16', endedOn: null, expectedEffect: 'suppress' });
    const windows = cycleWindows(doc, range);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ from: '2015-03-11', to: '2015-03-16' });
  });

  it('reads the most recently started episode when two overlap', () => {
    const doc = { spans, birthControl: [
      { method: 'implant', startedOn: '2015-03-01', endedOn: null, expectedEffect: 'suppress' },
      { method: 'condoms', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'none' },
    ] };
    expect(cycleWindows(doc, range).map(w => w.descent)).toEqual(['2015-03-15']);
  });

  it('prefers the still-open episode when two share a start date', () => {
    // Open one listed first, so "last in stored order wins" would get it wrong.
    const doc = { spans, birthControl: [
      { method: 'condoms', startedOn: '2015-03-10', endedOn: null, expectedEffect: 'none' },
      { method: 'implant', startedOn: '2015-03-10', endedOn: '2015-03-20', expectedEffect: 'suppress' },
    ] };
    expect(cycleWindows(doc, range).map(w => w.descent)).toEqual(['2015-03-15']);
  });

  it('treats endedOn as inclusive: a method removed on descent day still governs it', () => {
    const doc = withEpisode({ method: 'implant', startedOn: '2015-03-01', endedOn: '2015-03-15', expectedEffect: 'suppress' });
    expect(cycleWindows(doc, range)).toEqual([]);
  });

  it('does not suppress once the method has ended before descent day', () => {
    const doc = withEpisode({ method: 'implant', startedOn: '2015-03-01', endedOn: '2015-03-14', expectedEffect: 'suppress' });
    expect(cycleWindows(doc, range).map(w => w.descent)).toEqual(['2015-03-15']);
  });

  it('suppresses on the recentred descent day when a test moves the window', () => {
    // Method starts 03-20; arithmetic descent 03-15 is free, test descent 03-22 is not.
    const doc = { spans, birthControl: [{ method: 'implant', startedOn: '2015-03-20', endedOn: null, expectedEffect: 'suppress' }],
      days: { '2015-03-22': { tests: { ovulation: 'positive' } } } };
    expect(cycleWindows(doc, range)).toEqual([]);
  });
});

describe('cycleWindows and a late period', () => {
  it('holds the current cycle’s window where it was predicted when a period is late', () => {
    const doc = { spans: [{ start: '2015-03-01', end: '2015-03-05' }] };
    // The caller pins the next start (Ruling 5), so the same window comes back
    // however late it gets. cycleWindows must not consult a clock of its own.
    const pinned = () => '2015-03-29';
    const windows = cycleWindows(doc, { nextStartFor: pinned, fromISO: '2015-03-01', toISO: '2015-05-31' });
    expect(windows.map(w => w.descent)).toEqual(['2015-03-15']);
  });

  // The real enforcement of the test above. The current cycle's window is
  // pinned by the caller so it cannot creep forward a day per day while a
  // period is late; a window that walked away from days already shown as
  // fertile would un-mark them for someone using this to avoid pregnancy.
  // The structural guarantee is that this module cannot know what day it is,
  // so assert over the source: no clock, no today parameter.
  it('has no clock: src/phase.js neither calls new Date() nor takes todayISO', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const src = readFileSync(join(root, 'src/phase.js'), 'utf8');
    expect(src).toMatch(/export function cycleWindows/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/todayISO/);
    expect(src).not.toMatch(/Date\.now/);
  });
});

describe('phaseAt', () => {
  const doc = { spans: [{ start: '2015-03-01', end: '2015-03-05' }, { start: '2015-03-29' }] };
  const windows = [{ from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16', cycleStart: '2015-03-01', fromTest: false }];

  it('names a logged bleeding day', () => {
    expect(phaseAt(doc, '2015-03-03', windows)).toBe('period');
  });
  it('names the days before the window', () => {
    expect(phaseAt(doc, '2015-03-08', windows)).toBe('follicular');
  });
  it('names the window', () => {
    expect(phaseAt(doc, '2015-03-11', windows)).toBe('fertile');
    expect(phaseAt(doc, '2015-03-16', windows)).toBe('fertile');
  });
  it('names the days after the window', () => {
    expect(phaseAt(doc, '2015-03-20', windows)).toBe('luteal');
  });
  it('covers an open span on its start day only, matching calendar and day', () => {
    expect(phaseAt(doc, '2015-03-29', windows)).toBe('period');
    expect(phaseAt(doc, '2015-03-30', windows)).not.toBe('period');
    expect(phaseAt(doc, '2015-03-31', windows)).not.toBe('period');
  });
  it('matches the window of the cycle containing the date, not stored order', () => {
    const two = [
      ...windows,
      { from: '2015-04-08', descent: '2015-04-12', to: '2015-04-13', cycleStart: '2015-03-29', fromTest: false },
    ];
    expect(phaseAt(doc, '2015-04-05', two)).toBe('follicular');
    expect(phaseAt(doc, '2015-04-10', two)).toBe('fertile');
    expect(phaseAt(doc, '2015-04-20', two)).toBe('luteal');
  });
  it('is unknown with no cycle to count from', () => {
    expect(phaseAt({}, '2015-03-20', [])).toBe('unknown');
  });
  it('is unknown when the cycle has no window, as under a suppressing method', () => {
    expect(phaseAt(doc, '2015-03-20', [])).toBe('unknown');
  });
  it('keeps the fertile mark on a bleeding day in a short cycle, and still names the day period', () => {
    // A 21-day cycle: descent is day 8, so the window opens on day 4 — inside
    // a five-day period. Ruling 8: the mark stays, because hiding a day the
    // arithmetic flags is the one direction this feature may not fail in.
    const short = { spans: [{ start: '2015-03-01', end: '2015-03-05' }, { start: '2015-03-22' }] };
    const w = cycleWindows(short, {
      nextStartFor: () => '2015-03-22', fromISO: '2015-03-01', toISO: '2015-03-31',
    });
    expect(w[0]).toMatchObject({ from: '2015-03-04', descent: '2015-03-08', to: '2015-03-09' });
    expect(phaseAt(short, '2015-03-04', w)).toBe('period');
  });
});

describe('movedNextStart', () => {
  const doc = { days: { '2015-03-22': { tests: { ovulation: 'positive' } } } };

  it('moves the next start to a luteal phase after a test outside the window', () => {
    // Predicted next 2015-03-29 puts the window at 03-11..03-16; the test is
    // outside it, so descent becomes 03-22 and the period 14 days later.
    expect(movedNextStart(doc, '2015-03-01', '2015-03-29')).toBe('2015-04-05');
  });

  it('does not move when the test falls inside the window', () => {
    const inside = { days: { '2015-03-13': { tests: { ovulation: 'positive' } } } };
    expect(movedNextStart(inside, '2015-03-01', '2015-03-29')).toBeNull();
  });

  it('does not move without a positive test', () => {
    expect(movedNextStart({}, '2015-03-01', '2015-03-29')).toBeNull();
  });

  it('does not move when the cycle is too short to have a window', () => {
    expect(movedNextStart(doc, '2015-03-01', '2015-03-15')).toBeNull();
  });
});

describe('movedNextStart on a hormonal method', () => {
  const days = { '2015-03-22': { tests: { ovulation: 'positive' } } };
  const on = effect => ({
    days,
    birthControl: [{ method: 'pill', startedOn: '2015-01-01', endedOn: null, expectedEffect: effect }],
  });

  it('does not move the date when the method suppresses, as the window is not drawn either', () => {
    expect(movedNextStart(on('suppress'), '2015-03-01', '2015-03-29')).toBeNull();
  });

  it('still moves the date on a method with effect none', () => {
    expect(movedNextStart(on('none'), '2015-03-01', '2015-03-29')).toBe('2015-04-05');
  });
});

describe('nextStartForDoc', () => {
  const d = {
    spans: [{ start: '2015-01-01' }, { start: '2015-01-29' }, { start: '2015-02-26' }],
  };

  it('returns the logged following start for a cycle that has one', () => {
    const f = nextStartForDoc(d, { anchor: '2015-02-26', length: 28 });
    expect(f('2015-01-01')).toBe('2015-01-29');
    expect(f('2015-01-29')).toBe('2015-02-26');
  });

  it('pins the current cycle to the first projection, with no clock to advance it', () => {
    // 2015-02-26 + 28 = 2015-03-26. Nothing in the signature is a date today.
    const f = nextStartForDoc(d, { anchor: '2015-02-26', length: 28 });
    expect(f('2015-02-26')).toBe('2015-03-26');
    expect(f('2015-02-26')).toBe(firstProjection('2015-02-26', 28));
  });

  it('rounds a fractional length the way firstProjection does', () => {
    // round(28.5) = 29; 2015-02-26 + 29 = 2015-03-27.
    const f = nextStartForDoc(d, { anchor: '2015-02-26', length: 28.5 });
    expect(f('2015-02-26')).toBe('2015-03-27');
    expect(f('2015-02-26')).toBe(firstProjection('2015-02-26', 28.5));
  });

  it('declines to name a next start when there is no prediction to pin', () => {
    const f = nextStartForDoc(d, { anchor: null, length: null });
    expect(f('2015-02-26')).toBeNull();
    expect(f('2015-01-29')).toBe('2015-02-26');
  });

  it('names no pinned start for a cycle that is not the anchor\u2019s', () => {
    // The anchor 2015-03-05 is not the last logged start (2015-02-26), so the
    // projection does not belong to that cycle and nothing is claimed.
    const f = nextStartForDoc(d, { anchor: '2015-03-05', length: 28 });
    expect(f('2015-02-26')).toBeNull();
  });

  it('moves the current next start when a positive test lies outside the window', () => {
    // Predicted 03-26, window 03-08..03-13. Positive on 03-16 -> descent 03-16,
    // next start 03-16 + 14 = 03-30.
    const withTest = { ...d, days: { '2015-03-16': { tests: { ovulation: 'positive' } } } };
    const f = nextStartForDoc(withTest, { anchor: '2015-02-26', length: 28 });
    expect(f('2015-02-26')).toBe('2015-03-30');
  });
});
