import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_VERSION, emptyDocument, documentFromSources,
  serializeDocument, parseDocument,
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
