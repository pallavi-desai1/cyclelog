import { describe, it, expect } from 'vitest';
import {
  FLOW_OPTIONS, CRAMP_OPTIONS, MOOD_OPTIONS, PAIN_OPTIONS,
  SPOTTING_OPTIONS, DISCHARGE_OPTIONS, TEST_OPTIONS,
  renderEditor, patchFromValues, saveOutcome,
} from '../src/ui/editor.js';
import { dayDetail } from '../src/day.js';

const doc = {
  version: 1, gaps: [], birthControl: [],
  spans: [{ start: '2015-03-01', end: '2015-03-03', source: 'clue' }],
  days: {
    '2015-03-01': {
      flow: 'heavy', cramps: 'unknown', spotting: null, pms: true,
      mood: ['sad', 'anxious'], discharge: 'creamy',
      tests: { ovulation: 'negative', pregnancy: null }, pain: ['headache'],
      notes: 'rough day', source: 'clue', precision: 'approx',
    },
  },
};
const detail = date => dayDetail(doc, date, { todayISO: '2015-03-10' });

describe('the option lists', () => {
  it('offers the three intensities the rest of the app draws', () => {
    expect(FLOW_OPTIONS.map(option => option.value)).toEqual(['light', 'medium', 'heavy']);
  });

  it('keeps unknown cramps selectable, because her imported data holds them', () => {
    expect(CRAMP_OPTIONS.map(option => option.value)).toContain('unknown');
  });

  it('offers a real cramp scale as well', () => {
    const values = CRAMP_OPTIONS.map(option => option.value);
    for (const value of ['none', 'mild', 'moderate', 'strong']) expect(values).toContain(value);
  });

  it('covers every mood her imported data uses', () => {
    const values = MOOD_OPTIONS.map(option => option.value);
    for (const mood of [
      'angry', 'anxious', 'confident', 'happy', 'mood_swings',
      'sad', 'sensitive', 'stressed', 'withdrawn',
    ]) expect(values, mood).toContain(mood);
  });

  it('covers every pain her imported data uses', () => {
    const values = PAIN_OPTIONS.map(option => option.value);
    for (const pain of ['breast_tenderness', 'headache', 'ovulation']) {
      expect(values, pain).toContain(pain);
    }
  });

  it('covers exactly the spec\'s seven discharge values', () => {
    const values = DISCHARGE_OPTIONS.map(opt => opt.value).sort();
    expect(values).toEqual(
      ['creamy', 'egg_white', 'none', 'spotty', 'sticky', 'unusual', 'watery'].sort(),
    );
  });

  it('covers the three spotting values', () => {
    const values = SPOTTING_OPTIONS.map(opt => opt.value).sort();
    expect(values).toEqual(['brown', 'none', 'red'].sort());
  });

  it('covers the two test result values', () => {
    const values = TEST_OPTIONS.map(opt => opt.value).sort();
    expect(values).toEqual(['negative', 'positive'].sort());
  });

  it('gives every option a label a person would read', () => {
    for (const option of [...MOOD_OPTIONS, ...PAIN_OPTIONS, ...CRAMP_OPTIONS]) {
      expect(option.label, option.value).toMatch(/^[A-Z]/);
      expect(option.label).not.toContain('_');
    }
  });
});

describe('renderEditor', () => {
  const html = (date = '2015-03-01') => renderEditor(detail(date));

  it('heads the form with the date it is editing', () => {
    expect(html()).toContain('1 March 2015');
  });

  it('carries the date on the form, so the glue never has to guess', () => {
    expect(html()).toContain('data-editing="2015-03-01"');
  });

  it('preselects the flow already recorded', () => {
    expect(html()).toMatch(/value="heavy"[^>]*checked/);
  });

  it('preselects the cramps already recorded', () => {
    expect(html()).toMatch(/<option value="unknown" selected/);
  });

  it('ticks the moods already recorded, and not the others', () => {
    expect(html()).toMatch(/value="sad"[^>]*checked/);
    expect(html()).toMatch(/value="anxious"[^>]*checked/);
    expect(html()).not.toMatch(/value="happy"[^>]*checked/);
  });

  it('ticks PMS when it was recorded', () => {
    expect(html()).toMatch(/id="edit-pms"[^>]*checked/);
  });

  it('fills the note in', () => {
    expect(html()).toContain('rough day');
  });

  it('ticks the approximate box when the date is approximate', () => {
    expect(html()).toMatch(/id="edit-approx"[^>]*checked/);
  });

  it('opens empty on a day with nothing recorded', () => {
    const empty = html('2015-03-05');
    expect(empty).not.toMatch(/checked/);
    expect(empty).toMatch(/<option value="" selected/);
  });

  it('offers a save and a cancel', () => {
    expect(html()).toContain('id="edit-save"');
    expect(html()).toContain('id="edit-cancel"');
  });

  it('escapes a note rather than letting it become markup', () => {
    const nasty = {
      ...doc,
      days: { '2015-03-01': { ...doc.days['2015-03-01'], notes: '<img src=x>' } },
    };
    const output = renderEditor(dayDetail(nasty, '2015-03-01', { todayISO: '2015-03-10' }));
    expect(output).not.toContain('<img');
  });

  it('prints no null, undefined or NaN on an empty day', () => {
    expect(html('2015-03-05')).not.toMatch(/null|undefined|NaN/);
  });

  it('produces balanced markup', () => {
    const output = html();
    const selfClosing = (output.match(/<input[^>]*>/g) ?? []).length;
    const opens = (output.match(/<(?!\/)[a-z]/g) ?? []).length - selfClosing;
    expect(opens).toBe((output.match(/<\//g) ?? []).length);
  });
});

describe('patchFromValues', () => {
  const values = (overrides = {}) => ({
    flow: '', cramps: '', spotting: '', discharge: '', pms: false,
    mood: [], pain: [], ovulation: '', pregnancy: '', notes: '', approximate: false,
    ...overrides,
  });

  it('separates the flow, which also moves the period, from the rest', () => {
    const result = patchFromValues(values({ flow: 'medium' }));
    expect(result.flow).toBe('medium');
    expect(result.patch).not.toHaveProperty('flow');
  });

  it('reports no flow as null rather than an empty string', () => {
    expect(patchFromValues(values()).flow).toBeNull();
  });

  // Review Focus 3: an empty select means "not recorded"; 'none' is a value.
  it('turns an empty select into null and keeps a recorded none', () => {
    expect(patchFromValues(values({ cramps: '' })).patch.cramps).toBeNull();
    expect(patchFromValues(values({ cramps: 'none' })).patch.cramps).toBe('none');
  });

  it('passes the lists through', () => {
    const result = patchFromValues(values({ mood: ['sad'], pain: ['headache'] }));
    expect(result.patch.mood).toEqual(['sad']);
    expect(result.patch.pain).toEqual(['headache']);
  });

  it('carries both test results', () => {
    const result = patchFromValues(values({ ovulation: 'positive', pregnancy: 'negative' }));
    expect(result.patch.tests).toEqual({ ovulation: 'positive', pregnancy: 'negative' });
  });

  it('nulls a test that was not recorded', () => {
    expect(patchFromValues(values()).patch.tests)
      .toEqual({ ovulation: null, pregnancy: null });
  });

  it('carries PMS and the note', () => {
    const result = patchFromValues(values({ pms: true, notes: 'tired' }));
    expect(result.patch.pms).toBe(true);
    expect(result.patch.notes).toBe('tired');
  });

  it('reports the approximate flag separately, since it is not a day field', () => {
    expect(patchFromValues(values({ approximate: true })).approximate).toBe(true);
    expect(patchFromValues(values()).patch).not.toHaveProperty('approximate');
  });

  it('always patches every field, so clearing one actually clears it', () => {
    const { patch } = patchFromValues(values());
    for (const field of ['cramps', 'spotting', 'discharge', 'pms', 'mood', 'pain', 'tests', 'notes']) {
      expect(patch, field).toHaveProperty(field);
    }
  });
});

// vault.save awaits two IndexedDB round trips (seal(), then backend.set()),
// so the session can move on — a lock, or a fresh editor session — before a
// pending save resolves. The write always lands in the vault; this function
// only decides what the *view* may do once it has. The session check
// compares a TOKEN (editSession in app.js), not the date being edited: two
// sessions opened back-to-back on the same day (open X, Save pending,
// Cancel, reopen X) share a date but are not the same editor.
describe('saveOutcome', () => {
  it('renders when the epoch and the session token have not moved', () => {
    expect(saveOutcome({
      epochAtStart: 1, epochNow: 1, sessionAtStart: 1, sessionNow: 1,
    })).toBe('adopt-and-render');
  });

  it('abandons once the epoch has moved — the vault locked mid-save', () => {
    expect(saveOutcome({
      epochAtStart: 1, epochNow: 2, sessionAtStart: 1, sessionNow: 1,
    })).toBe('abandon');
  });

  // A locked session wins even when the editor session token still happens
  // to match: the lock is what makes the decrypted document unsafe to hold,
  // regardless of which editor was open when it fired.
  it('abandons on a moved epoch even when the session token still matches', () => {
    expect(saveOutcome({
      epochAtStart: 1, epochNow: 2, sessionAtStart: 1, sessionNow: 1,
    })).toBe('abandon');
  });

  it('adopts into memory only, without rendering, once the session token has moved', () => {
    // Covers both a different day opened and the same day reopened after
    // Cancel — openEditor bumps the token on every open, so either case
    // looks identical to this function: a fresh session, not this one.
    expect(saveOutcome({
      epochAtStart: 1, epochNow: 1, sessionAtStart: 1, sessionNow: 2,
    })).toBe('adopt-only');
  });

  // Cancel alone (no reopen) does NOT bump the token — the panel is simply
  // showing the day read-only now. Repainting it with what was just saved
  // is the correct, honest result, so this must still render.
  it('still renders after a Cancel with no reopen, because the token never moved', () => {
    expect(saveOutcome({
      epochAtStart: 1, epochNow: 1, sessionAtStart: 3, sessionNow: 3,
    })).toBe('adopt-and-render');
  });
});
