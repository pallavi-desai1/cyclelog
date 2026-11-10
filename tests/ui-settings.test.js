import { describe, it, expect } from 'vitest';
import {
  EFFECT_LABELS, renderEpisodes, renderEpisodeForm, renderBackupWarning,
  renderSwitchForm, renderEndForm,
} from '../src/ui/settings.js';
import { EFFECTS } from '../src/episodes-edit.js';

const episodes = [
  { startedOn: '2015-01-01', endedOn: '2015-06-30', method: 'implant', expectedEffect: 'suppress' },
  { startedOn: '2015-07-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
];

describe('EFFECT_LABELS', () => {
  it('has plain words for every effect the model accepts', () => {
    for (const effect of EFFECTS) {
      expect(EFFECT_LABELS[effect], effect).toBeTruthy();
    }
  });
});

describe('renderEpisodes', () => {
  it('says plainly when nothing is recorded', () => {
    expect(renderEpisodes([])).toMatch(/nothing recorded|no birth control/i);
  });

  it('lists each episode with its dates and method', () => {
    const html = renderEpisodes(episodes);
    expect(html).toContain('implant');
    expect(html).toContain('2015-01-01');
    expect(html).toContain('pill');
  });

  it('shows the newest first, because that is the one she is on', () => {
    const html = renderEpisodes(episodes);
    expect(html.indexOf('pill')).toBeLessThan(html.indexOf('implant'));
  });

  it('says which one is still current rather than printing a null end', () => {
    const html = renderEpisodes(episodes);
    expect(html).toMatch(/still on|current|now/i);
    expect(html).not.toMatch(/null|undefined|NaN/);
  });

  it('offers End only on an episode that is still open', () => {
    const open = renderEpisodes([episodes[1]]);
    const closed = renderEpisodes([episodes[0]]);
    expect(open).toContain('data-episode-end');
    expect(closed).not.toContain('data-episode-end');
  });

  it('carries the index on every control, so the handler needs no lookup', () => {
    const html = renderEpisodes(episodes);
    // Tied to the row, not merely present in the output: display is
    // newest-first while the index is the position in the array, so a
    // regression that emitted the post-sort position would still contain
    // the substring `data-episode-edit="0"` — just on the wrong method.
    const pillRow = html.slice(html.indexOf('pill'), html.indexOf('implant'));
    const implantRow = html.slice(html.indexOf('implant'));
    expect(pillRow).toContain('data-episode-edit="1"');
    expect(pillRow).toContain('data-episode-remove="1"');
    expect(implantRow).toContain('data-episode-edit="0"');
    expect(implantRow).toContain('data-episode-remove="0"');
  });

  it('escapes a method name rather than letting it become markup', () => {
    const html = renderEpisodes([
      { startedOn: '2015-01-01', endedOn: null, method: '<img src=x onerror=alert(1)>', expectedEffect: 'none' },
    ]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes an unknown effect exactly once', () => {
    const html = renderEpisodes([
      { startedOn: '2015-01-01', endedOn: null, method: 'x', expectedEffect: '<b>odd</b>' },
    ]);
    expect(html).toContain('&lt;b&gt;odd&lt;/b&gt;');
    expect(html).not.toContain('&amp;lt;');
  });
});

describe('renderEpisodeForm', () => {
  it('offers empty fields when adding', () => {
    const html = renderEpisodeForm({ episode: null, index: null });
    expect(html).toContain('id="episode-started"');
    expect(html).toContain('id="episode-ended"');
    expect(html).toContain('id="episode-method"');
    expect(html).toContain('id="episode-effect"');
    expect(html).not.toMatch(/value="20/);
  });

  it('offers every effect as a choice, with no method hardcoded', () => {
    const html = renderEpisodeForm({ episode: null, index: null });
    for (const effect of EFFECTS) expect(html).toContain(`value="${effect}"`);
    expect(html).not.toMatch(/implant|pill|IUD/i);
  });

  it('fills the fields when editing, and remembers which one', () => {
    const html = renderEpisodeForm({ episode: episodes[0], index: 0 });
    expect(html).toContain('value="2015-01-01"');
    expect(html).toContain('value="implant"');
    expect(html).toContain('data-episode-index="0"');
  });

  it('prints no null for an open episode being edited', () => {
    const html = renderEpisodeForm({ episode: episodes[1], index: 1 });
    expect(html).not.toMatch(/null|undefined/);
  });

  it('escapes a method name when filling the form', () => {
    const html = renderEpisodeForm({
      episode: { startedOn: '2015-01-01', endedOn: null, method: '"><script>x</script>', expectedEffect: 'none' },
      index: 0,
    });
    expect(html).not.toContain('<script>');
  });
});

describe('renderBackupWarning', () => {
  it('says nothing when a backup is recent', () => {
    expect(renderBackupWarning('2015-03-20', '2015-03-26')).toBe('');
  });

  it('warns when there has never been one', () => {
    expect(renderBackupWarning(null, '2015-03-26')).toMatch(/never|no backup/i);
  });

  it('warns once a backup is more than thirty days old, saying how old', () => {
    const html = renderBackupWarning('2015-01-01', '2015-03-26');
    expect(html).toMatch(/84 days/);
  });

  it('does not warn on the thirtieth day, only after it', () => {
    expect(renderBackupWarning('2015-02-24', '2015-03-26')).toBe('');
    expect(renderBackupWarning('2015-02-23', '2015-03-26')).not.toBe('');
  });
});

describe('renderSwitchForm', () => {
  it('asks for the one date she knows: when she changed', () => {
    const html = renderSwitchForm({ current: null, todayISO: '2015-11-05' });
    expect(html).toContain('id="switch-date"');
    expect(html).toContain('id="switch-method"');
    expect(html).toContain('id="switch-effect"');
    expect(html).toContain('id="switch-save"');
    expect(html).toMatch(/type="date"/);
  });

  it('defaults the date to today, since that is when most changes get logged', () => {
    expect(renderSwitchForm({ current: null, todayISO: '2015-11-05' }))
      .toContain('value="2015-11-05"');
  });

  it('names the method it will close, so she can see what will happen', () => {
    const html = renderSwitchForm({
      current: { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      todayISO: '2015-11-05',
    });
    expect(html).toContain('pill');
  });

  it('offers every effect and hardcodes no method name', () => {
    const html = renderSwitchForm({ current: null, todayISO: '2015-11-05' });
    for (const effect of EFFECTS) expect(html).toContain(`value="${effect}"`);
    expect(html).not.toMatch(/implant|pill|IUD/i);
  });

  it('escapes the current method name rather than letting it become markup', () => {
    const html = renderSwitchForm({
      current: { startedOn: '2015-02-01', endedOn: null, method: '<img src=x>', expectedEffect: 'none' },
      todayISO: '2015-11-05',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('prints no null when she is on nothing', () => {
    expect(renderSwitchForm({ current: null, todayISO: '2015-11-05' }))
      .not.toMatch(/null|undefined|NaN/);
  });
});

describe('renderEndForm', () => {
  // Replaces a window.prompt. The end date was the one date in this app she
  // had to type as free text, on a phone, with no picker.
  it('takes the end date through a date input, not free text', () => {
    const html = renderEndForm({
      episode: { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      index: 0,
      todayISO: '2015-11-05',
    });
    expect(html).toContain('id="end-date"');
    expect(html).toMatch(/<input id="end-date" type="date"/);
    expect(html).toContain('data-end-index="0"');
    expect(html).toContain('id="end-save"');
    expect(html).toContain('id="end-cancel"');
  });

  it('says which method it is ending and defaults to today', () => {
    const html = renderEndForm({
      episode: { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
      index: 0,
      todayISO: '2015-11-05',
    });
    expect(html).toContain('pill');
    expect(html).toContain('value="2015-11-05"');
  });

  it('survives index 0 without losing it', () => {
    expect(renderEndForm({
      episode: { startedOn: '2015-02-01', endedOn: null, method: 'x', expectedEffect: 'none' },
      index: 0,
      todayISO: '2015-11-05',
    })).toContain('data-end-index="0"');
  });
});

describe('renderEpisodeForm tells her which thing she is editing', () => {
  // The Edit button "did nothing" because the form it fills sat below the
  // change-method form, off-screen on a phone, and carried no heading — so it
  // was indistinguishable from the blank add form already sitting there.
  it('names the method when editing', () => {
    const html = renderEpisodeForm({
      episode: { startedOn: '2015-01-01', endedOn: null, method: 'implant', expectedEffect: 'suppress' },
      index: 0,
    });
    expect(html).toMatch(/<h4>[^<]*implant/i);
  });

  it('says it is adding when there is nothing to edit', () => {
    expect(renderEpisodeForm({ episode: null, index: null })).toMatch(/<h4>[^<]*add/i);
  });

  it('escapes the method name in the heading', () => {
    const html = renderEpisodeForm({
      episode: { startedOn: '2015-01-01', endedOn: null, method: '<img src=x>', expectedEffect: 'none' },
      index: 0,
    });
    expect(html).not.toContain('<img');
  });
});
