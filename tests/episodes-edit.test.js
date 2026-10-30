import { describe, it, expect } from 'vitest';
import {
  EFFECTS, validateEpisode, addEpisode, updateEpisode, endEpisode, removeEpisode,
} from '../src/episodes-edit.js';

const doc = () => ({
  version: 1,
  days: {},
  spans: [],
  gaps: [],
  birthControl: [
    { startedOn: '2015-01-01', endedOn: '2015-06-30', method: 'implant', expectedEffect: 'suppress' },
    { startedOn: '2015-07-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
  ],
});

describe('EFFECTS', () => {
  it('offers exactly the three the prediction prior knows', () => {
    expect(EFFECTS).toEqual(['suppress', 'regulate', 'none']);
  });
});

describe('validateEpisode', () => {
  const existing = () => doc().birthControl;

  it('accepts a well-formed episode that fits after the others', () => {
    expect(validateEpisode(
      { startedOn: '2015-08-01', endedOn: null, method: 'copper IUD', expectedEffect: 'none' },
      { existing: [existing()[0]] },
    )).toBeNull();
  });

  it('requires a start date', () => {
    expect(validateEpisode(
      { startedOn: '', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      { existing: [] },
    )).toMatch(/start/i);
  });

  it('rejects a start date that is not a real calendar date', () => {
    expect(validateEpisode(
      { startedOn: '2015-02-30', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      { existing: [] },
    )).toMatch(/date/i);
  });

  it('requires a method name, without caring which', () => {
    expect(validateEpisode(
      { startedOn: '2015-08-01', endedOn: null, method: '   ', expectedEffect: 'none' },
      { existing: [] },
    )).toMatch(/method/i);
  });

  it('rejects an effect the prediction prior does not know', () => {
    expect(validateEpisode(
      { startedOn: '2015-08-01', endedOn: null, method: 'pill', expectedEffect: 'magic' },
      { existing: [] },
    )).toMatch(/effect/i);
  });

  it('rejects an end before its own start', () => {
    expect(validateEpisode(
      { startedOn: '2015-08-01', endedOn: '2015-07-01', method: 'pill', expectedEffect: 'regulate' },
      { existing: [] },
    )).toMatch(/end/i);
  });

  // Review Focus 3: currentEpisode resolves a date to ONE episode. Two that
  // overlap make that answer arbitrary, and every prediction downstream of it
  // silently wrong.
  it('rejects an episode overlapping one that already exists', () => {
    expect(validateEpisode(
      { startedOn: '2015-03-01', endedOn: '2015-04-01', method: 'pill', expectedEffect: 'regulate' },
      { existing: existing() },
    )).toMatch(/overlap/i);
  });

  it('rejects a new open-ended episode when one is already open', () => {
    expect(validateEpisode(
      { startedOn: '2015-09-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      { existing: existing() },
    )).toMatch(/overlap|still current/i);
  });

  // The different-method branch: a second open episode must be refused
  // whatever it is called. currentEpisode() returns the first match in a
  // list sorted by start date, so two open episodes do not mean "both
  // apply" — they mean the newer one is silently ignored.
  it('rejects a second open episode even when the method differs', () => {
    expect(validateEpisode(
      { startedOn: '2015-09-01', endedOn: null, method: 'copper IUD', expectedEffect: 'none' },
      { existing: existing() },
    )).toMatch(/overlap|still current/i);
  });

  it('lets an episode being edited overlap only itself', () => {
    expect(validateEpisode(
      { startedOn: '2015-01-02', endedOn: '2015-06-30', method: 'implant', expectedEffect: 'suppress' },
      { existing: existing(), ignoreIndex: 0 },
    )).toBeNull();
  });

  it('allows a new episode starting the day after one ends', () => {
    expect(validateEpisode(
      { startedOn: '2015-07-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      { existing: [existing()[0]] },
    )).toBeNull();
  });
});

describe('addEpisode', () => {
  it('adds the episode and keeps the list in date order', () => {
    const before = { version: 1, days: {}, spans: [], gaps: [], birthControl: [] };
    let after = addEpisode(before, {
      startedOn: '2015-07-01', endedOn: null, method: 'pill', expectedEffect: 'regulate',
    });
    after = addEpisode(after, {
      startedOn: '2015-01-01', endedOn: '2015-06-30', method: 'implant', expectedEffect: 'suppress',
    });
    expect(after.birthControl.map(e => e.startedOn)).toEqual(['2015-01-01', '2015-07-01']);
  });

  it('trims the method name rather than storing the spaces', () => {
    const after = addEpisode(
      { version: 1, days: {}, spans: [], gaps: [], birthControl: [] },
      { startedOn: '2015-07-01', endedOn: null, method: '  pill  ', expectedEffect: 'regulate' },
    );
    expect(after.birthControl[0].method).toBe('pill');
  });

  it('refuses an invalid episode rather than storing it', () => {
    expect(() => addEpisode(
      { version: 1, days: {}, spans: [], gaps: [], birthControl: [] },
      { startedOn: '', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
    )).toThrow();
  });

  // Its own document rather than doc(): doc() has an open episode, so any
  // later episode correctly throws now, and a throwing call would prove
  // nothing about mutation.
  it('does not mutate the document it was given', () => {
    const before = {
      version: 1,
      days: {},
      spans: [],
      gaps: [],
      birthControl: [
        { startedOn: '2015-01-01', endedOn: '2015-06-30', method: 'implant', expectedEffect: 'suppress' },
      ],
    };
    const snapshot = JSON.stringify(before);
    addEpisode(before, {
      startedOn: '2015-07-01', endedOn: null, method: 'pill', expectedEffect: 'regulate',
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves her days, spans and gaps untouched', () => {
    const before = {
      version: 1,
      days: { '2015-03-20': { flow: 'heavy', source: 'manual' } },
      spans: [{ start: '2015-03-20', end: '2015-03-24' }],
      gaps: [{ from: '2015-01-01', to: '2015-02-01', reason: 'no data' }],
      birthControl: [],
    };
    const after = addEpisode(before, {
      startedOn: '2015-08-01', endedOn: null, method: 'x', expectedEffect: 'none',
    });
    expect(after.days).toEqual(before.days);
    expect(after.spans).toEqual(before.spans);
    expect(after.gaps).toEqual(before.gaps);
  });
});

describe('endEpisode', () => {
  it('closes an open episode on the given date', () => {
    const after = endEpisode(doc(), 1, '2015-09-30');
    expect(after.birthControl[1].endedOn).toBe('2015-09-30');
  });

  it('refuses an end date before the episode started', () => {
    expect(() => endEpisode(doc(), 1, '2015-06-01')).toThrow();
  });

  it('does not mutate the document it was given', () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    endEpisode(before, 1, '2015-09-30');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('updateEpisode', () => {
  it('replaces the episode at that position', () => {
    const after = updateEpisode(doc(), 1, {
      startedOn: '2015-07-01', endedOn: null, method: 'mini pill', expectedEffect: 'regulate',
    });
    expect(after.birthControl[1].method).toBe('mini pill');
  });

  it('refuses an edit that would overlap a different episode', () => {
    expect(() => updateEpisode(doc(), 1, {
      startedOn: '2015-03-01', endedOn: null, method: 'pill', expectedEffect: 'regulate',
    })).toThrow();
  });
});

describe('removeEpisode', () => {
  it('drops that episode and keeps the rest', () => {
    const after = removeEpisode(doc(), 0);
    expect(after.birthControl.map(e => e.method)).toEqual(['pill']);
  });

  it('does not mutate the document it was given', () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    removeEpisode(before, 0);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
