import { describe, it, expect } from 'vitest';
import { SCOPES, SCOPE_LABELS, projectDocument } from '../src/sync/scope.js';
import { parseDocument } from '../src/import.js';

const doc = () => ({
  version: 1,
  spans: [{ start: '2015-01-29', end: '2015-02-02', precision: 'approx', endPrecision: 'exact', source: 'clue' }],
  gaps: [{ from: '2015-03-01', to: '2015-03-20', reason: 'not logged' }],
  birthControl: [{ startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }],
  days: {
    '2015-01-29': {
      flow: 'heavy', cramps: 'severe', spotting: null, pms: true, mood: ['sad'],
      discharge: 'creamy', tests: { ovulation: 'negative', pregnancy: null },
      pain: ['headache'], medicine: ['ibuprofen'], notes: 'a private thought',
      source: 'clue', precision: 'exact',
    },
  },
  // The sync key lives here. It must never reach the ciphertext.
  sharing: {
    key: 'SECRETSYNCKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    scope: 'dates',
    viewers: [{ uid: 'viewer-uid', label: 'partner', grantedAt: '2015-02-01' }],
  },
});

describe('the scopes', () => {
  it('are the three the spec names, narrowest first', () => {
    expect(SCOPES).toEqual(['dates', 'symptoms', 'everything']);
  });

  it('each have a sentence she can read before choosing', () => {
    for (const scope of SCOPES) {
      expect(SCOPE_LABELS[scope], scope).toMatch(/\w+ \w+/);
    }
  });

  it('refuses a scope it does not know', () => {
    expect(() => projectDocument(doc(), 'everything-plus')).toThrow(/scope/i);
    expect(() => projectDocument(doc(), undefined)).toThrow(/scope/i);
  });
});

describe('every scope', () => {
  // Review Focus 1: the key is in the document and must not be in the copy.
  it('strips the sharing section, key and all', () => {
    for (const scope of SCOPES) {
      const projected = projectDocument(doc(), scope);
      expect(projected.sharing, scope).toBeUndefined();
      expect(JSON.stringify(projected), scope).not.toContain('SECRETSYNCKEY');
      expect(JSON.stringify(projected), scope).not.toContain('viewer-uid');
    }
  });

  it('keeps the period spans, which every scope includes', () => {
    for (const scope of SCOPES) {
      expect(projectDocument(doc(), scope).spans, scope).toEqual(doc().spans);
    }
  });

  it('keeps the gaps and the birth control, so his predictions match hers', () => {
    for (const scope of SCOPES) {
      const projected = projectDocument(doc(), scope);
      expect(projected.gaps, scope).toEqual(doc().gaps);
      expect(projected.birthControl, scope).toEqual(doc().birthControl);
    }
  });

  it('produces a document his app can parse', () => {
    for (const scope of SCOPES) {
      expect(() => parseDocument(JSON.stringify(projectDocument(doc(), scope))), scope).not.toThrow();
    }
  });

  it('leaves her own document untouched', () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    for (const scope of SCOPES) projectDocument(before, scope);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('the dates scope', () => {
  const projected = () => projectDocument(doc(), 'dates');

  it('carries no day entries at all', () => {
    expect(projected().days).toEqual({});
  });

  it('therefore carries no symptom and no note', () => {
    const text = JSON.stringify(projected());
    for (const leak of ['heavy', 'severe', 'creamy', 'headache', 'sad', 'a private thought']) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe('the symptoms scope', () => {
  const day = () => projectDocument(doc(), 'symptoms').days['2015-01-29'];

  it('carries the symptoms', () => {
    expect(day().flow).toBe('heavy');
    expect(day().cramps).toBe('severe');
    expect(day().pms).toBe(true);
    expect(day().mood).toEqual(['sad']);
    expect(day().discharge).toBe('creamy');
    expect(day().pain).toEqual(['headache']);
    expect(day().tests).toEqual({ ovulation: 'negative', pregnancy: null });
  });

  it('carries what she took for it', () => {
    expect(day().medicine).toEqual(['ibuprofen']);
  });

  it('carries no note — not even as an empty string, since the whitelist does not name it', () => {
    expect('notes' in day()).toBe(false);
    expect(JSON.stringify(projectDocument(doc(), 'symptoms'))).not.toContain('a private thought');
  });

  it('keeps the precision, so an approximate date still reads as one', () => {
    expect(day().precision).toBe('exact');
  });

  // The projected arrays must be her own, not the same objects as the source
  // day's — otherwise anything downstream that mutates the projection
  // mutates her real history.
  it('copies the mutable arrays rather than aliasing the source', () => {
    const source = doc();
    const projected = projectDocument(source, 'symptoms').days['2015-01-29'];
    projected.medicine.push('mutated');
    projected.mood.push('mutated');
    projected.pain.push('mutated');
    expect(source.days['2015-01-29'].medicine).toEqual(['ibuprofen']);
    expect(source.days['2015-01-29'].mood).toEqual(['sad']);
    expect(source.days['2015-01-29'].pain).toEqual(['headache']);
  });

  it('copies the tests object rather than aliasing the source', () => {
    const source = doc();
    const projected = projectDocument(source, 'symptoms').days['2015-01-29'];
    projected.tests.ovulation = 'mutated';
    expect(source.days['2015-01-29'].tests.ovulation).toBe('negative');
  });

  it('still sends a day whose only content is what she took for it', () => {
    const medOnly = doc();
    medOnly.days['2015-02-14'] = {
      flow: null, cramps: null, spotting: null, pms: false, mood: [], discharge: null,
      tests: { ovulation: null, pregnancy: null }, pain: [], medicine: ['ibuprofen'],
      notes: '', source: 'manual', precision: 'exact',
    };
    const projected = projectDocument(medOnly, 'symptoms').days['2015-02-14'];
    expect(projected).toBeDefined();
    expect(projected.medicine).toEqual(['ibuprofen']);
  });
});

describe('the everything scope', () => {
  it('carries the notes too', () => {
    expect(projectDocument(doc(), 'everything').days['2015-01-29'].notes)
      .toBe('a private thought');
  });

  it('is still not her whole document', () => {
    expect(projectDocument(doc(), 'everything').sharing).toBeUndefined();
  });
});

describe('the whitelist', () => {
  // Review Focus 2. A blacklist would leak anything added later; this test is
  // the one that fails if the projection ever becomes one.
  it('drops a day field nobody has thought of yet', () => {
    const future = doc();
    future.days['2015-01-29'].basalTemperature = 36.8;
    future.days['2015-01-29'].sexualActivity = 'yes';
    for (const scope of SCOPES) {
      const text = JSON.stringify(projectDocument(future, scope));
      expect(text, scope).not.toContain('basalTemperature');
      expect(text, scope).not.toContain('sexualActivity');
      expect(text, scope).not.toContain('36.8');
    }
  });

  it('drops a top-level section nobody has thought of yet', () => {
    const future = { ...doc(), secretDiary: { '2015-01-01': 'nobody should see this' } };
    for (const scope of SCOPES) {
      expect(JSON.stringify(projectDocument(future, scope)), scope)
        .not.toContain('nobody should see this');
    }
  });

  it('drops an unknown field from a span rather than passing it through', () => {
    const future = doc();
    future.spans[0].mood = 'leaked';
    expect(JSON.stringify(projectDocument(future, 'dates'))).not.toContain('leaked');
  });

  it('omits a day that has nothing left after projection', () => {
    const noteOnly = doc();
    noteOnly.days['2015-02-14'] = {
      flow: null, cramps: null, spotting: null, pms: false, mood: [], discharge: null,
      tests: { ovulation: null, pregnancy: null }, pain: [], notes: 'only a note',
      source: 'manual', precision: 'exact',
    };
    const symptoms = projectDocument(noteOnly, 'symptoms');
    expect(symptoms.days['2015-02-14']).toBeUndefined();
    expect(projectDocument(noteOnly, 'everything').days['2015-02-14']).toBeDefined();
  });
});
