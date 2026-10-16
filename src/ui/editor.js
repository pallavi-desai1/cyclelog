import { escapeHtml } from './render.js';

const option = (value, label) => ({ value, label });

export const FLOW_OPTIONS = [
  option('light', 'Light'), option('medium', 'Medium'), option('heavy', 'Heavy'),
];

// `unknown` is what Clue recorded when it knew cramps happened but not how
// badly. It stays selectable so an imported day can be opened, read and
// saved without quietly inventing an intensity she never gave.
export const CRAMP_OPTIONS = [
  option('none', 'None'), option('mild', 'Mild'), option('moderate', 'Moderate'),
  option('severe', 'Severe'), option('unknown', 'Unspecified'),
];

export const SPOTTING_OPTIONS = [
  option('red', 'Red'), option('brown', 'Brown'), option('none', 'None'),
];

export const DISCHARGE_OPTIONS = [
  option('none', 'None'), option('sticky', 'Sticky'), option('creamy', 'Creamy'),
  option('egg_white', 'Egg white'), option('watery', 'Watery'), option('spotty', 'Spotty'),
  option('unusual', 'Unusual'),
];

export const MOOD_OPTIONS = [
  option('happy', 'Happy'), option('confident', 'Confident'), option('calm', 'Calm'),
  option('sad', 'Sad'), option('anxious', 'Anxious'), option('angry', 'Angry'),
  option('sensitive', 'Sensitive'), option('stressed', 'Stressed'),
  option('withdrawn', 'Withdrawn'), option('mood_swings', 'Mood swings'),
];

export const PAIN_OPTIONS = [
  option('headache', 'Headache'), option('breast_tenderness', 'Breast tenderness'),
  option('ovulation', 'Ovulation pain'), option('backache', 'Backache'),
  option('nausea', 'Nausea'),
];

export const TEST_OPTIONS = [option('positive', 'Positive'), option('negative', 'Negative')];

const recorded = (detail, label) => {
  const item = detail.logged.find(entry => entry.label === label);
  return item === undefined ? '' : item.value;
};

const recordedList = (detail, label) => {
  const value = recorded(detail, label);
  return value === '' ? [] : value.split(', ');
};

// The Clue importer passes option strings through verbatim (src/importers/
// clue.js), so the vocabulary is open-ended by construction: a value this
// list has never heard of is not a bug in the data, and opening the day
// must not be what erases it. An unrecognised, non-empty `current` gets an
// extra option appended, selected, labelled with the raw value — honest
// beats pretty here, and it is exactly the same shape the discharge bug
// already was.
function select(id, name, options, current) {
  const known = current === '' || options.some(option => option.value === current);
  const withUnknown = known ? options : [...options, option(current, current)];
  const choices = [`<option value=""${current === '' ? ' selected' : ''}>—</option>`]
    .concat(withUnknown.map(({ value, label }) => (
      `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>`
      + `${escapeHtml(label)}</option>`
    )))
    .join('');
  return `<label for="${id}">${escapeHtml(name)}</label><select id="${id}">${choices}</select>`;
}

function checkboxes(group, legend, options, current) {
  const known = options.map(opt => opt.value);
  const unknown = current.filter(value => !known.includes(value)).map(value => option(value, value));
  const boxes = [...options, ...unknown].map(({ value, label }) => (
    `<label class="edit-check"><input type="checkbox" name="${group}"`
    + ` value="${escapeHtml(value)}"${current.includes(value) ? ' checked' : ''}>`
    + `${escapeHtml(label)}</label>`
  )).join('');
  return `<fieldset><legend>${escapeHtml(legend)}</legend>${boxes}</fieldset>`;
}

export function renderEditor(detail) {
  const flow = recorded(detail, 'Flow');
  const radios = FLOW_OPTIONS.map(({ value, label }) => (
    `<label class="edit-check"><input type="radio" name="flow"`
    + ` value="${escapeHtml(value)}"${value === flow ? ' checked' : ''}>${escapeHtml(label)}</label>`
  )).join('');

  return [
    `<form class="card editor" data-editing="${escapeHtml(detail.date)}">`,
    `<h3>${escapeHtml(detail.label)}</h3>`,
    `<fieldset><legend>Bleeding</legend>`,
    `<label class="edit-check"><input type="radio" name="flow" value="">`,
    // "None" would mean the same thing on screen as "nothing was ever
    // recorded here" — exactly the conflation that let an untouched save
    // on an entry-less day erase a real period (see applyDayEdit).
    `Not recorded</label>${radios}</fieldset>`,
    select('edit-cramps', 'Cramps', CRAMP_OPTIONS, recorded(detail, 'Cramps')),
    select('edit-spotting', 'Spotting', SPOTTING_OPTIONS, recorded(detail, 'Spotting')),
    select('edit-discharge', 'Discharge', DISCHARGE_OPTIONS, recorded(detail, 'Discharge')),
    checkboxes('mood', 'Mood', MOOD_OPTIONS, recordedList(detail, 'Mood')),
    checkboxes('pain', 'Pain', PAIN_OPTIONS, recordedList(detail, 'Pain')),
    select('edit-ovulation', 'Ovulation test', TEST_OPTIONS, recorded(detail, 'Ovulation test')),
    select('edit-pregnancy', 'Pregnancy test', TEST_OPTIONS, recorded(detail, 'Pregnancy test')),
    `<label class="edit-check"><input type="checkbox" id="edit-pms"`,
    `${recorded(detail, 'PMS') === 'yes' ? ' checked' : ''}>PMS</label>`,
    `<label for="edit-notes">Notes</label>`,
    `<textarea id="edit-notes" rows="3">${escapeHtml(recorded(detail, 'Notes'))}</textarea>`,
    `<label class="edit-check"><input type="checkbox" id="edit-approx"`,
    `${detail.isApproximate ? ' checked' : ''}>This date is approximate</label>`,
    `<button id="edit-save" type="button">Save</button>`,
    `<button id="edit-cancel" type="button" class="secondary">Cancel</button>`,
    `<p id="edit-error" role="alert"></p>`,
    '</form>',
  ].join('');
}

const orNull = value => (value === '' ? null : value);

export function patchFromValues(values) {
  return {
    // Flow is separated because it moves the period itself, not just the day.
    flow: orNull(values.flow),
    approximate: values.approximate === true,
    patch: {
      cramps: orNull(values.cramps),
      spotting: orNull(values.spotting),
      discharge: orNull(values.discharge),
      pms: values.pms === true,
      mood: [...values.mood],
      pain: [...values.pain],
      tests: {
        ovulation: orNull(values.ovulation),
        pregnancy: orNull(values.pregnancy),
      },
      notes: values.notes,
    },
  };
}

// A save's write to the vault always lands — one seal(), one whole-document
// write, never a merge. What varies is what the *view* may do once it does,
// and that needs three answers, not two. The second check compares SESSION
// tokens, not the date being edited: two sessions opened back-to-back on the
// same day (open X, Save pending, Cancel, reopen X, type new values) share a
// date but are not the same editor, and only a token distinguishes them.
//   - 'abandon': the vault locked while the write was in flight. epochNow
//     (bumped only by returnToLock) has moved, so the decrypted document
//     must not come back into memory at all; the next unlock reads it fresh.
//   - 'adopt-only': the vault did not lock, but a different editor session is
//     open now — a different day, no day, or a fresh session on the same
//     day. The vault holds `next`, so memory must too, or the next save
//     would compute from a stale base and silently overwrite this one's
//     write — but the session on screen is not this save's and must not be
//     repainted.
//   - 'adopt-and-render': neither moved. Memory and the screen both update —
//     this covers Cancel-with-no-reopen too: the panel is showing the day
//     read-only, and repainting it with what was just saved is correct.
export function saveOutcome({ epochAtStart, epochNow, sessionAtStart, sessionNow }) {
  if (epochAtStart !== epochNow) return 'abandon';
  if (sessionAtStart !== sessionNow) return 'adopt-only';
  return 'adopt-and-render';
}
