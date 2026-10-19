// Spec §9: four outputs. The data is hers and must never be trapped in this
// app. Everything here is a pure string builder — the Blob download lives in
// the glue, so the formats themselves are testable.
import { withoutSharing } from './sync/share.js';

export const EXPORT_VERSION = 1;

export const FILENAMES = {
  backup: 'cyclelog-backup.json',
  data: 'cyclelog-data.json',
  days: 'cyclelog-days.csv',
  cycles: 'cyclelog-cycles.csv',
};

const DAY_HEADER = [
  'date', 'flow', 'cramps', 'spotting', 'pms', 'discharge',
  'ovulation_test', 'pregnancy_test', 'mood', 'pain', 'medicine', 'notes',
  'source', 'date_precision',
];

const CYCLE_HEADER = [
  'cycle_start', 'period_end', 'period_length', 'cycle_length',
  'peak_flow', 'cramp_days', 'pms_days', 'spotting_days',
  'birth_control', 'date_precision', 'source', 'excluded', 'excluded_reason',
];

// A note is her own prose, so it will contain commas and quotes sooner or
// later; an unquoted comma silently shifts every later column.
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

const row = values => values.map(csvCell).join(',');

// Semicolons inside the cell rather than commas: the cell would be quoted
// either way, but a spreadsheet shows "sad; anxious" far more readably than a
// quoted comma list.
const list = values => ((values ?? []).length === 0 ? null : values.join('; '));

export function daysCsv(doc) {
  const dates = Object.keys(doc.days ?? {}).sort();
  const lines = [row(DAY_HEADER)];

  for (const date of dates) {
    const day = doc.days[date];
    lines.push(row([
      date,
      day.flow,
      day.cramps,
      day.spotting,
      day.pms === true,
      day.discharge,
      day.tests ? day.tests.ovulation : null,
      day.tests ? day.tests.pregnancy : null,
      list(day.mood),
      list(day.pain),
      list(day.medicine),
      day.notes === '' ? null : day.notes,
      day.source,
      day.precision,
    ]));
  }

  return `${lines.join('\n')}\n`;
}

export function cyclesCsv(cycles) {
  const lines = [row(CYCLE_HEADER)];

  for (const cycle of cycles) {
    lines.push(row([
      cycle.start,
      cycle.periodEnd,
      cycle.periodLength,
      cycle.length,
      cycle.peakFlow,
      cycle.crampDays,
      cycle.pmsDays,
      cycle.spottingDays,
      cycle.episodeMethod,
      cycle.precision,
      cycle.source,
      cycle.excluded === true,
      cycle.excludedReason,
    ]));
  }

  return `${lines.join('\n')}\n`;
}

// Critical 1, hardened one layer deeper: this is the human-facing plaintext
// export, and the one place `sharing` — the sync key, and the refresh token
// that mints her owner id tokens — must never reach a file on disk. The call
// site (src/ui/app.js) already strips it before calling this, which is
// correct but thin: it depends on every future caller remembering to. The
// vault's own path never goes through here at all — it goes through
// serializeDocument, straight to the encrypted store — so there is no
// legitimate caller of this function that wants the sharing section in its
// output. Stripping it here too, redundantly, costs nothing and means the
// guarantee holds even if a later caller forgets.
export function documentJson(doc) {
  return `${JSON.stringify(withoutSharing(doc), null, 2)}\n`;
}

// The encrypted backup: the sealed blob plus the non-secret key material
// needed to derive the key again. Safe to keep anywhere, because only her
// passphrase opens it — which is also the reason it says so in the file.
export function backupBundle({ meta, vault, exportedAt }) {
  if (!vault) throw new Error('refusing to write a backup with no vault in it');
  if (!meta) throw new Error('refusing to write a backup with no key material');

  return `${JSON.stringify({
    kind: 'cyclelog-backup',
    version: EXPORT_VERSION,
    exportedAt,
    note: 'Encrypted with a key derived from the passphrase. Without that '
      + 'passphrase there is no way to read this file — not by us, not by anyone.',
    meta,
    vault,
  }, null, 2)}\n`;
}
