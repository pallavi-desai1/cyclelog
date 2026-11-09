import { describe, it, expect } from 'vitest';
import {
  mergeSources, mergeIntoDocument, mergeConflicts, describeConflicts, describeMerge, MERGE_DAY_FIELDS,
} from '../src/merge.js';
import { validateEpisode } from '../src/episodes-edit.js';
import { parseDocument, serializeDocument } from '../src/import.js';
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

  // Direction changed deliberately. This used to pin "the later source wins",
  // which was equally deterministic and fine while the only merge was two
  // import files of different ranks. It stopped being fine once Settings let
  // her re-import her own plaintext export: that file carries `manual` days,
  // so it met her on-device `manual` days as a tie, the file won, and every
  // correction she had made since taking the export reverted in silence. The
  // file came from this device, so on a tie the device holds the later truth.
  it('breaks a precedence tie in favour of what is already present, deterministically', () => {
    const { doc, conflicts } = mergeSources(
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'light' } }, spans: [], gaps: [] },
      { days: { '2016-01-01': { ...blankDay('clue'), flow: 'heavy' } }, spans: [], gaps: [] },
    );
    expect(doc.days['2016-01-01'].flow).toBe('light');
    expect(conflicts).toEqual([
      { date: '2016-01-01', field: 'flow', kept: 'light', discarded: 'heavy' },
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

describe('mergeIntoDocument', () => {
  const open = () => ({
    version: 1,
    days: { '2015-03-20': { flow: 'heavy', source: 'manual' } },
    spans: [], gaps: [], birthControl: [],
    sharing: { key: 'SYNCKEY', scope: 'symptoms', viewers: [{ uid: 'viewer-one' }] },
  });
  const incoming = () => ({
    version: 1,
    days: { '2015-04-01': { flow: 'light', source: 'clue' } },
    spans: [], gaps: [], birthControl: [],
  });

  it('returns a document the app can read back', () => {
    const merged = mergeIntoDocument(open(), incoming());
    expect(merged.version).toBe(1);
    expect(merged.doc).toBeUndefined();
    expect(merged.conflicts).toBeUndefined();
  });

  it('keeps days logged by hand as well as the imported ones', () => {
    const merged = mergeIntoDocument(open(), incoming());
    expect(merged.days['2015-03-20']).toBeTruthy();
    expect(merged.days['2015-04-01']).toBeTruthy();
  });

  it('preserves sections the merge does not own, so sharing survives', () => {
    const merged = mergeIntoDocument(open(), incoming());
    expect(merged.sharing).toEqual(open().sharing);
  });

  it('survives a round trip through the vault serialiser', () => {
    const merged = mergeIntoDocument(open(), incoming());
    expect(() => parseDocument(serializeDocument(merged))).not.toThrow();
  });
});

// A re-import can revert an episode end date set by hand: birthControl is
// keyed on startedOn and a tie goes to the incoming side. The precedence is
// deliberate; silently discarding the record of it was not.
describe('mergeConflicts', () => {
  const openWithEndedEpisode = () => ({
    version: 1,
    days: {}, spans: [], gaps: [],
    birthControl: [{ method: 'implant', startedOn: '2015-05-01', endedOn: '2015-09-02', expectedEffect: 'suppress' }],
  });
  const stillOpenIncoming = () => ({
    version: 1,
    days: {}, spans: [], gaps: [],
    birthControl: [{ method: 'implant', startedOn: '2015-05-01', endedOn: null, expectedEffect: 'suppress' }],
  });

  it('reports the hand-set end date a re-import overrode', () => {
    const conflicts = mergeConflicts(openWithEndedEpisode(), stillOpenIncoming());
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some(entry => entry.field === 'birthControl')).toBe(true);
    const merged = mergeIntoDocument(openWithEndedEpisode(), stillOpenIncoming());
    expect(merged.birthControl[0].endedOn).toBeNull();
  });

  it('reports nothing when a re-import changes nothing', () => {
    expect(mergeConflicts(openWithEndedEpisode(), openWithEndedEpisode())).toEqual([]);
  });
});

// Finding B. The Settings re-import does not merge birth control at all: it
// puts her own section back over the merge result. These tests execute both
// halves — what mergeIntoDocument alone produces, which is why the rule
// exists, and what the rule produces instead.
describe('the Settings re-import rule for birth control', () => {
  const hers = () => ({
    version: 1,
    days: {}, spans: [], gaps: [],
    birthControl: [
      { method: 'implant', startedOn: '2015-01-05', endedOn: '2015-06-01', expectedEffect: 'suppress' },
      { method: 'pill', startedOn: '2015-06-02', endedOn: null, expectedEffect: 'regulate' },
    ],
  });
  // What an export carries: every episode still open, because the importer
  // has no end date to give it.
  const incoming = () => ({
    version: 1,
    days: { '2015-02-01': { ...blankDay('clue') } }, spans: [], gaps: [],
    birthControl: [{ method: 'implant', startedOn: '2015-01-05', endedOn: null, expectedEffect: 'suppress' }],
  });

  const openCount = episodes => episodes.filter(episode => episode.endedOn === null).length;

  it('mergeIntoDocument alone WOULD leave two open episodes', () => {
    const merged = mergeIntoDocument(hers(), incoming());
    expect(merged.birthControl).toHaveLength(2);
    expect(openCount(merged.birthControl)).toBe(2);
    // And the older of the two is the one the model resolves to, which is how
    // every prediction ended up following the method she had ended.
    expect(merged.birthControl[0].method).toBe('implant');
    expect(merged.birthControl[0].endedOn).toBeNull();
  });

  it('the model rejects the shape mergeIntoDocument alone produces', () => {
    const merged = mergeIntoDocument(hers(), incoming());
    const problems = merged.birthControl.map((episode, index) => validateEpisode(
      episode, { existing: merged.birthControl, ignoreIndex: index },
    ));
    expect(problems.some(problem => problem !== null)).toBe(true);
  });

  it('restoring her own section leaves exactly one open episode', () => {
    const openDoc = hers();
    const merged = mergeIntoDocument(openDoc, incoming());
    const kept = { ...merged, birthControl: openDoc.birthControl ?? [] };
    expect(openCount(kept.birthControl)).toBe(1);
    expect(kept.birthControl.find(episode => episode.endedOn === null).method).toBe('pill');
    // Her hand-set end date survives.
    expect(kept.birthControl[0].endedOn).toBe('2015-06-01');
    // And the rest of the import still landed.
    expect(Object.keys(kept.days)).toEqual(['2015-02-01']);
  });

  it('leaves the kept document in a shape the model accepts', () => {
    const openDoc = hers();
    const merged = mergeIntoDocument(openDoc, incoming());
    const kept = { ...merged, birthControl: openDoc.birthControl ?? [] };
    for (const [index, episode] of kept.birthControl.entries()) {
      expect(validateEpisode(episode, { existing: kept.birthControl, ignoreIndex: index })).toBeNull();
    }
  });
});

// Finding D. The sentence used to say "N entries differed and the imported
// version was kept — check your birth control dates". Her own entries win,
// no birth-control date is involved, and the count was of fields.
describe('describeConflicts', () => {
  const manualDay = fields => ({ ...blankDay('manual'), ...fields });
  const clueDay = fields => ({ ...blankDay('clue'), ...fields });

  const twoFieldsOneDay = () => mergeConflicts(
    { version: 1, days: { '2015-03-04': manualDay({ flow: 'light', cramps: 'mild' }) }, spans: [], gaps: [], birthControl: [] },
    { version: 1, days: { '2015-03-04': clueDay({ flow: 'heavy', cramps: 'severe' }) }, spans: [], gaps: [], birthControl: [] },
  );

  it('counts days, not fields', () => {
    const conflicts = twoFieldsOneDay();
    expect(conflicts.length).toBe(2);
    expect(describeConflicts(conflicts)).toContain('1 day');
    expect(describeConflicts(conflicts)).not.toContain('2 entries');
    expect(describeConflicts(conflicts)).not.toContain('2 days');
  });

  it('says her own entries were kept, which is what the merge did', () => {
    const conflicts = twoFieldsOneDay();
    // The merge really did keep hers: `manual` outranks `clue`.
    for (const conflict of conflicts) {
      expect(['light', 'mild']).toContain(conflict.kept);
    }
    const sentence = describeConflicts(conflicts);
    expect(sentence).toContain('your own entries were kept');
    expect(sentence).not.toMatch(/imported version/);
    expect(sentence).not.toMatch(/birth control/);
  });

  it('pluralises over distinct dates', () => {
    const conflicts = mergeConflicts(
      {
        version: 1,
        days: { '2015-03-04': manualDay({ flow: 'light' }), '2015-03-05': manualDay({ flow: 'light' }) },
        spans: [], gaps: [], birthControl: [],
      },
      {
        version: 1,
        days: { '2015-03-04': clueDay({ flow: 'heavy' }), '2015-03-05': clueDay({ flow: 'heavy' }) },
        spans: [], gaps: [], birthControl: [],
      },
    );
    expect(describeConflicts(conflicts)).toContain('2 days');
  });

  it('says nothing at all when nothing differed', () => {
    expect(describeConflicts([])).toBe('');
  });

  it('ignores a birthControl conflict, because that section is not merged here', () => {
    const conflicts = mergeConflicts(
      { version: 1, days: {}, spans: [], gaps: [], birthControl: [{ method: 'implant', startedOn: '2015-05-01', endedOn: '2015-09-02', expectedEffect: 'suppress' }] },
      { version: 1, days: {}, spans: [], gaps: [], birthControl: [{ method: 'implant', startedOn: '2015-05-01', endedOn: null, expectedEffect: 'suppress' }] },
    );
    expect(conflicts.some(conflict => conflict.field === 'birthControl')).toBe(true);
    expect(describeConflicts(conflicts)).toBe('');
  });
});

describe('a tie between two equally-trusted days', () => {
  // Her own plaintext export carries `manual` days, so re-importing one puts a
  // manual day against a manual day. The tie used to go to the FILE, which
  // means every correction she made since that export silently reverted — and
  // the notice told her her own entries had been kept. The device holds the
  // later truth by definition: the file came from it.
  const onDevice = () => ({
    version: 1, gaps: [], spans: [], birthControl: [],
    days: { '2015-03-04': { flow: 'light', cramps: 'mild', source: 'manual' } },
  });
  const herOlderExport = () => ({
    version: 1, gaps: [], spans: [], birthControl: [],
    days: { '2015-03-04': { flow: 'heavy', cramps: 'severe', source: 'manual' } },
  });

  it('keeps what is already on the phone', () => {
    const merged = mergeIntoDocument(onDevice(), herOlderExport());
    expect(merged.days['2015-03-04'].flow).toBe('light');
    expect(merged.days['2015-03-04'].cramps).toBe('mild');
  });

  it('records the conflict with her value as the one kept', () => {
    const { conflicts } = mergeSources(onDevice(), herOlderExport());
    const flow = conflicts.find(conflict => conflict.field === 'flow');
    expect(flow.kept).toBe('light');
    expect(flow.discarded).toBe('heavy');
  });

  it('still lets a more trusted source win, so this is a tie rule only', () => {
    const imported = {
      version: 1, gaps: [], spans: [], birthControl: [],
      days: { '2015-03-04': { flow: 'heavy', source: 'clue' } },
    };
    // manual outranks clue, so hers wins whichever side it is on
    expect(mergeIntoDocument(onDevice(), imported).days['2015-03-04'].flow).toBe('light');
    expect(mergeIntoDocument(imported, onDevice()).days['2015-03-04'].flow).toBe('light');
  });
});

describe('describeMerge', () => {
  const doc = (days, spans = []) => ({ version: 1, gaps: [], birthControl: [], days, spans });

  // describeImport describes the FILE. Re-importing her own export reported
  // "Imported 12 periods and 9 logged days" with nothing actually added,
  // which is the ordinary case now that Settings routes her own export into
  // the merge.
  it('says plainly when the file added nothing', () => {
    const before = doc({ '2015-03-04': { flow: 'light', source: 'manual' } });
    expect(describeMerge(before, before)).toMatch(/nothing new|already/i);
  });

  it('counts only what the merge actually added', () => {
    const before = doc({ '2015-03-04': { flow: 'light', source: 'manual' } });
    const after = doc({
      '2015-03-04': { flow: 'light', source: 'manual' },
      '2015-04-01': { flow: 'heavy', source: 'clue' },
      '2015-04-02': { flow: 'medium', source: 'clue' },
    }, [{ start: '2015-04-01', end: '2015-04-02' }]);
    const text = describeMerge(before, after);
    expect(text).toMatch(/2 logged days/);
    expect(text).toMatch(/1 period/);
  });

  it('uses singular where it should', () => {
    const before = doc({});
    const after = doc({ '2015-04-01': { flow: 'heavy', source: 'clue' } }, [{ start: '2015-04-01', end: '2015-04-01' }]);
    const text = describeMerge(before, after);
    expect(text).toMatch(/1 logged day\b/);
    expect(text).toMatch(/1 period\b/);
  });

  it('never reports a negative count', () => {
    const before = doc({ a: 1, b: 2 });
    const after = doc({ a: 1 });
    expect(describeMerge(before, after)).not.toMatch(/-/);
  });
});
