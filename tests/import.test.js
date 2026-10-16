import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_VERSION, emptyDocument, documentFromSources,
  serializeDocument, parseDocument, describeImport,
} from '../src/import.js';

const clue = [
  { type: 'period', date: '2016-01-02', value: { option: 'medium' }, id: 'a' },
  { type: 'period', date: '2016-01-03', value: { option: 'light' }, id: 'b' },
  { type: 'sleep_duration', date: '2016-01-03', value: 7, id: 'c' },
];

const legacy = 'January 1st, 2015 - started\nJanuary 5th - stopped\n';

describe('emptyDocument', () => {
  it('has every section the rest of the app reads', () => {
    expect(emptyDocument()).toEqual({
      version: DOCUMENT_VERSION, days: {}, spans: [], gaps: [], birthControl: [],
    });
  });
});

describe('documentFromSources', () => {
  it('imports the Clue export alone', () => {
    const { doc } = documentFromSources({ clueJson: clue });
    expect(doc.days['2016-01-02'].flow).toBe('medium');
    expect(doc.spans.length).toBeGreaterThan(0);
  });

  it('imports the legacy log alone', () => {
    const { doc } = documentFromSources({ legacyText: legacy });
    expect(doc.spans[0].start).toBe('2015-01-01');
  });

  it('imports both into one document', () => {
    const { doc } = documentFromSources({ clueJson: clue, legacyText: legacy });
    expect(doc.spans.map(span => span.start)).toContain('2015-01-01');
    expect(doc.days['2016-01-02']).toBeDefined();
  });

  it('stamps the document version', () => {
    expect(documentFromSources({ legacyText: legacy }).doc.version).toBe(DOCUMENT_VERSION);
  });

  it('keeps spans in date order regardless of which file was picked first', () => {
    const a = documentFromSources({ clueJson: clue, legacyText: legacy }).doc.spans;
    const b = documentFromSources({ legacyText: legacy, clueJson: clue }).doc.spans;
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x.start.localeCompare(y.start))).toEqual(a);
  });

  it('surfaces parser warnings rather than swallowing them', () => {
    const noisy = [{ type: 'weather', date: '2016-01-02', value: null, id: 'w' }];
    expect(documentFromSources({ clueJson: noisy }).warnings.join(' ')).toMatch(/weather/);
  });

  it('reports conflicts', () => {
    expect(documentFromSources({ legacyText: legacy }).conflicts).toEqual(expect.any(Array));
  });

  it('refuses to build a document from nothing, rather than silently erasing', () => {
    expect(() => documentFromSources({})).toThrow(/no sources/);
  });
});

describe('describeImport', () => {
  const twoSpanDoc = {
    version: 1,
    spans: [
      { start: '2015-01-01', end: '2015-01-05' },
      { start: '2015-03-01', end: null },
    ],
    days: { '2015-01-01': {}, '2015-01-02': {}, '2015-01-03': {} },
    gaps: [],
    birthControl: [],
  };

  it('derives counts and the date range from the document rather than a fixed string', () => {
    const message = describeImport({ doc: twoSpanDoc, warnings: [] });
    expect(message).toBe('Imported 2 periods and 3 logged days, 2015-01-01 to 2015-03-01.');
  });

  it('pluralizes a single period and a single logged day', () => {
    const single = { ...twoSpanDoc, spans: [{ start: '2015-01-01', end: null }], days: { '2015-01-01': {} } };
    expect(describeImport({ doc: single, warnings: [] }))
      .toBe('Imported 1 period and 1 logged day, 2015-01-01 to 2015-01-01.');
  });

  it('names unreadable lines when warnings were produced, singular and plural', () => {
    expect(describeImport({ doc: twoSpanDoc, warnings: ['one bad line'] }))
      .toMatch(/1 line could not be read\.$/);
    expect(describeImport({ doc: twoSpanDoc, warnings: ['a', 'b', 'c'] }))
      .toMatch(/3 lines could not be read\.$/);
  });

  it('says nothing about a range when the document is empty', () => {
    expect(describeImport({ doc: emptyDocument(), warnings: [] }))
      .toBe('Imported 0 periods and 0 logged days.');
  });

  it('matches a real import end to end, counts included, warning included', () => {
    const noisy = [{ type: 'weather', date: '2016-01-02', value: null, id: 'w' }, ...clue];
    const imported = documentFromSources({ clueJson: noisy, legacyText: legacy });
    const message = describeImport(imported);
    expect(message).toContain(`Imported ${imported.doc.spans.length} `);
    expect(message).toContain(`${Object.keys(imported.doc.days).length} logged`);
    expect(message).toMatch(/1 line could not be read\.$/);
  });
});

describe('serialize and parse', () => {
  it('round-trips a document', () => {
    const { doc } = documentFromSources({ clueJson: clue, legacyText: legacy });
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });

  it('rejects a version it does not understand', () => {
    const future = serializeDocument({ ...emptyDocument(), version: 99 });
    expect(() => parseDocument(future)).toThrow(/version 99/);
  });

  it('rejects a document missing a section', () => {
    expect(() => parseDocument('{"version":1,"days":{},"spans":[],"gaps":[]}'))
      .toThrow(/birthControl/);
  });

  it('rejects text that is not a document at all', () => {
    expect(() => parseDocument('not json')).toThrow();
  });
});
