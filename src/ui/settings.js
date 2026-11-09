// The Settings screen's own sections, as pure strings. The share card and the
// export buttons are NOT here: the share card has its own renderer
// (src/ui/share.js) and the export buttons are static markup in index.html.
// This file owns what is new — birth-control episodes and the backup warning.
import { escapeHtml } from './render.js';
import { EFFECTS } from '../episodes-edit.js';
import { diffDays } from '../dates.js';

// Plain words, not jargon: the stored value seeds a statistical prior, but
// what she is choosing is what the method does to her body.
export const EFFECT_LABELS = {
  suppress: 'Usually stops periods',
  regulate: 'Makes them regular',
  none: 'No hormonal effect',
};

// Spec §14: "periodic backup reminder in Settings". Thirty days, and it says
// how long it has actually been rather than nagging without information.
export const BACKUP_STALE_DAYS = 30;

const effectOptions = (selected) => EFFECTS.map((effect) => {
  const chosen = selected === effect ? ' selected' : '';
  return `<option value="${effect}"${chosen}>${escapeHtml(EFFECT_LABELS[effect])}</option>`;
}).join('');

export function renderEpisodes(birthControl) {
  const episodes = birthControl ?? [];
  if (episodes.length === 0) {
    return '<p id="episode-list">Nothing recorded yet. Add a method below if you are on one.</p>';
  }

  // Newest first: the current method is the one she came here to change.
  const rows = episodes
    .map((episode, index) => ({ episode, index }))
    .sort((a, b) => b.episode.startedOn.localeCompare(a.episode.startedOn))
    .map(({ episode, index }) => {
      const when = episode.endedOn === null
        ? `since ${escapeHtml(episode.startedOn)} — still on this`
        : `${escapeHtml(episode.startedOn)} to ${escapeHtml(episode.endedOn)}`;
      // Raw here — the interpolation site below is the one place this gets
      // escaped. Escaping twice would garble an out-of-vocabulary effect
      // into entity text instead of showing it plainly.
      const effect = EFFECT_LABELS[episode.expectedEffect] ?? episode.expectedEffect;
      const end = episode.endedOn === null
        ? `<button type="button" class="secondary" data-episode-end="${index}">End</button>`
        : '';
      return `<li><strong>${escapeHtml(episode.method)}</strong> — ${when}`
        + `<span class="episode-effect">${escapeHtml(effect)}</span>`
        + `<button type="button" class="secondary" data-episode-edit="${index}">Edit</button>`
        + end
        + `<button type="button" class="secondary" data-episode-remove="${index}">Remove</button>`
        + '</li>';
    })
    .join('');

  return `<ul id="episode-list">${rows}</ul>`;
}

export function renderEpisodeForm({ episode = null, index = null } = {}) {
  const value = field => (episode === null ? '' : escapeHtml(episode[field] ?? ''));
  const options = effectOptions(episode === null ? null : episode.expectedEffect);

  return [
    `<div id="episode-form" data-episode-index="${index === null ? '' : index}">`,
    '<label for="episode-started">Started on</label>',
    `<input id="episode-started" type="date" value="${value('startedOn')}">`,
    '<label for="episode-ended">Ended on (leave empty if you are still on it)</label>',
    `<input id="episode-ended" type="date" value="${value('endedOn')}">`,
    '<label for="episode-method">Method</label>',
    `<input id="episode-method" type="text" value="${value('method')}">`,
    '<label for="episode-effect">What it does to your cycle</label>',
    `<select id="episode-effect">${options}</select>`,
    `<button id="episode-save" type="button">${index === null ? 'Add this' : 'Save changes'}</button>`,
    index === null ? '' : '<button id="episode-cancel" type="button" class="secondary">Cancel</button>',
    '<p id="episode-error" role="alert"></p>',
    '</div>',
  ].join('');
}

export function renderBackupWarning(lastBackup, todayISO) {
  if (lastBackup === null || lastBackup === undefined) {
    return '<p class="backup-warning">No backup yet. If you lose this phone, you lose '
      + 'everything in it — download one and keep it somewhere safe.</p>';
  }
  const age = diffDays(lastBackup, todayISO);
  if (age <= BACKUP_STALE_DAYS) return '';
  return `<p class="backup-warning">Your last backup was ${escapeHtml(String(age))} days ago. `
    + 'Download a fresh one.</p>';
}

// The common case, as one action. A method change is two edits to the model
// (spec §3.1) but one fact to her: a date. Asking for both halves separately
// means she has to pick dates the overlap rule will accept, and the natural
// answer — ended the 5th, started the 5th — is the one it refuses.
export function renderSwitchForm({ current = null, todayISO }) {
  const closing = current === null
    ? '<p class="switch-note">You are not recording a method at the moment, so this just starts one.</p>'
    : `<p class="switch-note">This ends the ${escapeHtml(current.method)} the day before, `
      + 'and starts the new one on the date you give.</p>';

  return [
    '<div id="switch-form">',
    '<h4>I changed method</h4>',
    closing,
    '<label for="switch-date">Date you changed</label>',
    `<input id="switch-date" type="date" value="${escapeHtml(todayISO)}">`,
    '<label for="switch-method">New method</label>',
    '<input id="switch-method" type="text">',
    '<label for="switch-effect">What it does to your cycle</label>',
    `<select id="switch-effect">${effectOptions(null)}</select>`,
    '<button id="switch-save" type="button">Record the change</button>',
    '<p id="switch-error" role="alert"></p>',
    '</div>',
  ].join('');
}

// Stopping without starting anything else. Replaces a window.prompt: the end
// date was the one date in this app she had to type as free text, on a phone,
// with no picker and no validation until after she pressed go.
export function renderEndForm({ episode, index, todayISO }) {
  return [
    `<div id="end-form" data-end-index="${index}">`,
    `<h4>End the ${escapeHtml(episode.method)}</h4>`,
    '<label for="end-date">Date it ended</label>',
    `<input id="end-date" type="date" value="${escapeHtml(todayISO)}">`,
    '<button id="end-save" type="button">Save</button>',
    '<button id="end-cancel" type="button" class="secondary">Cancel</button>',
    '<p id="end-error" role="alert"></p>',
    '</div>',
  ].join('');
}
