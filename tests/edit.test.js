import { describe, it, expect } from 'vitest';
import { EDIT_SOURCE, setDayFields, setFlow, setApproximate, spanCovering } from '../src/edit.js';

const doc = (overrides = {}) => ({
  version: 1, days: {}, spans: [], gaps: [], birthControl: [], ...overrides,
});

const imported = () => doc({
  spans: [
    // A legacy period with no day entries behind it — 48 of hers look like this.
    { start: '2015-01-01', end: '2015-01-05', precision: 'exact', endPrecision: 'exact', source: 'legacy' },
    { start: '2015-01-29', end: '2015-02-02', precision: 'exact', endPrecision: 'exact', source: 'clue' },
  ],
  days: {
    '2015-01-29': {
      flow: 'heavy', cramps: 'unknown', spotting: null, pms: false, mood: ['sad'],
      discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [],
      notes: '', source: 'clue', precision: 'exact',
    },
  },
});

describe('purity', () => {
  it('leaves the document it was given untouched', () => {
    const before = imported();
    const snapshot = JSON.stringify(before);
    setDayFields(before, '2015-01-29', { cramps: 'strong' });
    setFlow(before, '2015-03-01', 'medium');
    setApproximate(before, '2015-01-29', true);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('returns a document whose other days are the same objects or equal to them', () => {
    const before = imported();
    const after = setDayFields(before, '2015-03-01', { notes: 'hello' });
    expect(after.days['2015-01-29']).toEqual(before.days['2015-01-29']);
    expect(after.spans).toEqual(before.spans);
  });
});

describe('setDayFields', () => {
  it('creates a day that did not exist', () => {
    const after = setDayFields(doc(), '2015-03-01', { cramps: 'strong' });
    expect(after.days['2015-03-01'].cramps).toBe('strong');
  });

  it('gives a new day every field the model defines', () => {
    const day = setDayFields(doc(), '2015-03-01', { cramps: 'strong' }).days['2015-03-01'];
    for (const field of ['flow', 'cramps', 'spotting', 'pms', 'mood', 'discharge', 'tests', 'pain', 'notes']) {
      expect(day, field).toHaveProperty(field);
    }
  });

  it('stamps her own entries as manual, which outranks every importer', () => {
    expect(setDayFields(doc(), '2015-03-01', { cramps: 'strong' }).days['2015-03-01'].source)
      .toBe(EDIT_SOURCE);
  });

  it('updates one field of an existing day and leaves the rest', () => {
    const after = setDayFields(imported(), '2015-01-29', { cramps: 'strong' });
    expect(after.days['2015-01-29'].cramps).toBe('strong');
    expect(after.days['2015-01-29'].flow).toBe('heavy');
    expect(after.days['2015-01-29'].mood).toEqual(['sad']);
  });

  // Review Focus 3: 'none' is a value she recorded; undefined means she never
  // did. Collapsing them would turn "no cramps today" into "did not say".
  it('keeps a recorded none distinct from an unrecorded field', () => {
    const after = setDayFields(doc(), '2015-03-01', { cramps: 'none' });
    expect(after.days['2015-03-01'].cramps).toBe('none');
    expect(after.days['2015-03-01'].discharge).toBeNull();
  });

  it('clears a field set to null', () => {
    const after = setDayFields(imported(), '2015-01-29', { cramps: null });
    expect(after.days['2015-01-29'].cramps).toBeNull();
  });

  it('replaces a list rather than appending to it', () => {
    const after = setDayFields(imported(), '2015-01-29', { mood: ['happy', 'calm'] });
    expect(after.days['2015-01-29'].mood).toEqual(['happy', 'calm']);
  });

  it('copies lists rather than sharing them with the patch', () => {
    const mood = ['happy'];
    const after = setDayFields(doc(), '2015-03-01', { mood });
    mood.push('angry');
    expect(after.days['2015-03-01'].mood).toEqual(['happy']);
  });

  it('writes both test results', () => {
    const after = setDayFields(doc(), '2015-03-01', {
      tests: { ovulation: 'positive', pregnancy: 'negative' },
    });
    expect(after.days['2015-03-01'].tests).toEqual({ ovulation: 'positive', pregnancy: 'negative' });
  });

  it('takes a note verbatim', () => {
    const after = setDayFields(doc(), '2015-03-01', { notes: '  ran 5k, felt fine  ' });
    expect(after.days['2015-03-01'].notes).toBe('ran 5k, felt fine');
  });

  it('removes a day emptied of everything', () => {
    const after = setDayFields(imported(), '2015-01-29', {
      flow: null, cramps: null, spotting: null, pms: false, mood: [],
      discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [], notes: '',
    });
    expect(after.days['2015-01-29']).toBeUndefined();
  });

  it('keeps a day that holds only a false-looking but real value', () => {
    const after = setDayFields(doc(), '2015-03-01', { pms: true });
    expect(after.days['2015-03-01'].pms).toBe(true);
  });

  it('refuses a date that is not a real calendar date', () => {
    expect(() => setDayFields(doc(), '2015-02-30', { pms: true })).toThrow();
  });
});

describe('setApproximate', () => {
  it('marks a date as approximate', () => {
    expect(setApproximate(imported(), '2015-01-29', true).days['2015-01-29'].precision)
      .toBe('approx');
  });

  it('marks it exact again', () => {
    const approx = setApproximate(imported(), '2015-01-29', true);
    expect(setApproximate(approx, '2015-01-29', false).days['2015-01-29'].precision)
      .toBe('exact');
  });

  it('does nothing to a day that does not exist', () => {
    const after = setApproximate(doc(), '2015-03-01', true);
    expect(after.days['2015-03-01']).toBeUndefined();
  });
});

describe('spanCovering', () => {
  const spans = imported().spans;

  it('finds the span a date sits inside', () => {
    expect(spanCovering(spans, '2015-01-03').start).toBe('2015-01-01');
  });

  it('includes both ends', () => {
    expect(spanCovering(spans, '2015-01-01')).not.toBeNull();
    expect(spanCovering(spans, '2015-01-05')).not.toBeNull();
  });

  it('returns null outside every span', () => {
    expect(spanCovering(spans, '2015-01-10')).toBeNull();
  });

  it('treats a span with no end as one day', () => {
    const open = [{ start: '2015-01-01', end: null, source: 'legacy' }];
    expect(spanCovering(open, '2015-01-01')).not.toBeNull();
    expect(spanCovering(open, '2015-01-02')).toBeNull();
  });
});

describe('setFlow — recording bleeding', () => {
  it('writes the flow onto the day', () => {
    expect(setFlow(doc(), '2015-03-01', 'medium').days['2015-03-01'].flow).toBe('medium');
  });

  it('opens a new one-day period where none existed', () => {
    const after = setFlow(doc(), '2015-03-01', 'medium');
    expect(after.spans).toEqual([
      { start: '2015-03-01', end: '2015-03-01', precision: 'exact', endPrecision: 'exact', source: EDIT_SOURCE },
    ]);
  });

  it('extends a period forward when the day follows it', () => {
    const after = setFlow(imported(), '2015-01-06', 'light');
    expect(spanCovering(after.spans, '2015-01-06').start).toBe('2015-01-01');
    expect(spanCovering(after.spans, '2015-01-06').end).toBe('2015-01-06');
    expect(after.spans).toHaveLength(2);
  });

  it('extends a period backward when the day precedes it', () => {
    const after = setFlow(imported(), '2014-12-31', 'light');
    const span = spanCovering(after.spans, '2014-12-31');
    expect(span.start).toBe('2014-12-31');
    expect(span.end).toBe('2015-01-05');
    expect(after.spans).toHaveLength(2);
  });

  it('keeps the spans in date order after extending backward', () => {
    const after = setFlow(imported(), '2014-12-31', 'light');
    expect(after.spans.map(span => span.start)).toEqual(['2014-12-31', '2015-01-29']);
  });

  it('joins two periods when the day closes the gap between them', () => {
    const touching = doc({
      spans: [
        { start: '2015-01-01', end: '2015-01-03', precision: 'exact', endPrecision: 'exact', source: 'legacy' },
        { start: '2015-01-05', end: '2015-01-07', precision: 'exact', endPrecision: 'exact', source: 'legacy' },
      ],
    });
    const after = setFlow(touching, '2015-01-04', 'light');
    expect(after.spans).toHaveLength(1);
    expect(after.spans[0].start).toBe('2015-01-01');
    expect(after.spans[0].end).toBe('2015-01-07');
  });

  it('changes intensity inside a period without touching the span', () => {
    const after = setFlow(imported(), '2015-01-29', 'light');
    expect(after.days['2015-01-29'].flow).toBe('light');
    expect(after.spans).toEqual(imported().spans);
  });

  // Review Focus 2: the 48 periods with no day entries behind them.
  it('leaves every other period alone, including ones with no day entries', () => {
    const after = setFlow(imported(), '2015-06-01', 'medium');
    expect(spanCovering(after.spans, '2015-01-03')).not.toBeNull();
    expect(spanCovering(after.spans, '2015-01-30')).not.toBeNull();
    expect(after.spans).toHaveLength(3);
  });

  // 5 of her real spans start approximate and 7 end approximate — lines in
  // the hand-written log marked "approx", "(est.)" or "midnight". An
  // endpoint that does not move under an edit must keep its own precision.
  it('extending forward from a span whose start is approximate keeps that start approximate', () => {
    const approxStart = doc({
      spans: [{ start: '2015-01-01', end: '2015-01-03', precision: 'approx', endPrecision: 'exact', source: 'legacy' }],
    });
    const after = setFlow(approxStart, '2015-01-04', 'light');
    const extended = spanCovering(after.spans, '2015-01-04');
    expect(extended.precision).toBe('approx');
    expect(extended.endPrecision).toBe('exact');
  });

  it('extending backward into a span whose end is approximate keeps that end approximate', () => {
    const approxEnd = doc({
      spans: [{ start: '2015-01-05', end: '2015-01-07', precision: 'exact', endPrecision: 'approx', source: 'legacy' }],
    });
    const after = setFlow(approxEnd, '2015-01-04', 'light');
    const extended = spanCovering(after.spans, '2015-01-04');
    expect(extended.precision).toBe('exact');
    expect(extended.endPrecision).toBe('approx');
  });

  it('a gap-closing merge keeps the first span\'s start precision and the second span\'s end precision', () => {
    const touching = doc({
      spans: [
        { start: '2015-01-01', end: '2015-01-03', precision: 'approx', endPrecision: 'exact', source: 'legacy' },
        { start: '2015-01-05', end: '2015-01-07', precision: 'exact', endPrecision: 'approx', source: 'legacy' },
      ],
    });
    const after = setFlow(touching, '2015-01-04', 'light');
    expect(after.spans).toHaveLength(1);
    expect(after.spans[0].precision).toBe('approx');
    expect(after.spans[0].endPrecision).toBe('approx');
  });
});

describe('setFlow — taking bleeding back', () => {
  const threeDay = () => doc({
    spans: [{ start: '2015-03-01', end: '2015-03-03', precision: 'exact', endPrecision: 'exact', source: 'manual' }],
    days: {
      '2015-03-01': { flow: 'light', cramps: null, spotting: null, pms: false, mood: [], discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [], notes: '', source: 'manual', precision: 'exact' },
      '2015-03-02': { flow: 'heavy', cramps: null, spotting: null, pms: false, mood: [], discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [], notes: '', source: 'manual', precision: 'exact' },
      '2015-03-03': { flow: 'light', cramps: null, spotting: null, pms: false, mood: [], discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [], notes: '', source: 'manual', precision: 'exact' },
    },
  });

  it('clears the flow from the day', () => {
    // threeDay()'s 03-02 holds nothing but flow, so clearing it alone would
    // empty the day away entirely (see "removes a day left holding nothing
    // at all" below) — give it a note first so there is a day left to check.
    const withNote = setDayFields(threeDay(), '2015-03-02', { notes: 'ibuprofen' });
    expect(setFlow(withNote, '2015-03-02', null).days['2015-03-02'].flow).toBeNull();
  });

  it('shrinks the period when the first day is taken back', () => {
    const after = setFlow(threeDay(), '2015-03-01', null);
    expect(after.spans).toHaveLength(1);
    expect(after.spans[0].start).toBe('2015-03-02');
    expect(after.spans[0].end).toBe('2015-03-03');
  });

  it('shrinks the period when the last day is taken back', () => {
    const after = setFlow(threeDay(), '2015-03-03', null);
    expect(after.spans[0].start).toBe('2015-03-01');
    expect(after.spans[0].end).toBe('2015-03-02');
  });

  it('splits the period when a middle day is taken back', () => {
    const after = setFlow(threeDay(), '2015-03-02', null);
    expect(after.spans).toHaveLength(2);
    expect(after.spans[0]).toMatchObject({ start: '2015-03-01', end: '2015-03-01' });
    expect(after.spans[1]).toMatchObject({ start: '2015-03-03', end: '2015-03-03' });
  });

  it('shrinking from the start leaves the unmoved end\'s approximate intact and makes the new start exact', () => {
    const approxEnd = doc({
      spans: [{ start: '2015-03-01', end: '2015-03-03', precision: 'exact', endPrecision: 'approx', source: 'manual' }],
    });
    const after = setFlow(approxEnd, '2015-03-01', null);
    expect(after.spans).toHaveLength(1);
    expect(after.spans[0]).toMatchObject({
      start: '2015-03-02', end: '2015-03-03', precision: 'exact', endPrecision: 'approx',
    });
  });

  it('splitting keeps the outer two precisions and makes both inner endpoints exact', () => {
    const approxBoth = doc({
      spans: [{ start: '2015-03-01', end: '2015-03-03', precision: 'approx', endPrecision: 'approx', source: 'manual' }],
    });
    const after = setFlow(approxBoth, '2015-03-02', null);
    expect(after.spans).toHaveLength(2);
    expect(after.spans[0]).toMatchObject({
      start: '2015-03-01', end: '2015-03-01', precision: 'approx', endPrecision: 'exact',
    });
    expect(after.spans[1]).toMatchObject({
      start: '2015-03-03', end: '2015-03-03', precision: 'exact', endPrecision: 'approx',
    });
  });

  it('removes a one-day period entirely', () => {
    const oneDay = doc({
      spans: [{ start: '2015-03-01', end: '2015-03-01', precision: 'exact', endPrecision: 'exact', source: 'manual' }],
    });
    expect(setFlow(oneDay, '2015-03-01', null).spans).toEqual([]);
  });

  it('does nothing to the spans when the day was never part of one', () => {
    const after = setFlow(imported(), '2015-06-01', null);
    expect(after.spans).toEqual(imported().spans);
  });

  it('keeps the rest of the day when only the flow is taken back', () => {
    const withSymptoms = setDayFields(threeDay(), '2015-03-02', { cramps: 'strong' });
    const after = setFlow(withSymptoms, '2015-03-02', null);
    expect(after.days['2015-03-02'].cramps).toBe('strong');
  });

  it('removes a day left holding nothing at all', () => {
    const after = setFlow(threeDay(), '2015-03-02', null);
    expect(after.days['2015-03-02']).toBeUndefined();
  });

  it('marks a span it edited as manual, so a re-import cannot undo her', () => {
    const after = setFlow(threeDay(), '2015-03-01', null);
    expect(after.spans[0].source).toBe(EDIT_SOURCE);
  });
});
