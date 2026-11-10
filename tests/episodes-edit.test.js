import { describe, it, expect } from 'vitest';
import {
  EFFECTS, validateEpisode, addEpisode, updateEpisode, endEpisode, removeEpisode,
  switchMethod,
} from '../src/episodes-edit.js';
import { episodeAt } from '../src/cycles.js';

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

  // Reversed deliberately, at her request: "if there is overlap between two
  // methods, it's fine." It was refused because episodeAt returned the first
  // match, so an overlapping day silently followed the OLDER method. That
  // resolution rule now picks the most recently started episode, which is
  // what makes overlap safe to allow rather than merely permitted.
  it('allows an episode overlapping one that already exists', () => {
    expect(validateEpisode(
      { startedOn: '2015-03-01', endedOn: '2015-04-01', method: 'pill', expectedEffect: 'regulate' },
      { existing: existing() },
    )).toBeNull();
  });

  it('allows a new open-ended episode even when one is already open', () => {
    expect(validateEpisode(
      { startedOn: '2015-09-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      { existing: existing() },
    )).toBeNull();
  });

  // The different-method branch: a second open episode must be refused
  // whatever it is called. currentEpisode() returns the first match in a
  // list sorted by start date, so two open episodes do not mean "both
  // apply" — they mean the newer one is silently ignored.
  it('allows a second open episode whatever it is called', () => {
    expect(validateEpisode(
      { startedOn: '2015-09-01', endedOn: null, method: 'copper IUD', expectedEffect: 'none' },
      { existing: existing() },
    )).toBeNull();
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

  it('stores an overlapping episode now that overlap is allowed', () => {
    const before = {
      version: 1, days: {}, spans: [], gaps: [],
      birthControl: [{ startedOn: '2015-01-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }],
    };
    const after = addEpisode(before, {
      startedOn: '2015-06-01', endedOn: null, method: 'copper IUD', expectedEffect: 'none',
    });
    expect(after.birthControl).toHaveLength(2);
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

  it('allows an edit that overlaps a different episode', () => {
    expect(() => updateEpisode(doc(), 1, {
      startedOn: '2015-03-01', endedOn: null, method: 'pill', expectedEffect: 'regulate',
    })).not.toThrow();
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

describe('switchMethod', () => {
  const onPill = () => ({
    version: 1, days: {}, spans: [], gaps: [],
    birthControl: [
      { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
    ],
  });

  // The whole point of this function. Ending the old one and starting the new
  // one on the same date is what a person means by "I changed on the 5th",
  // and it is exactly what the overlap rule refuses — so doing it by hand
  // means working out an off-by-one yourself. One date in, both halves
  // consistent out.
  // Her instruction: "make it such that the method goes until the day I said
  // it got taken out, not that it stops a day earlier." So the old method's
  // endedOn IS the change date, the two overlap on that one day, and
  // episodeAt gives the day to the one that just started.
  it('runs the old method until the day she gave, and starts the new one that day', () => {
    const after = switchMethod(onPill(), {
      changedOn: '2015-11-05', method: 'copper IUD', expectedEffect: 'none',
    });
    expect(after.birthControl).toEqual([
      { startedOn: '2015-02-01', endedOn: '2015-11-05', method: 'pill', expectedEffect: 'regulate' },
      { startedOn: '2015-11-05', endedOn: null, method: 'copper IUD', expectedEffect: 'none' },
    ]);
  });

  it('gives the shared day to the method that just started', () => {
    const after = switchMethod(onPill(), {
      changedOn: '2015-11-05', method: 'copper IUD', expectedEffect: 'none',
    });
    expect(episodeAt(after, '2015-11-05').method).toBe('copper IUD');
    expect(episodeAt(after, '2015-11-04').method).toBe('pill');
  });

  it('produces a document the overlap rule accepts', () => {
    const after = switchMethod(onPill(), {
      changedOn: '2015-11-05', method: 'copper IUD', expectedEffect: 'none',
    });
    for (const [index, episode] of after.birthControl.entries()) {
      expect(validateEpisode(episode, { existing: after.birthControl, ignoreIndex: index }), episode.method).toBeNull();
    }
  });

  it('works when she was on nothing, as a plain start', () => {
    const after = switchMethod(
      { version: 1, days: {}, spans: [], gaps: [], birthControl: [] },
      { changedOn: '2015-11-05', method: 'pill', expectedEffect: 'regulate' },
    );
    expect(after.birthControl).toEqual([
      { startedOn: '2015-11-05', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
    ]);
  });

  it('refuses a change date before the method it would close ever started', () => {
    expect(() => switchMethod(onPill(), {
      changedOn: '2015-01-01', method: 'x', expectedEffect: 'none',
    })).toThrow(/cannot have ended before/i);
  });

  // Allowed now that the end date is inclusive: she started it and stopped it
  // on the same day, which is a real one-day episode rather than an error.
  it('allows a change on the very day the old method started', () => {
    const after = switchMethod(onPill(), {
      changedOn: '2015-02-01', method: 'x', expectedEffect: 'none',
    });
    expect(after.birthControl[0]).toEqual({
      startedOn: '2015-02-01', endedOn: '2015-02-01', method: 'pill', expectedEffect: 'regulate',
    });
    expect(episodeAt(after, '2015-02-01').method).toBe('x');
  });

  it('refuses a change date that is not a real date, and names the problem', () => {
    expect(() => switchMethod(onPill(), {
      changedOn: '2015-02-30', method: 'x', expectedEffect: 'none',
    })).toThrow(/date/i);
    expect(() => switchMethod(onPill(), {
      changedOn: '', method: 'x', expectedEffect: 'none',
    })).toThrow(/date/i);
  });

  it('refuses an unnamed method rather than recording a blank one', () => {
    expect(() => switchMethod(onPill(), {
      changedOn: '2015-11-05', method: '   ', expectedEffect: 'none',
    })).toThrow(/method/i);
  });

  it('leaves a closed history alone and only touches the open episode', () => {
    const before = {
      version: 1, days: {}, spans: [], gaps: [],
      birthControl: [
        { startedOn: '2015-01-01', endedOn: '2015-01-31', method: 'implant', expectedEffect: 'suppress' },
        { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      ],
    };
    const after = switchMethod(before, {
      changedOn: '2015-11-05', method: 'copper IUD', expectedEffect: 'none',
    });
    expect(after.birthControl[0]).toEqual(before.birthControl[0]);
    expect(after.birthControl).toHaveLength(3);
  });

  it('does not mutate the document it was given', () => {
    const before = onPill();
    const snapshot = JSON.stringify(before);
    switchMethod(before, { changedOn: '2015-11-05', method: 'x', expectedEffect: 'none' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves her days and spans untouched', () => {
    const before = {
      version: 1, gaps: [],
      days: { '2015-03-20': { flow: 'heavy', source: 'manual' } },
      spans: [{ start: '2015-03-20', end: '2015-03-24' }],
      birthControl: [],
    };
    const after = switchMethod(before, { changedOn: '2015-11-05', method: 'x', expectedEffect: 'none' });
    expect(after.days).toEqual(before.days);
    expect(after.spans).toEqual(before.spans);
  });
});
