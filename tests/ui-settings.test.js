import { describe, it, expect } from 'vitest';
import {
  EFFECT_LABELS, renderEpisodes, renderEpisodeForm, renderBackupWarning,
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
    expect(html).toContain('data-episode-edit="0"');
    expect(html).toContain('data-episode-remove="0"');
  });

  it('escapes a method name rather than letting it become markup', () => {
    const html = renderEpisodes([
      { startedOn: '2015-01-01', endedOn: null, method: '<img src=x onerror=alert(1)>', expectedEffect: 'none' },
    ]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
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
