import { describe, it, expect } from 'vitest';
import { mergeSources, MERGE_DAY_FIELDS } from '../src/merge.js';
import { blankDay } from '../src/importers/clue.js';

const legacySpan = { start: '2015-01-01', end: '2015-01-05', precision: 'exact', endPrecision: 'exact', source: 'legacy' };
const clueSpan = { start: '2016-01-01', end: '2016-01-04', precision: 'exact', endPrecision: 'exact', source: 'clue' };

describe('mergeSources', () => {
  it('produces a versioned document', () => {
    const { doc } = mergeSources({ days: {}, spans: [], gaps: [] });
    expect(doc.version).toBe(1);
  });

  it('concatenates non-overlapping sources', () => {
    const { doc, conflicts } = mergeSources(
      { days: {}, spans: [legacySpan], gaps: [{ from: '2015-03-01', to: '2015-03-31', reason: 'not logged' }] },
      { days: {}, spans: [clueSpan], gaps: [], birthControl: [{ method: 'implant', startedOn: '2016-02-01', endedOn: null, expectedEffect: 'suppress' }] },
    );
    expect(doc.spans).toEqual([legacySpan, clueSpan]);
    expect(doc.gaps).toHaveLength(1);
    expect(doc.birthControl).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  it('sorts spans, gaps and episodes by date regardless of source order', () => {
    const { doc } = mergeSources({ days: {}, spans: [clueSpan], gaps: [] }, { days: {}, spans: [legacySpan], gaps: [] });
    expect(doc.spans.map(s => s.start)).toEqual(['2015-01-01', '2016-01-01']);
  });

  it('keeps both days when dates do not collide', () => {
    const { doc } = mergeSources(
      { days: { '2015-01-01': { ...blankDay('legacy') } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue') } }, spans: [], gaps: [] },
    );
    expect(Object.keys(doc.days).sort()).toEqual(['2015-01-01', '2016-01-01']);
  });

  it('lets clue win a scalar conflict over legacy and records it', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), flow: 'light' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'heavy' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].flow).toBe('heavy');
    expect(doc.days['2016-01-01'].source).toBe('clue');
    expect(conflicts).toEqual([{ date: '2016-01-01', field: 'flow', kept: 'heavy', discarded: 'light' }]);
  });

  it('does not let a null from the winning source erase a value', () => {
    const { doc } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), spotting: 'red' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'light' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].spotting).toBe('red');
    expect(doc.days['2016-01-01'].flow).toBe('light');
  });

  it('unions list fields and ORs pms', () => {
    const { doc } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), mood: ['sad'], pain: ['headache'], pms: true } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), mood: ['happy'], pain: ['headache'], pms: false } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].mood.sort()).toEqual(['happy', 'sad']);
    expect(doc.days['2016-01-01'].pain).toEqual(['headache']);
    expect(doc.days['2016-01-01'].pms).toBe(true);
  });

  it('treats a missing days, spans, gaps or birthControl key as empty', () => {
    const { doc } = mergeSources({});
    expect(doc).toMatchObject({ version: 1, days: {}, spans: [], gaps: [], birthControl: [] });
  });

  it('keeps both notes when each source has a different one', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), notes: 'cramps all day' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), notes: 'started late' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].notes).toBe('started late\n\ncramps all day');
    expect(conflicts).toEqual([]);
  });

  it('does not duplicate an identical note', () => {
    const { doc } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), notes: 'same text' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), notes: 'same text' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].notes).toBe('same text');
  });

  it('records a conflict when test results disagree', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), tests: { ovulation: null, pregnancy: 'positive' } } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), tests: { ovulation: null, pregnancy: 'negative' } } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].tests.pregnancy).toBe('negative');
    expect(conflicts).toEqual([
      { date: '2016-01-01', field: 'tests.pregnancy', kept: 'negative', discarded: 'positive' },
    ]);
  });

  it('keeps a test result the winning source does not have', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), tests: { ovulation: 'positive', pregnancy: null } } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'light' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].tests.ovulation).toBe('positive');
    expect(conflicts).toEqual([]);
  });

  it('marks the merged day approximate when either source is', () => {
    const { doc } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('legacy'), precision: 'approx' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'light' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].precision).toBe('approx');
  });

  it('breaks a precedence tie in favour of the later source, deterministically', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'light' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'heavy' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].flow).toBe('heavy');
    expect(conflicts).toEqual([
      { date: '2016-01-01', field: 'flow', kept: 'heavy', discarded: 'light' },
    ]);
  });

  // Finding 8: `manual` is the highest-precedence tier, protecting a user's
  // own hand-made correction from being overwritten by a re-import. Nothing
  // pinned this before.
  it('lets manual beat clue on a scalar conflict and records the conflict', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'heavy' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('manual'), flow: 'light' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].flow).toBe('light');
    expect(doc.days['2016-01-01'].source).toBe('manual');
    expect(conflicts).toEqual([
      { date: '2016-01-01', field: 'flow', kept: 'light', discarded: 'heavy' },
    ]);
  });

  it('lets manual win even when it is the first argument, because precedence is by rank not position', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('manual'), flow: 'light' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'heavy' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].flow).toBe('light');
    expect(doc.days['2016-01-01'].source).toBe('manual');
    expect(conflicts).toEqual([
      { date: '2016-01-01', field: 'flow', kept: 'light', discarded: 'heavy' },
    ]);
  });

  // Finding 11: a field added to blankDay without a matching update to
  // mergeDay would silently inherit the loser's stale value through the
  // `{ ...loser }` spread, with no error. This guards that coupling directly
  // rather than relying on a merge test that happens to build its fixtures
  // from blankDay itself.
  it('handles every field blankDay defines', () => {
    const blankFields = Object.keys(blankDay('clue'));
    const unhandled = blankFields.filter(field => !MERGE_DAY_FIELDS.includes(field));
    expect(unhandled, `mergeDay does not handle field(s): ${unhandled.join(', ')}`).toEqual([]);
    const extra = MERGE_DAY_FIELDS.filter(field => !blankFields.includes(field));
    expect(extra, `mergeDay handles field(s) blankDay does not define: ${extra.join(', ')}`).toEqual([]);
  });

  // Finding 4a: re-importing the same seed file is a realistic accident (the
  // install flow is "AirDrop the seed to the phone and import it"). An
  // identical duplicate must not double counts.
  it('deduplicates an identical span, gap and episode on re-import', () => {
    const gap = { from: '2015-03-01', to: '2015-03-31', reason: 'not logged' };
    const episode = { method: 'implant', startedOn: '2016-02-01', endedOn: null, expectedEffect: 'suppress' };
    const sourceDoc = { days: {}, spans: [legacySpan], gaps: [gap], birthControl: [episode] };

    const once = mergeSources(sourceDoc);
    const twice = mergeSources(sourceDoc, sourceDoc);

    expect(twice.doc.spans).toHaveLength(once.doc.spans.length);
    expect(twice.doc.gaps).toHaveLength(once.doc.gaps.length);
    expect(twice.doc.birthControl).toHaveLength(once.doc.birthControl.length);
    expect(twice.conflicts).toEqual([]);
  });

  it('keeps the higher-precedence span when two share a start but differ, and reports a conflict', () => {
    const legacyVersion = { ...legacySpan, end: '2015-01-05' };
    const clueVersion = { ...legacySpan, end: '2015-01-06', source: 'clue' };

    const { doc, conflicts } = mergeSources(
      { days: {}, spans: [legacyVersion], gaps: [] },
      { days: {}, spans: [clueVersion], gaps: [] },
    );

    expect(doc.spans).toEqual([clueVersion]);
    expect(conflicts).toEqual([
      { date: '2015-01-01', field: 'span', kept: clueVersion, discarded: legacyVersion },
    ]);
  });
});
