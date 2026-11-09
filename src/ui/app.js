import { indexedDbBackend, readMeta, VAULT_KEY } from '../store.js';
import { createVault } from '../unlock.js';
import {
  biometricSupported, enrollBiometric, biometricKey,
  rememberCredentialId, readCredentialId,
} from '../biometric.js';
import {
  documentFromSources, emptyDocument, serializeDocument, parseDocument, describeImport,
} from '../import.js';
import { buildSummary } from '../summary.js';
import { buildCycles } from '../cycles.js';
import {
  FILENAMES, backupBundle, documentJson, daysCsv, cyclesCsv,
} from '../export.js';
import {
  classifyRestoreFile, parseBackupBundle, restoreBackup,
  markBackup, readLastBackup, requestPersistentStorage, eraseConfirmed,
} from '../restore.js';
import {
  monthGrid, monthOf, shiftMonth, monthLabel, projectedDates, monthRange, clampMonth,
} from '../calendar.js';
import { dayDetail } from '../day.js';
import {
  renderSummary, renderCalendar, renderDay, renderMonthPicker,
} from './render.js';
import { localToday } from '../today.js';
import { addDays } from '../dates.js';
import { applyDayEdit } from '../edit.js';
import { renderEditor, patchFromValues, saveOutcome } from './editor.js';
import { renderShareCard, PUSH_DEBOUNCE_MS } from './share.js';
import {
  shareState, withSharing, withScope, withIdentity, withViewer, withoutViewer,
  withPushResult, withoutSharing, buildPayload,
} from '../sync/share.js';
import { generateSyncKey, fingerprint, importSyncKey } from '../sync/key.js';
import {
  signInAnonymously, refreshIdToken, putVault, grantViewer, revokeViewer, deleteVault,
} from '../sync/firestore.js';
import { viewerRecord, parseViewerRecord, isViewerRecord, fetchShared } from '../sync/viewer.js';
import { renderViewerHeader } from './viewer.js';
import { FIREBASE } from '../config.js';
import {
  renderEpisodes, renderEpisodeForm, renderBackupWarning, renderSwitchForm, renderEndForm,
} from './settings.js';
import {
  addEpisode, updateEpisode, endEpisode, removeEpisode, switchMethod, validateEpisode,
} from '../episodes-edit.js';
import {
  mergeIntoDocument, mergeConflicts, describeConflicts, describeMerge,
} from '../merge.js';

if ('serviceWorker' in navigator) {
  // Registration failure is not fatal: without the worker the app still runs,
  // it just will not open offline.
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}

const RP_NAME = 'CycleLog';
const IDLE_CHECK_MS = 30 * 1000;
const backend = indexedDbBackend();
const vault = createVault({ backend });

const el = id => document.getElementById(id);
const show = id => { el(id).hidden = false; };
const hide = id => { el(id).hidden = true; };
const say = (id, message) => {
  const field = el(id);
  if (field !== null) field.textContent = message;
};

function screen(name) {
  for (const id of ['setup', 'lock', 'app', 'settings', 'viewer-screen']) {
    if (id === name) show(id); else hide(id);
  }
}

// True once a vault exists on this device — set by start() on load and by
// create() the moment setup succeeds.
let hasVault = false;

// Shared by the lock button, the visibility check and the idle timer: the
// summary must not survive any path back to the lock screen.
function returnToLock() {
  el('summary').innerHTML = '';
  el('calendar').innerHTML = '';
  closePicker();
  el('day-detail').innerHTML = '';
  el('share').innerHTML = '';
  el('episodes').innerHTML = '';
  el('switch-form-host').innerHTML = '';
  el('episode-form-host').innerHTML = '';
  el('backup-warning').innerHTML = '';
  // His cached copy of her data is held only in memory (viewerShared) and in
  // the DOM this clears — never written anywhere his vault would persist it
  // past the lock.
  el('viewer').innerHTML = '';
  el('viewer-calendar').innerHTML = '';
  say('viewer-label', '');
  el('viewer-day').innerHTML = '';
  say('viewer-error', '');
  // Static markup, not part of #viewer's innerHTML, so the clear above does
  // not reach it — a typed key left sitting here across a lock is the same
  // plaintext-input exposure createViewer already guards against.
  clear('viewer-rekey-input');
  say('viewer-rekey-fingerprint', '');
  // Same rule for the passphrase fields on Settings: a typed passphrase
  // sitting in a plaintext input across a lock is the exposure createViewer
  // already guards against.
  clear('passphrase-current');
  clear('passphrase-next');
  clear('passphrase-confirm');
  say('passphrase-notice', '');
  say('passphrase-error', '');
  say('faceid-notice', '');
  say('erase-error', '');
  // A push timer armed before the lock must not fire against a document
  // that no longer exists in memory — openDoc is cleared a few lines down.
  if (pushTimer !== null) { clearTimeout(pushTimer); pushTimer = null; }
  say('cal-label', '');
  say('import-notice', '');
  // Holds describeImport output — counts derived from her document — so
  // leaving it set survived both the lock and the erase, and the first
  // visit to Settings after a fresh setup still described the history that
  // was destroyed.
  say('settings-import-notice', '');
  // The decrypted document must not outlive the lock (spec §8), and the
  // calendar is the one place it was being held outside the vault.
  openDoc = null;
  openSummary = null;
  // Same rule for his side: the record and the cached, decrypted copy of her
  // data must not survive his lock either.
  viewerRecordData = null;
  viewerShared = null;
  viewerDate = null;
  viewerMonth = null;
  viewerSummary = null;
  // The editing draft lives only in the DOM the lock screen is about to
  // replace, but the flag that says "a form is open" is state in this
  // module, and must not survive to the next unlock.
  editing = null;
  // A save already in flight when the lock fires still finishes and still
  // writes to the vault correctly — that write must not be undone. What the
  // epoch bump prevents is the *view* adopting that write afterwards, on top
  // of a lock screen that has nothing to do with it any more.
  sessionEpoch += 1;
  // Before any vault exists she is mid-setup, and a hide fires here for
  // ordinary reasons — the file picker, a glance at another app. Switching
  // screens then would strand her on a lock screen for a vault that does not
  // exist, where her new passphrase "does not work" and only a reload helps.
  if (!hasVault) return;
  screen('lock');
}

// note is the plain-text import summary from a just-completed setup, or ''
// on every later unlock. It goes through say() (textContent), never through
// the HTML the renderer builds, so it cannot smuggle markup into the page.
// Held only while unlocked, and dropped by returnToLock: the calendar needs
// the document again on every month step, and re-decrypting per tap would be
// both slower and no safer.
let openDoc = null;
let openSummary = null;
let viewMonth = null;
let selectedDate = null;

// His side: the vault holds a viewer record instead of a document, so there
// is nothing here matching openDoc's shape. viewerRecordData is the parsed
// record (whose uid to fetch, the key, his identity); viewerShared is the
// last successful fetch — held only in memory, dropped by returnToLock
// exactly as openDoc is. Never written back to the vault: his cache of her
// data lives in RAM for the length of his session, nowhere else.
let viewerRecordData = null;
let viewerShared = null;
// Which day of her shared copy he has open, and the summary his calendar was
// drawn from. Kept here rather than read back out of the DOM so the panel can
// be redrawn after a refresh without re-deriving what he had selected.
let viewerDate = null;
// Which month he is looking at. His calendar used to be pinned to the current
// month, with no controls at all — the arrows and Today are static markup on
// her screen — so when the month turned over he had no way back to the month
// her period was in.
let viewerMonth = null;
let viewerSummary = null;

// The date currently open in the editor, or null when the day panel is
// showing its read-only view instead. Cleared by returnToLock, by a
// successful save, and by Cancel.
let editing = null;

// A pure lock generation: bumped only by returnToLock, never by opening a
// new editor. A save whose write resolves after a lock can tell the
// decrypted document must not come back into memory at all — the next
// unlock reads it fresh. Opening a different editor mid-save is a separate
// case (see saveOutcome/'adopt-only'): memory still needs the write, so it
// must not share this counter.
let sessionEpoch = 0;

// The editor's own identity, independent of `editing` (which holds a date,
// not a session). Two sessions opened back-to-back on the SAME day are
// otherwise indistinguishable by date alone: open day X, Save (pending),
// Cancel, reopen day X, type new values — the pending save's `date` still
// equals `editing` when it resolves, even though it is a different editor
// from the one on screen. Bumped only here, in openEditor, on every open.
let editSession = 0;

// A real lock on saveDay itself, not just the button's `disabled` attribute:
// the panel is re-rendered by Cancel/openEditor mid-save, which would hand a
// second call a brand-new, enabled button while the first save is still
// pending.
let saveInFlight = false;

// The in-flight vault.save() promise, held so paint() can wait for it. An
// unlock arriving while a save is still landing would otherwise read
// vault.read() before the write does — backgrounded, IndexedDB work can be
// suspended for as long as she is away — leaving memory on the pre-save
// document while the vault ends up with the saved one; her next save would
// then compute from that stale base and silently overwrite the earlier edit.
let pendingSave = null;

// The date of a save that failed on a path with nowhere left to show its
// own message — the form (and #edit-error with it) was already gone by the
// time the rejection arrived, typically because the vault locked first.
// Memory only, never persisted, and surfaced once, the next time paint()
// runs.
let unsavedWarning = null;

// The debounced push's timer. Set by schedulePush, cleared by itself when it
// fires and by returnToLock so a lock cannot leave a push armed against a
// document that is about to leave memory.
let pushTimer = null;

// `navigate: false` repaints everything in place without ending on the app
// screen — Settings repaints the summary an episode change invalidated while
// she is still standing on Settings, and navigating there and back flashed
// the home screen at her.
async function paint(note = '', { navigate = true } = {}) {
  // See pendingSave above. Ignoring a rejection here is deliberate: a save
  // that failed is unsavedWarning's problem to surface, not a reason to
  // block getting back into the app.
  await pendingSave?.catch(() => {});
  const content = vault.read();
  // The vault code is unchanged either way — his record is just what his
  // vault happens to hold. Nothing else in this function applies to it.
  if (isViewerRecord(content)) {
    await paintViewer();
    return;
  }
  openDoc = parseDocument(content);
  openSummary = buildSummary(openDoc, localToday());
  el('summary').innerHTML = renderSummary(openSummary);
  if (unsavedWarning !== null) {
    note = `Your last entry may not have saved — please check ${unsavedWarning}.`;
    unsavedWarning = null;
  }
  say('import-notice', note);
  viewMonth = monthOf(localToday());
  selectedDate = null;
  showLastBackup();
  drawCalendar();
  await drawShare();
  // Critical 3: a push interrupted by a lock (returnToLock clears the timer;
  // iOS can lock within the 5s debounce window) must retry rather than sit
  // there forever — this is the only remaining chance, since nothing else
  // retries it. 'ok' is the only status that means he actually has it.
  // openDoc can go null during the await just above (a lock racing this
  // same paint) — shareState(null) would throw, so this has to guard too.
  if (openDoc !== null) {
    const sharing = shareState(openDoc);
    if (sharing.key !== null && sharing.lastPush !== null && sharing.lastPush.status !== 'ok') {
      schedulePush().catch(() => {});
    }
  }
  if (navigate) screen('app');
}

// Review Focus 3: she only trusts this card if it tells the truth about what
// reached him, so every draw re-reads the stored push result, never a guess.
async function drawShare() {
  if (openDoc === null) return;
  const state = shareState(openDoc);
  el('share').innerHTML = renderShareCard({
    state,
    fingerprint: state.key === null ? '' : await fingerprint(state.key),
    ownerUid: state.identity === null ? null : state.identity.uid,
  });
}

// The settings screen's panes. Called on entry and after every change, so the
// episode list and the backup warning are never a stale view of the document
// they describe.
async function drawSettings() {
  if (openDoc === null) return;
  el('episodes').innerHTML = renderEpisodes(openDoc.birthControl);
  // Rebuilt on every draw so the method it offers to close is the current
  // one, not whichever was open when the screen was first opened.
  el('switch-form-host').innerHTML = renderSwitchForm({
    current: (openDoc.birthControl ?? []).find(episode => episode.endedOn === null) ?? null,
    todayISO: localToday(),
  });
  if (el('episode-form-host').innerHTML === '') {
    el('episode-form-host').innerHTML = renderEpisodeForm({ episode: null, index: null });
  }
  el('backup-warning').innerHTML = renderBackupWarning(await readLastBackup(backend), localToday());
  await drawShare();
}

// paint() recomputes the summary and ends by switching to the home screen,
// which is right for every other caller and wrong here: an episode change
// has to repaint the summary it invalidated WITHOUT navigating away from
// the screen she is still working on.
async function repaintFromSettings() {
  // paint() resets viewMonth and selectedDate unconditionally, so where she
  // was in the calendar is captured here and put back afterwards: an episode
  // edit must not quietly send her back to this month with nothing selected.
  const month = viewMonth;
  const date = selectedDate;
  await paint('', { navigate: false });
  if (openDoc === null) return;
  viewMonth = month;
  selectedDate = date;
  drawCalendar();
  // The panel still holds the adapted and baseline dates computed before the
  // episode changed, and paint() does not re-render it. A stale prediction
  // one screen away is worse than none.
  el('day-detail').innerHTML = '';
  screen('settings');
  await drawSettings();
}

// Every write from Settings goes through here. saveDay already carries the
// hard-won rules — the vault is the authority, nothing is adopted into
// memory until the encrypted write resolves, a concurrent paint() waits on
// pendingSave rather than reading the pre-write document, and a lock
// arriving mid-write must not revive the document afterwards. A second
// write path that forgot any of them is what let a removed episode come
// back. Returns true only when the vault actually holds `next`.
async function saveSettingsDoc(next, errorId = 'episode-error') {
  if (saveInFlight) {
    say(errorId, 'Still saving — one moment.');
    return false;
  }
  saveInFlight = true;
  const epoch = sessionEpoch;
  let writePromise;
  try {
    writePromise = vault.save(serializeDocument(next));
    pendingSave = writePromise;
    await writePromise;
    if (sessionEpoch !== epoch) return false;
    openDoc = next;
    // An episode is precisely the thing that moves the prediction model, so
    // the shared copy is wrong until it is pushed. Not awaited: her write
    // already landed, and the courtesy copy must never hold that up.
    schedulePush().catch(() => {});
    return true;
  } catch {
    say(errorId, 'That could not be saved. Try again.');
    return false;
  } finally {
    saveInFlight = false;
    // Only clear the slot this call itself set — a stale handle from the
    // wrong call must never erase a newer save's pendingSave.
    if (pendingSave === writePromise) pendingSave = null;
  }
}

// Reads the form, asks the model to apply it, writes the vault, then repaints.
// The model is the only thing that decides whether an episode is allowed; this
// function's job is to report what it said.
async function saveEpisode() {
  if (openDoc === null) return;
  const host = el('episode-form-host');
  const raw = host.querySelector('#episode-form').dataset.episodeIndex;
  const index = raw === '' ? null : Number(raw);
  const episode = {
    startedOn: el('episode-started').value,
    endedOn: el('episode-ended').value === '' ? null : el('episode-ended').value,
    method: el('episode-method').value,
    expectedEffect: el('episode-effect').value,
  };

  let next;
  try {
    next = index === null
      ? addEpisode(openDoc, episode)
      : updateEpisode(openDoc, index, episode);
  } catch (error) {
    say('episode-error', error.message);
    return;
  }

  const ok = await saveSettingsDoc(next, 'episode-error');
  if (ok === false || openDoc === null) return;
  say('episode-error', '');
  host.innerHTML = '';
  // An episode changes which cycles count as baseline and which adaptation
  // applies, so the summary on the home screen is now wrong until repainted.
  await repaintFromSettings();
}

function editEpisodeAt(index) {
  if (openDoc === null) return;
  const episode = (openDoc.birthControl ?? [])[index];
  if (episode === undefined) return;
  el('episode-form-host').innerHTML = renderEpisodeForm({ episode, index });
}

// Opens a date picker instead of asking her to type a date into a prompt.
// The write itself happens in saveEndDate, so ending a method goes through
// the same guarded path as every other settings write.
function endEpisodeAt(index) {
  if (openDoc === null) return;
  const episode = (openDoc.birthControl ?? [])[index];
  if (episode === undefined) return;
  el('episode-form-host').innerHTML = renderEndForm({
    episode, index, todayISO: localToday(),
  });
}

async function switchMethodNow() {
  if (openDoc === null) return;
  let next;
  try {
    next = switchMethod(openDoc, {
      changedOn: el('switch-date').value,
      method: el('switch-method').value,
      expectedEffect: el('switch-effect').value,
    });
  } catch (error) {
    return say('switch-error', error.message);
  }
  const ok = await saveSettingsDoc(next, 'switch-error');
  if (!ok) return;
  el('episode-form-host').innerHTML = '';
  await repaintFromSettings();
}

async function saveEndDate() {
  if (openDoc === null) return;
  const form = document.getElementById('end-form');
  if (form === null) return;
  const index = Number(form.dataset.endIndex);
  let next;
  try {
    next = endEpisode(openDoc, index, el('end-date').value);
  } catch (error) {
    return say('end-error', error.message);
  }
  const ok = await saveSettingsDoc(next, 'end-error');
  if (!ok) return;
  el('episode-form-host').innerHTML = '';
  await repaintFromSettings();
}

async function removeEpisodeAt(index) {
  if (openDoc === null) return;
  const episode = (openDoc.birthControl ?? [])[index];
  if (episode === undefined) return;
  // Named, not "are you sure": removing an episode changes which cycles count
  // as baseline, so it is not a cosmetic deletion.
  const confirmed = window.confirm(
    `Remove the ${episode.method} that started ${episode.startedOn}? `
    + 'Your predictions will change.',
  );
  if (!confirmed) return;

  const next = removeEpisode(openDoc, index);
  const ok = await saveSettingsDoc(next, 'episode-error');
  if (ok === false || openDoc === null) return;
  // An edit form left open across this write remembers an index into
  // positions that have just moved — removeEpisode re-indexes — so saving
  // it would land on a different episode than the one on screen.
  el('episode-form-host').innerHTML = '';
  await repaintFromSettings();
}

// A later export merged into what is already here. Replacing would throw away
// every day logged by hand since the last import, which is most of them.
async function importMore(files) {
  if (openDoc === null || files.length === 0) return;
  say('settings-import-notice', 'Reading your files…');
  try {
    // Classified by content, the way the setup screen does it, rather than by
    // extension. The extension routing was wrong twice over: a Clue export
    // named Clue.JSON went to the legacy parser and imported nothing while
    // reporting success, and every genuinely-named .json file was handed to
    // the Clue parser as the file's TEXT — which spreads it into single
    // characters, so a small export reported one unreadable "line" per
    // character and a real one blew the stack and blamed her file. A second
    // file of either kind is refused rather than silently overwriting the
    // first.
    let clueRecords = null;
    let legacyText = null;
    let documentText = null;
    for (const file of files) {
      const text = await file.text();
      const kind = classifyRestoreFile(text);
      if (kind === 'backup') {
        // A backup REPLACES everything, so merging one into the open document
        // is not what that file is for. It must not name the lock screen:
        // #restore-file lives on the setup screen, which is only reached with
        // no vault on the device, so a phone that already holds her log will
        // never offer it. Saying where it IS would send her to a dead end.
        return say('settings-import-notice', 'That is an encrypted backup, which replaces a '
          + 'whole log rather than adding to one — it can only be restored onto a phone with '
          + 'no log on it yet. To import into this log, use a data export instead.');
      }
      if (kind === 'document') {
        if (documentText !== null) return say('settings-import-notice', 'Choose one export file at a time.');
        documentText = text;
        continue;
      }
      // Not one of ours. A Clue export is a bare JSON array of records; a
      // legacy log is plain text. Parsing is the only way to tell, and it is
      // also the step whose absence made this whole feature dead: the Clue
      // parser needs the array, not the file's text.
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        if (clueRecords !== null) return say('settings-import-notice', 'Choose one export file at a time.');
        clueRecords = parsed;
      } else {
        if (legacyText !== null) return say('settings-import-notice', 'Choose one export file at a time.');
        legacyText = text;
      }
    }
    if (clueRecords === null && legacyText === null && documentText === null) {
      return say('settings-import-notice', 'Those files could not be read.');
    }
    // One of her own plaintext exports is already a finished document; the
    // other two kinds are raw sources a parser builds one from. Mixing the
    // two in a single import is the same "one at a time" refusal.
    if (documentText !== null && (clueRecords !== null || legacyText !== null)) {
      return say('settings-import-notice', 'Choose one export file at a time.');
    }
    if (openDoc === null) return;

    // Her own plaintext export needs no importer and carries no warnings:
    // parseDocument either returns the document or throws on a version it
    // cannot read honestly.
    const incoming = documentText !== null
      ? { doc: parseDocument(documentText), warnings: [] }
      : documentFromSources({ clueJson: clueRecords, legacyText });
    const merged = mergeIntoDocument(openDoc, incoming.doc);
    // Her birth-control history is hers: she maintains it by hand in this
    // screen, with real end dates. An export carries every episode as still
    // open, and the merge lets the incoming side win a tie on startedOn — so
    // importing it produced two open episodes, after which every prediction
    // followed the method she had ended. Days, spans and gaps merge; this
    // section does not.
    const kept = { ...merged, birthControl: openDoc.birthControl ?? [] };
    // Belt and braces for the section that silently decides every
    // prediction: if a merge ever produces a shape validateEpisode rejects,
    // nothing is written.
    const episodes = kept.birthControl ?? [];
    for (const [index, episode] of episodes.entries()) {
      const problem = validateEpisode(episode, { existing: episodes, ignoreIndex: index });
      if (problem !== null) {
        // These are her STORED episodes — the file's were discarded above — so
        // this can only fire when what is already saved is inconsistent, and
        // blaming the file would be wrong. An older build's re-import could
        // leave two open episodes, which is exactly this shape.
        return say('settings-import-notice', 'Nothing was imported: your birth control '
          + `history needs fixing first — ${problem}`);
      }
    }
    // Computed from the same base as the merge, before the write moves
    // openDoc on: she is owed a word about anything the merge had to choose
    // between. describeConflicts owns the wording and the counting rule, so
    // both can be tested against real conflicts.
    const conflicts = mergeConflicts(openDoc, incoming.doc);
    const ok = await saveSettingsDoc(kept, 'settings-import-notice');
    if (ok === false || openDoc === null) return;
    // An edit form left open across this write remembers an index into
    // positions that have just moved — the merge re-sorts birthControl — so
    // saving it would land on a different episode than the one on screen.
    el('episode-form-host').innerHTML = '';
    // describeMerge, not describeImport: describeImport answers "what was in
    // this file", and after a re-import of her own export that is her whole
    // history, so a no-op import announced itself as having imported nine
    // years. What she needs is the delta the merge actually produced.
    const parts = [describeMerge(openDoc, kept)];
    if ((incoming.doc.birthControl ?? []).length > 0) {
      parts.push('Your birth control history was left as it is — add or change methods above.');
    }
    // Days, not fields, and her own values, not the file's: mergeDay ranks
    // `manual` above both importers, so a day she corrected by hand wins and
    // the conflict records HER value as kept. The old sentence said the
    // imported version won and told her to check her birth control dates,
    // neither of which was true.
    const conflictNote = describeConflicts(conflicts);
    if (conflictNote !== '') parts.push(conflictNote);
    say('settings-import-notice', parts.join(' '));
    await repaintFromSettings();
  } catch {
    say('settings-import-notice', 'Those files could not be read.');
  }
}

// Where a period would have fallen in THIS month, not merely the next one
// — the comparison she asked for only works if the ghost keeps its cadence
// across every month she looks at. A window slightly wider than the grid
// covers the padding days at either end.
function ghostDatesFor(month) {
  if (!openSummary.baseline.available) return [];
  // No `?? baseline.date` fallback: projecting from the next ghost instead of
  // the anchor silently drops every month before it, which is most of the
  // comparison. A missing anchor means no cadence, not a different one.
  return projectedDates(
    openSummary.baseline.anchor,
    openSummary.baseline.length,
    addDays(`${month}-01`, -10),
    addDays(`${month}-01`, 45),
  );
}

function drawCalendar() {
  if (openDoc === null || viewMonth === null) return;
  const grid = monthGrid(openDoc, {
    month: viewMonth,
    todayISO: localToday(),
    adaptedDate: openSummary.adapted.date,
    baselineDates: ghostDatesFor(viewMonth),
  });
  say('cal-label', grid.label);
  el('calendar').innerHTML = renderCalendar(grid);
  markSelected();
}

// Applied after each render rather than baked into the grid model: the
// selection is a property of this view, not of her data.
function markSelected() {
  if (selectedDate === null) return;
  const cell = el('calendar').querySelector(`[data-date="${selectedDate}"]`);
  if (cell !== null) cell.classList.add('cal-selected');
}

function selectDay(date) {
  if (openDoc === null) return;
  selectedDate = date;
  for (const cell of el('calendar').querySelectorAll('.cal-selected')) {
    cell.classList.remove('cal-selected');
  }
  markSelected();
  el('day-detail').innerHTML = renderDay(dayDetail(openDoc, date, {
    todayISO: localToday(),
    adaptedDate: openSummary.adapted.date,
    baselineDates: ghostDatesFor(monthOf(date)),
  }));
}

function openEditor(date) {
  if (openDoc === null) return;
  editing = date;
  // A fresh session, even over the same day: a save still pending from
  // whatever was open before this must be able to tell it is no longer the
  // editor on screen, which the date in `editing` alone cannot distinguish
  // from a second session on the same day. Opening a different editor is
  // not a lock, though — the save in flight still needs to land in memory —
  // so this is a separate counter from the one the lock screen bumps.
  editSession += 1;
  el('day-detail').innerHTML = renderEditor(dayDetail(openDoc, date, {
    todayISO: localToday(),
    adaptedDate: openSummary.adapted.date,
    baselineDates: ghostDatesFor(monthOf(date)),
  }));
}

// Reads the form the editor rendered. The DOM is the only place these values
// exist, so this function is the boundary: everything it returns goes
// straight into patchFromValues, which is pure and tested.
function formValues() {
  const checked = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)]
    .map(input => input.value);
  const flow = checked('flow');
  return {
    flow: flow.length === 0 ? '' : flow[0],
    cramps: el('edit-cramps').value,
    spotting: el('edit-spotting').value,
    discharge: el('edit-discharge').value,
    pms: el('edit-pms').checked,
    mood: checked('mood'),
    pain: checked('pain'),
    medicine: checked('medicine'),
    ovulation: el('edit-ovulation').value,
    pregnancy: el('edit-pregnancy').value,
    notes: el('edit-notes').value,
    approximate: el('edit-approx').checked,
  };
}

async function saveDay() {
  if (editing === null) return;
  if (saveInFlight) {
    // A freshly re-rendered Save button is enabled again even while an
    // earlier save for this same day is still pending — the disabled
    // attribute does not survive a re-render, only this flag does. A tap
    // that lands in that window must say so rather than silently doing
    // nothing.
    const errorField = document.getElementById('edit-error');
    if (errorField !== null) errorField.textContent = 'Still saving — one moment.';
    return;
  }
  saveInFlight = true;
  const button = document.getElementById('edit-save');
  if (button !== null) button.disabled = true;
  const date = editing;
  const epoch = sessionEpoch;
  const session = editSession;
  let writePromise;
  try {
    // applyDayEdit (src/edit.js) only moves the flow's span when the flow
    // actually changed — an untouched save on a day with no entry must not
    // read its unchecked flow radio as a deliberate clear.
    const next = applyDayEdit(openDoc, date, patchFromValues(formValues()));

    // The vault is the authority. Nothing in the view adopts the new document
    // until the encrypted write has resolved, so a failed save leaves her
    // looking at what is actually stored. pendingSave lets a paint() that
    // starts mid-write wait for it instead of reading the pre-save document.
    writePromise = vault.save(serializeDocument(next));
    pendingSave = writePromise;
    await writePromise;

    const outcome = saveOutcome({
      epochAtStart: epoch, epochNow: sessionEpoch, sessionAtStart: session, sessionNow: editSession,
    });
    // Locked while we were saving: the write landed and is correct, but the
    // decrypted document must not come back into memory. The next unlock
    // reads it from the vault.
    if (outcome === 'abandon') return;

    // The vault now holds `next`, so memory must too — whether or not this
    // is still the visible session. Skipping this is what let a later save
    // compute from a stale base and overwrite what this one just wrote.
    openDoc = next;
    openSummary = buildSummary(openDoc, localToday());
    // The card and the grid repaint on every non-abandoned outcome — a
    // period she just recorded must not go on reading "days late" just
    // because a different editor happened to be open when the write landed.
    // Neither touches #day-detail, so an open draft for another day survives.
    el('summary').innerHTML = renderSummary(openSummary);
    drawCalendar();
    // Not awaited: her save just landed in the vault, and sending a copy to
    // him is a courtesy that must never hold that up. Important 10: now
    // that schedulePush itself awaits a vault write before arming the
    // timer, a rejection from that write must not become an unhandled
    // promise rejection the one place a fire-and-forget call like this one
    // reaches it.
    schedulePush().catch(() => {});
    if (outcome === 'adopt-only') return; // a different editor is open now; leave #day-detail alone

    editing = null;
    // She may have Cancelled and tapped a different day on the calendar
    // while this was saving — her panel belongs to whatever she is looking
    // at now, not to the day that just finished saving, unless those are
    // the same day.
    if (selectedDate === date) selectDay(date);
  } catch {
    // A failed save never reached the vault, so there is nothing for memory
    // to adopt — only whether this is still the visible form, to decide
    // whether writing to #edit-error would land on the right panel at all.
    const outcome = saveOutcome({
      epochAtStart: epoch, epochNow: sessionEpoch, sessionAtStart: session, sessionNow: editSession,
    });
    if (outcome !== 'adopt-and-render') {
      // Neither #edit-error (gone behind the lock screen, or belonging to a
      // different editor now) nor anywhere else in the current view can
      // report this failure. Remembered in memory only, surfaced once the
      // next time paint() runs.
      unsavedWarning = date;
      return;
    }
    const errorField = document.getElementById('edit-error');
    if (errorField !== null) {
      errorField.textContent = 'That did not save. Your entry is still here — try again.';
    }
  } finally {
    saveInFlight = false;
    // Only clear the slot this call itself set — saveInFlight already
    // forbids two saves running at once, but belt-and-braces: a stale clear
    // from the wrong call must never erase a newer save's pendingSave.
    if (pendingSave === writePromise) pendingSave = null;
    const saveButton = document.getElementById('edit-save');
    if (saveButton !== null) saveButton.disabled = false;
  }
}

// An identity this device can use now: refreshed if it has one, created
// anonymously if it does not. The refresh token lives in the encrypted
// document, so it is as protected as her history.
//
// Returns null if the vault locked while the network call was in flight —
// openDoc going null is how a caller resumed mid-await learns the session
// it started with no longer exists, so it must stop rather than act on a
// document that has already left memory.
async function syncIdentity() {
  const state = shareState(openDoc);
  if (state.identity === null) {
    const created = await signInAnonymously({ apiKey: FIREBASE.apiKey, fetchImpl: fetch });
    if (openDoc === null) return null;
    await persistShareDoc(
      doc => withIdentity(doc, { uid: created.uid, refreshToken: created.refreshToken }),
    );
    if (openDoc === null) return null;
    return { uid: created.uid, idToken: created.idToken };
  }
  const refreshed = await refreshIdToken({
    apiKey: FIREBASE.apiKey, refreshToken: state.identity.refreshToken, fetchImpl: fetch,
  });
  if (openDoc === null) return null;
  return { uid: refreshed.uid, idToken: refreshed.idToken };
}

// Shared by every path that only mutates the sharing section: write to the
// encrypted vault first, and only adopt the result into memory once that
// write has actually landed — the same guarantee saveDay gives the day
// editor, and for the same reason: a failed write must leave her looking at
// what is actually stored, not at a document memory adopted optimistically.
//
// The epoch check is what stops a second failure mode: a lock arriving
// while this write is still in flight already sets openDoc to null, and
// this function resuming afterwards must not revive it — the next unlock
// reads the vault fresh.
//
// The third vault-write path, and the one that used to race the other two.
// It takes a mutator rather than a document because its callers computed
// theirs from openDoc BEFORE awaiting, so a write that landed in between
// was reverted when this one adopted its stale copy. Waiting for any
// in-flight write and then applying the change to whatever openDoc has
// become makes that impossible, and publishing pendingSave lets a
// concurrent paint() wait rather than read the pre-write document.
async function persistShareDoc(mutate) {
  // Deliberately ignores the rejection: a failed earlier write is the
  // earlier caller's to report, and this one still needs the ordering.
  await pendingSave?.catch(() => {});
  if (openDoc === null) return;
  const next = mutate(openDoc);
  const epoch = sessionEpoch;
  const writePromise = vault.save(serializeDocument(next));
  pendingSave = writePromise;
  try {
    await writePromise;
  } finally {
    if (pendingSave === writePromise) pendingSave = null;
  }
  if (sessionEpoch !== epoch) return;
  openDoc = next;
}

// Review Focus 3: every outcome is recorded, so the card tells her whether
// he actually has this. Every `if (openDoc === null) return;` below guards
// the same race: a lock (idle timer, visibility change, the Lock button)
// can run to completion during any of this function's awaits, nulling
// openDoc out from under it — the next line must not read `.sharing` off
// null, or build a `with*` call from a document that no longer exists.
async function pushShare() {
  if (openDoc === null) return;
  const state = shareState(openDoc);
  if (state.key === null) return;
  try {
    const identity = await syncIdentity();
    if (openDoc === null || identity === null) return;
    const { uid, idToken } = identity;
    const payload = await buildPayload(openDoc, {
      key: state.key, scope: state.scope, updatedAt: localToday(),
    });
    if (openDoc === null) return;
    await putVault({
      projectId: FIREBASE.projectId, idToken, ownerUid: uid, payload, fetchImpl: fetch,
    });
    if (openDoc === null) return;
    // scope travels with the result so describePush can tell a push that
    // landed under an older scope from one that matches what she has now
    // chosen (Critical 3).
    await persistShareDoc(
      doc => withPushResult(doc, { at: localToday(), status: 'ok', scope: state.scope }),
    );
  } catch (error) {
    if (openDoc === null) return;
    const status = error && error.kind ? error.kind : 'server';
    await persistShareDoc(
      doc => withPushResult(doc, { at: localToday(), status, scope: state.scope }),
    );
  }
  if (openDoc === null) return;
  await drawShare();
}

// Coalesced: she may save several days in a row, and he needs the last
// state, not each intermediate one. Async now (Critical 3): the card has to
// read "not yet sent" the instant a save schedules a push, not only once the
// debounce fires minutes — or, if she locks first, forever — later.
async function schedulePush() {
  if (openDoc === null) return;
  const state = shareState(openDoc);
  if (state.key === null) return;
  if (pushTimer !== null) clearTimeout(pushTimer);
  await persistShareDoc(
    doc => withPushResult(doc, { at: localToday(), status: 'pending', scope: state.scope }),
  );
  if (openDoc === null) return;
  await drawShare();
  if (openDoc === null) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushShare().catch(() => {}); }, PUSH_DEBOUNCE_MS);
}

// Every share-card handler writes its own failure here, never silently —
// a share action that appears to do nothing is the one that erodes trust.
// `context` lets the "denied" case name what was actually refused, rather
// than always talking about a viewer's sync id even when the action was a
// re-key or a stop.
function shareErrorMessage(error, context = 'default') {
  const kind = error && error.kind;
  if (kind === 'offline') return 'No connection — try again once you are back online.';
  if (kind === 'denied') {
    if (context === 'add') return 'That was refused. Check his sync id and that he is still granted.';
    if (context === 'revoke') return 'That removal was refused by the server. Try again.';
    return 'That was refused by the server.';
  }
  if (kind === 'unauthenticated') return 'This device needs to pair again. Try again in a moment.';
  return 'Something went wrong. Please try again.';
}

async function startSharing() {
  if (openDoc === null) return;
  const scopeField = document.getElementById('share-scope');
  const scope = scopeField === null ? 'dates' : scopeField.value;
  try {
    await persistShareDoc(doc => withSharing(doc, { key: generateSyncKey(), scope }));
    // Redrawn right here, before the network step below: the document
    // already says sharing is on, so the card must too, even if the sign-in
    // that follows fails or the vault locks mid-flight. Without this a
    // failed sign-in left the card still showing "Start sharing" over a
    // document that already held a fresh key — a second press would mint
    // and silently discard another one, one he may already have typed in.
    await drawShare();
    if (openDoc === null) return;
    const identity = await syncIdentity();
    if (openDoc === null || identity === null) return;
    await drawShare();
    schedulePush().catch(() => {});
  } catch (error) {
    if (openDoc === null) return;
    await drawShare();
    say('share-error', shareErrorMessage(error, 'start'));
  }
}

async function changeShareScope() {
  if (openDoc === null) return;
  try {
    // Read here, not inside the mutator: the mutator runs after an await, and
    // the value she chose is the one at the moment she chose it.
    const scope = el('share-scope').value;
    await persistShareDoc(doc => withScope(doc, scope));
    if (openDoc === null) return;
    await drawShare();
    // §7.6: the scope change re-encrypts the whole payload, so he needs it
    // pushed again, not just the next ordinary save.
    schedulePush().catch(() => {});
  } catch (error) {
    if (openDoc === null) return;
    await drawShare();
    say('share-error', shareErrorMessage(error, 'scope'));
  }
}

async function copyShareKey() {
  if (openDoc === null) return;
  const state = shareState(openDoc);
  if (state.key === null) return;
  try {
    await navigator.clipboard.writeText(state.key);
  } catch {
    say('share-error', 'Could not copy the key. Select and copy it manually.');
  }
}

async function addShareViewer() {
  if (openDoc === null) return;
  const viewerUid = el('share-viewer-uid').value.trim();
  const label = el('share-viewer-label').value.trim();
  if (viewerUid === '') {
    say('share-error', 'Enter his sync id first.');
    return;
  }
  try {
    const identity = await syncIdentity();
    if (openDoc === null || identity === null) return;
    const { uid: ownerUid, idToken } = identity;
    const grantedAt = localToday();
    // Critical 2: his label never travels — it is uploaded nowhere, only
    // kept locally by withViewer, just below.
    await grantViewer({
      projectId: FIREBASE.projectId, idToken, ownerUid, viewerUid, grantedAt, fetchImpl: fetch,
    });
    if (openDoc === null) return;
    await persistShareDoc(doc => withViewer(doc, { uid: viewerUid, label, grantedAt }));
    if (openDoc === null) return;
    clear('share-viewer-uid');
    clear('share-viewer-label');
    await drawShare();
  } catch (error) {
    if (openDoc === null) return;
    await drawShare();
    say('share-error', shareErrorMessage(error, 'add'));
  }
}

async function removeShareViewer(viewerUid) {
  if (openDoc === null) return;
  try {
    const identity = await syncIdentity();
    if (openDoc === null || identity === null) return;
    const { uid: ownerUid, idToken } = identity;
    await revokeViewer({ projectId: FIREBASE.projectId, idToken, ownerUid, viewerUid, fetchImpl: fetch });
    if (openDoc === null) return;
    await persistShareDoc(doc => withoutViewer(doc, viewerUid));
    if (openDoc === null) return;
    await drawShare();
  } catch (error) {
    if (openDoc === null) return;
    await drawShare();
    say('share-error', shareErrorMessage(error, 'revoke'));
  }
}

// Important 9: a fresh key strands him silently — his refresh keeps failing
// against a vault that still holds the old one, with no way from his screen
// alone to tell "revoked" apart from "re-keyed". Naming it here, before it
// happens, is the only warning he gets.
async function rekeyShare() {
  if (openDoc === null) return;
  const ok = window.confirm(
    'His current key stops working the moment this is pushed. He will need '
    + 'to be re-paired in person, the same way as the first time — read him '
    + 'the new key and have him enter it on his phone. Generate a new key?',
  );
  if (!ok) return;
  try {
    const scope = shareState(openDoc).scope;
    await persistShareDoc(doc => withSharing(doc, { key: generateSyncKey(), scope }));
    if (openDoc === null) return;
    await drawShare();
    schedulePush().catch(() => {});
  } catch (error) {
    if (openDoc === null) return;
    await drawShare();
    say('share-error', shareErrorMessage(error, 'rekey'));
  }
}

// §7.5: the honest limit, named here rather than discovered later — stopping
// sharing stops the future, not whatever his app has already cached.
//
// silent is for the erase path, which has already asked her a strictly
// stronger question (type ERASE) and is about to destroy the share card this
// function writes to. It suppresses this function's own prompt and messages
// — and, in the catch below, rethrows instead of swallowing, because a
// caller that is about to erase the vault must not be told a failed teardown
// succeeded.
async function stopSharing({ silent = false } = {}) {
  if (openDoc === null) return;
  if (!silent) {
    const ok = window.confirm(
      'This stops sending new entries. It does not reach what his app has '
      + 'already cached — he keeps the key for that, and it stays on his phone. '
      + 'Stop sharing?',
    );
    if (!ok) return;
  }
  try {
    const state = shareState(openDoc);
    if (state.identity !== null) {
      const identity = await syncIdentity();
      if (openDoc === null || identity === null) return;
      const { uid: ownerUid, idToken } = identity;
      for (const viewer of state.viewers) {
        await revokeViewer({
          projectId: FIREBASE.projectId, idToken, ownerUid, viewerUid: viewer.uid, fetchImpl: fetch,
        });
        if (openDoc === null) return;
      }
      // Important 5: without this, the ciphertext document lives on
      // forever — the key is about to be dropped from the document below,
      // which is exactly what would make that document unauthenticatable
      // AND undeletable: she could never again mint a token for the uid
      // that wrote it. Delete it while she still can, before the key goes.
      await deleteVault({ projectId: FIREBASE.projectId, idToken, ownerUid, fetchImpl: fetch });
      if (openDoc === null) return;
    }
    if (openDoc === null) return;
    if (pushTimer !== null) { clearTimeout(pushTimer); pushTimer = null; }
    await persistShareDoc(doc => withoutSharing(doc));
    await drawShare();
  } catch (error) {
    if (silent) throw error;
    if (openDoc === null) return;
    await drawShare();
    // A partial failure here must say she is still exposed, not just that
    // "something went wrong": the key is deliberately kept (see the loop
    // above), and she needs to know a retry is required, not just reread.
    say('share-error', 'Sharing is still on — not everyone could be removed. Try Stop sharing again.');
  }
}

// His side. No editor, no save, no write path at all — the server rules
// enforce that independently (Task 7), but this file carries none of the
// machinery that would need enforcing against in the first place.

// A mistyped key fails here, loudly, through the tested importSyncKey, not
// later as an opaque decrypt failure with no obvious cause. His vault is the
// same vault code hers uses — this is just what it happens to hold.
async function createViewer() {
  if (el('viewer-create').disabled) return;
  el('viewer-create').disabled = true;
  try {
    const ownerUid = el('viewer-owner-uid').value.trim();
    const keyText = el('viewer-key').value.trim();
    const passphrase = el('setup-passphrase').value;
    if (ownerUid === '') return say('setup-error', 'Enter her sync id first.');
    if (passphrase.length < 8) return say('setup-error', 'Use at least 8 characters.');
    if (passphrase !== el('setup-confirm').value) return say('setup-error', 'The two passphrases differ.');

    say('setup-error', '');
    await importSyncKey(keyText);
    say('viewer-fingerprint', `Fingerprint: ${await fingerprint(keyText)} — check it matches her screen.`);

    const identity = await signInAnonymously({ apiKey: FIREBASE.apiKey, fetchImpl: fetch });
    await vault.setup(passphrase, viewerRecord({
      ownerUid,
      key: keyText,
      identity: { uid: identity.uid, refreshToken: identity.refreshToken },
    }));
    hasVault = true;
    clear('setup-passphrase');
    clear('setup-confirm');
    // The key is sealed into his vault now; a plaintext <input> holding it
    // for the rest of the session would be the one secret requirement 4
    // says should live only there, readable in devtools long after this
    // screen is gone.
    clear('viewer-owner-uid');
    clear('viewer-key');
    // Important 6: create() offers this on the owner's device; it must be
    // offered here too, or his vault is passphrase-only forever (spec §7.4
    // step 5, Review Focus 5).
    await offerFaceId();
    // His uid, for him to read back to her so she can grant him access —
    // this is the only direction his identity travels on its own.
    say('setup-progress', `Your sync id (read it to her so she can grant access): ${identity.uid}`);
    await paintViewer();
  } catch {
    say('setup-progress', '');
    say('setup-error', 'Something went wrong. Please try again.');
    // A failed pairing must not leave the key sitting in plaintext for as
    // long as a successful one would have cleared it.
    clear('viewer-owner-uid');
    clear('viewer-key');
  } finally {
    el('viewer-create').disabled = false;
  }
}

// Important 9's other half: rekeyShare strands him the moment she presses
// "New key", with no recovery but setting the vault up a second time — and
// doing that would also mean choosing a new passphrase, losing nothing of
// hers but costing him his own. This rewrites just the key inside his
// existing vault record, in place, under his existing passphrase.
async function rekeyViewer() {
  if (el('viewer-rekey').disabled) return;
  el('viewer-rekey').disabled = true;
  try {
    const keyText = el('viewer-rekey-input').value.trim();
    await importSyncKey(keyText); // throws loudly on a mistyped key
    say('viewer-rekey-fingerprint', `Fingerprint: ${await fingerprint(keyText)} — check it matches her screen.`);
    const current = parseViewerRecord(vault.read());
    await vault.save(viewerRecord({ ...current, key: keyText }));
    clear('viewer-rekey-input');
    say('viewer-error', '');
    await paintViewer();
  } catch {
    say('viewer-rekey-fingerprint', '');
    say('viewer-error', 'That is not a valid key. Check it against her screen and try again.');
  } finally {
    el('viewer-rekey').disabled = false;
  }
}

// Fetches, decrypts and caches her data in memory only — it never reaches
// his vault. A failure is recorded in #viewer-error, never flattened into a
// cleared cache: a decrypt failure or a revoked grant must say so, not leave
// an old render on screen looking current, and must not silently empty the
// calendar either (which would read as "she has logged nothing").
async function refreshViewer() {
  if (viewerRecordData === null) return;
  try {
    const refreshed = await refreshIdToken({
      apiKey: FIREBASE.apiKey, refreshToken: viewerRecordData.identity.refreshToken, fetchImpl: fetch,
    });
    if (viewerRecordData === null) return;
    const result = await fetchShared({
      record: viewerRecordData, idToken: refreshed.idToken, projectId: FIREBASE.projectId, fetchImpl: fetch,
    });
    if (viewerRecordData === null) return;
    if (result === null) {
      say('viewer-error', 'Nothing has been shared with you yet.');
      return;
    }
    viewerShared = result;
    say('viewer-error', '');
  } catch (error) {
    if (viewerRecordData === null) return;
    const kind = error && error.kind;
    // Only a connectivity problem leaves the cache in place — and only
    // because it says, in words, that what is on screen is the last copy
    // and not a current one. Every other failure (a revoked grant, a key
    // that can no longer open what she sent, a version or server error)
    // clears it: showing yesterday's calendar as though it answers today's
    // question is exactly the lie this screen exists to avoid telling.
    if (kind === 'offline') {
      say('viewer-error', viewerShared === null
        ? 'No connection, and nothing is cached yet.'
        : `No connection — showing the last copy from ${viewerShared.updatedAt}.`);
      return;
    }
    viewerShared = null;
    if (kind === 'denied') {
      say('viewer-error', 'She has stopped sharing, or the grant was removed. '
        + 'If you paired again since she granted you, your sync id changed — '
        + 'read her your sync id above so she can grant it again.');
    } else if (error && error.name === 'OperationError') {
      // AES-GCM's own failure name for a wrong key or a tampered payload —
      // never flattened into an empty calendar, which would read as "she
      // has logged nothing".
      say('viewer-error', 'That could not be read with this key. Check it against her screen.');
    } else {
      say('viewer-error', 'Something went wrong. Please try again.');
    }
  }
}

// Renders her data with the same tested renderers the owner's screen uses —
// no editor, no save, no write path. Read-only is not a hidden button: this
// function must never reference renderEditor, applyDayEdit or openEditor.
//
// The whole pane is one render target (#viewer), rebuilt in a single
// assignment every time this runs — on open, and on every explicit refresh.
// That is deliberate: returnToLock clears #viewer wholesale (so his cache of
// her data cannot survive a lock), which means nothing inside it can be a
// persistent, individually-addressed node — only #viewer itself, and the
// static controls outside it, survive from one paint to the next.
// His calendar, in its own element so the month head can sit above it. Drawn
// from viewerMonth rather than today, which is the whole point: he has to be
// able to look back at the month her period was actually in.
function drawViewerCalendar() {
  if (viewerShared === null || viewerMonth === null) {
    el('viewer-calendar').innerHTML = '';
    say('viewer-label', '');
    return;
  }
  const grid = monthGrid(viewerShared.doc, {
    month: viewerMonth,
    todayISO: localToday(),
    adaptedDate: viewerSummary === null ? null : viewerSummary.adapted.date,
    baselineDates: [],
  });
  el('viewer-calendar').innerHTML = renderCalendar(grid);
  say('viewer-label', monthLabel(viewerMonth));
  markViewerSelected();
}

// Clamped to the months her shared copy actually covers, the same rule her
// own picker follows — paging into 1990 would just show him empty grids.
function stepViewerMonth(delta) {
  if (viewerShared === null || viewerMonth === null) return;
  viewerMonth = clampMonth(
    shiftMonth(viewerMonth, delta),
    monthRange(viewerShared.doc, localToday()),
  );
  drawViewerCalendar();
}

function viewerToday() {
  if (viewerShared === null) return;
  viewerMonth = monthOf(localToday());
  drawViewerCalendar();
}

// His day panel. Built from viewerShared — the decrypted copy of what she
// actually sent — never from openDoc, which on his device is always null
// anyway: reaching for it would be the bug that quietly makes this pane read
// the wrong document if the two modes ever share a screen.
//
// Read-only by construction: renderDay is the same renderer her screen uses,
// and nothing here imports or calls the editor.
function drawViewerDay() {
  if (viewerShared === null || viewerDate === null) {
    el('viewer-day').innerHTML = '';
    return;
  }
  // No ghost on his screen: the viewer calendar is drawn with baselineDates
  // empty, so a day panel claiming a counterfactual would contradict the grid
  // beside it.
  el('viewer-day').innerHTML = renderDay(dayDetail(viewerShared.doc, viewerDate, {
    todayISO: localToday(),
    adaptedDate: viewerSummary === null ? null : viewerSummary.adapted.date,
    baselineDates: [],
  }), { canEdit: false });
  markViewerSelected();
}

function markViewerSelected() {
  if (viewerDate === null) return;
  for (const cell of el('viewer-calendar').querySelectorAll('.cal-selected')) {
    cell.classList.remove('cal-selected');
  }
  const cell = el('viewer-calendar').querySelector(`[data-date="${viewerDate}"]`);
  if (cell !== null) cell.classList.add('cal-selected');
}

function selectViewerDay(date) {
  if (viewerShared === null) return;
  viewerDate = date;
  drawViewerDay();
}

async function paintViewer() {
  // Two fast taps on a flaky connection would otherwise interleave, letting
  // a slower response's clear-and-message land after a faster one's
  // success — the same guard every other async button here already has.
  if (el('viewer-refresh').disabled) return;
  el('viewer-refresh').disabled = true;
  try {
    viewerRecordData = parseViewerRecord(vault.read());
    await refreshViewer();
    if (viewerRecordData === null) return; // locked mid-refresh
    if (viewerShared === null) {
      el('viewer').innerHTML = renderViewerHeader({ scope: null, updatedAt: null, label: '', uid: viewerRecordData.identity.uid });
    } else {
      const { doc, scope, updatedAt } = viewerShared;
      const summary = buildSummary(doc, localToday());
      viewerSummary = summary;
      // Only on first paint, or after a lock: a refresh must not yank him
      // back to this month when he was reading an earlier one. Re-clamped
      // every time though, not just when stepping: a month that was in range
      // can fall out of it when she narrows the scope (the `dates` scope
      // carries no days at all), and from outside the range both arrows
      // clamp to the same end, so Previous moved him forward by years.
      if (viewerMonth === null) viewerMonth = monthOf(localToday());
      viewerMonth = clampMonth(viewerMonth, monthRange(doc, localToday()));
      el('viewer').innerHTML = renderViewerHeader({ scope, updatedAt, label: 'her', uid: viewerRecordData.identity.uid })
        + renderSummary(summary);
    }
    // Outside the branch, beside drawViewerDay and for the same reason: both
    // self-clear, and his calendar is no longer inside #viewer's innerHTML,
    // so the "her copy is gone" branch would otherwise leave her month grid
    // on screen under a header saying nothing was received.
    drawViewerCalendar();
    drawViewerDay();
    screen('viewer-screen');
  } finally {
    el('viewer-refresh').disabled = false;
  }
}

// The picker is built from the document, so its range covers exactly the
// months she has anything in — paging to 2015 one arrow at a time is not a
// navigation method.
function closePicker() {
  el('cal-picker').innerHTML = '';
  hide('cal-picker');
  el('cal-label').setAttribute('aria-expanded', 'false');
}

function togglePicker() {
  if (openDoc === null || viewMonth === null) return;
  if (!el('cal-picker').hidden) {
    closePicker();
    return;
  }
  el('cal-picker').innerHTML = renderMonthPicker({
    month: viewMonth,
    range: monthRange(openDoc, localToday()),
  });
  show('cal-picker');
  el('cal-label').setAttribute('aria-expanded', 'true');
}

function jumpToPickedMonth() {
  if (openDoc === null) return;
  const picked = `${el('cal-year').value}-${el('cal-month').value}`;
  // A month and a year chosen separately can land outside the range.
  viewMonth = clampMonth(picked, monthRange(openDoc, localToday()));
  drawCalendar();
  closePicker();
}

// Spec §9: a Blob, never a network call. The link is created, clicked and
// revoked in one go, so nothing is left holding the data.
// Her only protection against a lost phone is a backup she actually took,
// so the date of the last one is on screen rather than in her memory.
async function showLastBackup() {
  const last = await readLastBackup(backend);
  say('last-backup', last === null
    ? 'No backup yet — download one and keep it somewhere safe.'
    : `Last backup: ${last}`);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// The encrypted backup needs no warning: it is unreadable without her
// passphrase, which is why it says so inside the file.
async function exportBackup() {
  if (openDoc === null) return;
  try {
    const meta = await readMeta(backend);
    const vault = await backend.get(VAULT_KEY);
    download(
      FILENAMES.backup,
      backupBundle({ meta, vault, exportedAt: localToday() }),
      'application/json',
    );
    await markBackup(backend, localToday());
    await showLastBackup();
    // The warning above the button is now out of date by definition: she
    // just did the thing it was asking for. Re-rendered here rather than
    // only on the next entry to Settings, so the screen does not contradict
    // the action she just took.
    el('backup-warning').innerHTML = renderBackupWarning(await readLastBackup(backend), localToday());
  } catch {
    say('export-error', 'That download did not start. Please try again.');
  }
}

// Spec §9: plaintext leaves the encrypted store only behind an explicit
// warning that names what is about to happen.
function exportPlaintext(kind) {
  if (openDoc === null) return;
  const ok = window.confirm(
    'This file is NOT encrypted. Anything that reads it — any app, anyone with '
    + 'the phone or the folder you save it to — can read your whole history. '
    + 'Save it somewhere you trust. Continue?',
  );
  if (!ok) return;

  try {
    if (kind === 'data') {
      // Review Focus 1 again, at an export boundary it missed the first
      // time: the plaintext data export must carry none of `sharing` — not
      // the sync key, and not the refresh token that mints her owner id
      // tokens, which is strictly worse than the key alone. A restore of
      // this file then arrives with sharing off, which is the right default.
      download(FILENAMES.data, documentJson(withoutSharing(openDoc)), 'application/json');
    } else if (kind === 'days') {
      download(FILENAMES.days, daysCsv(openDoc), 'text/csv');
    } else {
      download(FILENAMES.cycles, cyclesCsv(buildCycles(openDoc)), 'text/csv');
    }
  } catch {
    say('export-error', 'That download did not start. Please try again.');
  }
}

// The vault re-wraps without checking the old passphrase, because it is
// already unlocked. The screen checks anyway: an unlocked phone on a table
// must not let someone set a new passphrase and lock her out of her history.
async function changePassphrase() {
  if (openDoc === null) return;
  // Both security buttons are read-modify-write on meta. Two overlapping
  // runs could lose the biometric wrapping, or leave the OLD passphrase
  // working after this screen said "Changed." — the same guard every other
  // async button here already has.
  if (el('passphrase-change').disabled) return;
  el('passphrase-change').disabled = true;
  try {
    const current = el('passphrase-current').value;
    const next = el('passphrase-next').value;
    const confirm = el('passphrase-confirm').value;

    say('passphrase-error', '');
    say('passphrase-notice', '');
    if (next.length < 8) return say('passphrase-error', 'Use at least 8 characters.');
    if (next !== confirm) return say('passphrase-error', 'The two new passphrases differ.');

    try {
      if (!await vault.verifyPassphrase(current)) {
        return say('passphrase-error', 'That is not your current passphrase.');
      }
      await vault.changePassphrase(next);
    } catch {
      // Includes the vault locking underneath this screen, which throws.
      return say('passphrase-error', 'That could not be changed. Unlock and try again.');
    }

    clear('passphrase-current');
    clear('passphrase-next');
    clear('passphrase-confirm');
    // Said explicitly because the data key did not change: her old backups
    // still open with the OLD passphrase. The Face ID half is only said when
    // there is a biometric wrapping to say it about — promising a fallback
    // she never enrolled, on the screen where she has just replaced the only
    // key to her history, is the worst place to be wrong.
    const credentialId = await readCredentialId(backend).catch(() => null);
    if (openDoc === null) return;
    if (credentialId !== null) {
      return say('passphrase-notice', 'Changed. Face ID still works. Backup files you '
        + 'already downloaded still need the old passphrase.');
    }
    say('passphrase-notice', 'Changed. Backup files you already downloaded still need '
      + 'the old passphrase.');
  } finally {
    el('passphrase-change').disabled = false;
  }
}

// One enrolment path, shared with create() and createViewer(). offerFaceId
// still swallows every failure, but it now reports which one happened, so
// this screen can say something true instead of one unfalsifiable sentence
// that also appeared when the device cannot do Face ID at all.
async function enrollFaceIdNow() {
  if (openDoc === null) return;
  // See changePassphrase: both buttons write meta, and neither may run a
  // second time over itself.
  if (el('faceid-enroll').disabled) return;
  el('faceid-enroll').disabled = true;
  try {
    say('faceid-notice', '');
    const result = await offerFaceId();
    if (openDoc === null) return;
    if (result === 'enrolled') {
      return say('faceid-notice', 'Face ID is set up. You can use it to unlock on this phone.');
    }
    if (result === 'unsupported') {
      return say('faceid-notice', 'This phone cannot unlock with Face ID. Your passphrase '
        + 'stays the way in.');
    }
    if (result === 'declined') {
      return say('faceid-notice', 'Face ID was not set up. Nothing changed.');
    }
    say('faceid-notice', 'Face ID could not be set up. Nothing changed — try again.');
  } finally {
    el('faceid-enroll').disabled = false;
  }
}

// Local erase is not enough: the uploaded ciphertext and the viewer grants
// live under a key inside the vault about to be destroyed, so sharing has to
// be torn down first or they are orphaned on Google's servers forever.
//
// The order below is the whole point, and the recheck after the teardown is
// what makes the order mean something: stopSharing can return normally with
// sharing still on (a lock arriving mid-teardown stops it part-way), and
// erasing then would orphan exactly what the ordering exists to prevent.
async function eraseEverything() {
  if (openDoc === null) return;
  say('erase-error', '');
  const typed = window.prompt(
    'This erases your whole log from this phone and cannot be undone. '
    + 'A backup file is the only way back. Type ERASE to confirm.',
  );
  if (!eraseConfirmed(typed)) {
    // A near-miss used to be indistinguishable from a cancel: both did
    // nothing and said nothing. Cancel stays silent — she knows she
    // cancelled — but a typed answer that was not the word gets an answer.
    if (typed !== null) {
      say('erase-error', 'Nothing was erased — type ERASE exactly to confirm.');
    }
    return;
  }
  // A push armed by her last save fires five seconds later, and its putVault
  // would land after deleteVault — recreating the uploaded ciphertext under
  // a uid whose refresh token the erase below is about to destroy, orphaning
  // it on Google's servers forever. returnToLock clears the timer, but only
  // two awaits after the teardown. The same shape locally: an in-flight
  // vault.save can rewrite the blob eraseAll just deleted.
  if (pushTimer !== null) { clearTimeout(pushTimer); pushTimer = null; }
  await pendingSave?.catch(() => {});

  try {
    if (shareState(openDoc).key !== null) {
      await stopSharing({ silent: true });
      // Not a belt-and-braces check: a lock during the revoke loop makes
      // stopSharing return with the key still in the document, and the
      // vault is the only thing that can still authenticate as the uid
      // that owns the uploaded copy.
      if (openDoc === null || shareState(openDoc).key !== null) {
        return say('erase-error', 'Sharing could not be stopped, so nothing was '
          + 'erased. Unlock, stop sharing, then try again.');
      }
    }
    await vault.erase();
  } catch {
    // The two deletes are not atomic, and the first one removes the wrapped
    // key. If it landed, her log is already unreadable and saying otherwise
    // is the one thing this screen must not do.
    const state = await vault.status().catch(() => 'locked');
    if (state === 'empty') {
      hasVault = false;
      return say('erase-error', 'The erase did not finish cleanly, but your log '
        + 'can no longer be opened on this phone. Restore from a backup file if '
        + 'you did not mean to do this.');
    }
    return say('erase-error', 'That did not finish. Nothing was erased — try again.');
  }
  hasVault = false;
  returnToLock();
  screen('setup');
}

function goToToday() {
  if (openDoc === null) return;
  // The same rule the calendar cells follow: navigation must not destroy a
  // half-typed entry.
  if (editing !== null) {
    const errorField = document.getElementById('edit-error');
    if (errorField !== null) errorField.textContent = 'Save or cancel this day first.';
    return;
  }
  viewMonth = monthOf(localToday());
  closePicker();
  drawCalendar();
  // "Today's date", not just its month: the panel lands on today too.
  selectDay(localToday());
}

function stepMonth(delta) {
  if (viewMonth === null) return;
  viewMonth = shiftMonth(viewMonth, delta);
  drawCalendar();
}

function clear(id) {
  el(id).value = '';
}

async function readFile(input, asJson) {
  const file = input.files && input.files[0];
  if (!file) return null;
  const text = await file.text();
  return asJson ? JSON.parse(text) : text;
}

// A second tap mid-derive would run two concurrent setups, each minting its
// own data key; whichever writeMeta lands second wins, and if that is not
// the run whose key sealed the stored blob the vault is permanently
// unopenable. The disabled flag, re-enabled only in `finally`, makes that
// race impossible to trigger from the UI.
let awaitingEmptyConfirm = false;

async function create() {
  if (el('create').disabled) return;
  el('create').disabled = true;
  try {
    const passphrase = el('setup-passphrase').value;
    if (passphrase.length < 8) return say('setup-error', 'Use at least 8 characters.');
    if (passphrase !== el('setup-confirm').value) return say('setup-error', 'The two passphrases differ.');

    say('setup-error', '');
    say('setup-progress', 'Reading your files…');

    // A CycleLog file she saved earlier takes precedence: it is a restore,
    // not an import, and an encrypted backup carries its own key material.
    const restoreText = await readFile(el('restore-file'), false);
    const restoreKind = restoreText === null ? 'none' : classifyRestoreFile(restoreText);
    if (restoreText !== null) {
      if (restoreKind === 'unknown') {
        return say('setup-error',
          'That file is not a CycleLog backup or data export. For a Clue '
          + 'export or your old text log, use the pickers above.');
      }
      if (restoreKind === 'backup') {
        try {
          await restoreBackup(backend, parseBackupBundle(restoreText));
        } catch {
          say('setup-progress', '');
          return say('setup-error', 'That backup could not be read.');
        }
        // The backup brought its own wrapped key, so the ordinary unlock path
        // opens it — with the passphrase it was made with, which is what she
        // typed on this form.
        const opened = await vault.unlock(passphrase);
        if (!opened.ok) {
          say('setup-progress', '');
          return say('setup-error',
            'The backup was restored, but that passphrase did not open it. '
            + 'Try the passphrase you used when you made the backup.');
        }
        hasVault = true;
        clear('setup-passphrase');
        clear('setup-confirm');
        say('setup-progress', '');
        await paint('Restored from your backup.');
        return undefined;
      }
    }

    let vaultDoc;
    let importNote = '';
    try {
      const clueJson = await readFile(el('clue-file'), true);
      const legacyText = await readFile(el('legacy-file'), false);
      if (restoreKind === 'document') {
        // A plaintext data export is the document itself, carrying no key
        // material: seal it under the passphrase she just chose.
        vaultDoc = parseDocument(restoreText);
        importNote = describeImport({ doc: vaultDoc, warnings: [] });
      } else if (clueJson || legacyText) {
        const imported = documentFromSources({ clueJson, legacyText });
        vaultDoc = imported.doc;
        importNote = describeImport(imported);
      } else if (!awaitingEmptyConfirm) {
        // No file picked could be a mis-tap, not a decision — an empty vault
        // is not something she can fix from inside the app (Finding 4), so
        // it needs a second, explicit press before it is created.
        awaitingEmptyConfirm = true;
        say('setup-progress', 'No files chosen. Press Create again to start with an empty log.');
        return;
      } else {
        vaultDoc = emptyDocument();
      }
    } catch {
      say('setup-progress', '');
      // The file is not blamed by name: the message says what to do next.
      return say('setup-error', 'That file could not be read. Check you picked the right one.');
    }

    awaitingEmptyConfirm = false;
    say('setup-progress', 'Encrypting…');
    await vault.setup(passphrase, serializeDocument(vaultDoc));
    hasVault = true;
    clear('setup-passphrase');
    clear('setup-confirm');
    say('setup-progress', '');
    await offerFaceId();
    await paint(importNote);
  } catch {
    // Backstop for anything above that was not already given its own
    // message: a storage failure from vault.setup, a quota error, etc.
    // Silence here would be a click that visibly does nothing.
    say('setup-progress', '');
    say('setup-error', 'Something went wrong. Please try again.');
  } finally {
    el('create').disabled = false;
  }
}

async function unlock() {
  if (el('unlock').disabled) return;
  el('unlock').disabled = true;
  try {
    const result = await vault.unlock(el('passphrase').value);
    if (!result.ok) {
      // src/unlock.js keeps 'empty' and 'wrong-passphrase' apart on purpose;
      // collapsing them here would tell her a correct passphrase was wrong.
      if (result.reason === 'empty') {
        say('lock-error', '');
        screen('setup');
        return say('setup-progress', 'No vault on this device yet — set one up.');
      }
      return say('lock-error', 'That passphrase did not open the vault.');
    }
    say('lock-error', '');
    await paint();
  } catch {
    // Covers a correct passphrase against a corrupted or wrong-version
    // document: parseDocument inside paint() can throw, and without this the
    // click clears the error line and then does nothing at all. paint() is
    // itself async now (it awaits any pendingSave first), so this await is
    // also what keeps that throw inside this try at all.
    say('lock-error', 'Something went wrong. Please try again.');
  } finally {
    clear('passphrase');
    el('unlock').disabled = false;
  }
}

async function faceIdUnlock() {
  try {
    const credentialId = await readCredentialId(backend);
    if (credentialId === null) return say('lock-error', 'Face ID is not set up on this device.');
    const ceremony = await biometricKey({ credentials: navigator.credentials, credentialId });
    if (!ceremony.ok) return say('lock-error', 'Face ID did not complete. Use your passphrase.');
    const result = await vault.unlockWithKey('biometric', ceremony.key);
    if (!result.ok) return say('lock-error', 'Face ID is no longer enrolled. Use your passphrase.');
    say('lock-error', '');
    await paint();
  } catch {
    say('lock-error', 'Something went wrong. Please try again.');
  }
}

// Enrolment is an optional enhancement layered on an already-created, already
// -written vault: by the time this runs, create() has nothing left to roll
// back. A throw from here (rememberCredentialId/enrollWrapping touch
// IndexedDB and can fail) must not be allowed to make create()'s outer catch
// report a working vault as a failed setup, so every failure here is caught
// and swallowed on the spot.
async function offerFaceId() {
  try {
    if (!biometricSupported()) return 'unsupported';
    const enrolled = await enrollBiometric({
      credentials: navigator.credentials,
      rpId: window.location.hostname,
      rpName: RP_NAME,
      userName: 'cyclelog',
    });
    // A device without PRF, or a declined prompt, leaves the passphrase as
    // the only way in — the designed fallback, not an error worth showing.
    if (!enrolled.ok) return 'declined';
    // The wrapping first, the credential id second. Both writes touch meta
    // and the pair has to agree, and the write that can realistically fail
    // is this one: enrollWrapping calls requireUnlocked(), so a lock during
    // the two-prompt ceremony throws here. Writing the id first stored a new
    // credential against the old wrapping and broke a Face ID that had been
    // working; this way the same throw leaves the old, working pair intact.
    await vault.enrollWrapping('biometric', enrolled.key);
    await rememberCredentialId(backend, enrolled.credentialId);
    // Enrolment just succeeded without a reload, so the lock screen (reached
    // later via lock-now, idle or page-hide) needs its Face ID button shown
    // now rather than only on the next cold start().
    show('faceid');
    return 'enrolled';
  } catch {
    // Still silent on purpose: Face ID is an enhancement, and failing here
    // must leave the vault setup it followed looking exactly as successful
    // as it actually was. The outcome is returned rather than shown, so
    // Settings can say something true without create() or createViewer()
    // changing behaviour at all — both ignore it.
    return 'failed';
  }
}

async function start() {
  // Without this the browser may treat the vault as cache and evict it. It is
  // a request, not a guarantee, and a refusal changes nothing else.
  requestPersistentStorage();
  try {
    const status = await vault.status();
    hasVault = status !== 'empty';
    if (!hasVault) return screen('setup');
    screen('lock');
    if (biometricSupported() && (await readCredentialId(backend)) !== null) show('faceid');
  } catch {
    // A blank page with no path forward is worse than the lock screen with a
    // message: the passphrase path still works even if status-checking did not.
    screen('lock');
    say('lock-error', 'Something went wrong. Please try again.');
  }
}

el('create').addEventListener('click', () => { create(); });
el('unlock').addEventListener('click', () => { unlock(); });
el('faceid').addEventListener('click', () => { faceIdUnlock(); });
// One delegated listener: the grid is rebuilt on every month step, so
// per-cell listeners would have to be re-attached each time.
el('calendar').addEventListener('click', event => {
  const cell = event.target.closest('[data-date]');
  if (cell === null) return;
  const date = cell.dataset.date;
  if (editing !== null) {
    // selectDay would replace #day-detail wholesale, wiping a half-typed
    // entry with no warning. Tapping the day already open is a no-op —
    // re-rendering the same editor would wipe it too — and tapping a
    // different day must not navigate away from it either: Save and
    // Cancel are both already on screen, so this costs one tap, not data.
    if (editing !== date) {
      const errorField = document.getElementById('edit-error');
      if (errorField !== null) errorField.textContent = 'Save or cancel this day first.';
    }
    return;
  }
  selectDay(date);
});
// The panel and the form are both re-rendered, so these are delegated from
// the container that survives rather than attached to elements that get
// replaced.
el('day-detail').addEventListener('click', event => {
  if (event.target.id === 'edit-day' && selectedDate !== null) openEditor(selectedDate);
  if (event.target.id === 'edit-save') saveDay();
  if (event.target.id === 'edit-cancel' && selectedDate !== null) {
    editing = null;
    selectDay(selectedDate);
  }
});
// "Save or cancel this day first." (or a failed-save message) must not sit
// there once she has resumed typing — it describes a tap or a save that
// already happened, not whatever she is doing now.
el('day-detail').addEventListener('input', () => {
  const errorField = document.getElementById('edit-error');
  if (errorField !== null) errorField.textContent = '';
});
el('cal-label').addEventListener('click', () => { togglePicker(); });
el('cal-picker').addEventListener('change', event => {
  if (event.target.id === 'cal-month' || event.target.id === 'cal-year') jumpToPickedMonth();
});
// One delegated listener for the share card, rebuilt on every draw.
el('share').addEventListener('click', event => {
  const { id } = event.target;
  if (id === 'share-start') startSharing();
  else if (id === 'share-copy') copyShareKey();
  else if (id === 'share-add') addShareViewer();
  else if (id === 'share-rekey') rekeyShare();
  else if (id === 'share-stop') stopSharing();
  else if (event.target.dataset.revoke) removeShareViewer(event.target.dataset.revoke);
});
el('share').addEventListener('change', event => {
  if (event.target.id === 'share-scope') changeShareScope();
});
el('viewer-create').addEventListener('click', () => { createViewer(); });
// Tap a day on his calendar. Delegated on #viewer because refresh replaces
// that pane's markup wholesale, so a listener bound to a cell would not
// survive the first refresh.
el('viewer-calendar').addEventListener('click', (event) => {
  const cell = event.target.closest('[data-date]');
  if (cell === null) return;
  selectViewerDay(cell.dataset.date);
});

el('viewer-prev').addEventListener('click', () => { stepViewerMonth(-1); });
el('viewer-next').addEventListener('click', () => { stepViewerMonth(1); });
el('viewer-today').addEventListener('click', () => { viewerToday(); });

el('viewer-refresh').addEventListener('click', () => { paintViewer(); });
el('viewer-rekey').addEventListener('click', () => { rekeyViewer(); });
el('viewer-lock').addEventListener('click', () => {
  vault.lock();
  returnToLock();
});
el('go-settings').addEventListener('click', () => {
  if (openDoc === null) return;
  // Same rule the calendar cells and Today already follow: navigation must
  // not destroy a half-typed entry. Settings can clear #day-detail, which
  // takes the form with it while `editing` stays set — after which every
  // date tap writes its refusal into an element that no longer exists.
  if (editing !== null) {
    const errorField = document.getElementById('edit-error');
    if (errorField !== null) errorField.textContent = 'Save or cancel this day first.';
    return;
  }
  screen('settings');
  drawSettings().catch(() => {});
});

el('settings-back').addEventListener('click', () => {
  if (openDoc === null) return;
  // The form is discarded on the way out rather than kept: a half-typed
  // episode surviving a trip to the calendar and back would be restored
  // without its error message or its index, which is how an edit becomes an
  // accidental add.
  el('episode-form-host').innerHTML = '';
  screen('app');
});

el('passphrase-change').addEventListener('click', () => { changePassphrase().catch(() => {}); });
el('faceid-enroll').addEventListener('click', () => { enrollFaceIdNow().catch(() => {}); });
el('erase-all').addEventListener('click', () => { eraseEverything().catch(() => {}); });
el('export-backup').addEventListener('click', () => { exportBackup(); });
el('export-data').addEventListener('click', () => { exportPlaintext('data'); });
el('export-days').addEventListener('click', () => { exportPlaintext('days'); });
el('export-cycles').addEventListener('click', () => { exportPlaintext('cycles'); });

el('switch-form-host').addEventListener('click', (event) => {
  if (event.target.id === 'switch-save') switchMethodNow().catch(() => {});
});

el('episode-form-host').addEventListener('click', (event) => {
  if (event.target.id === 'end-save') saveEndDate().catch(() => {});
  if (event.target.id === 'end-cancel') el('episode-form-host').innerHTML = '';
  if (event.target.id === 'episode-save') saveEpisode().catch(() => {});
  if (event.target.id === 'episode-cancel') {
    el('episode-form-host').innerHTML = renderEpisodeForm({ episode: null, index: null });
  }
});

el('episodes').addEventListener('click', (event) => {
  const edit = event.target.dataset.episodeEdit;
  const end = event.target.dataset.episodeEnd;
  const remove = event.target.dataset.episodeRemove;
  if (edit !== undefined) editEpisodeAt(Number(edit));
  if (end !== undefined) endEpisodeAt(Number(end));
  if (remove !== undefined) removeEpisodeAt(Number(remove)).catch(() => {});
});

el('settings-import').addEventListener('change', (event) => {
  importMore([...event.target.files]).catch(() => {});
  event.target.value = '';
});

el('cal-today').addEventListener('click', () => { goToToday(); });
el('cal-prev').addEventListener('click', () => { stepMonth(-1); });
el('cal-next').addEventListener('click', () => { stepMonth(1); });
el('lock-now').addEventListener('click', () => {
  vault.lock();
  returnToLock();
});
el('passphrase').addEventListener('keydown', event => {
  if (event.key === 'Enter') unlock();
});

// Re-lock immediately on hide, not just on idle timeout: iOS snapshots the
// page for the app switcher the instant it is hidden, so the summary must
// already be out of the DOM before that happens. The idle clock is still
// checked on every return, for the case where the tab was never hidden at
// all (e.g. switching to another window on desktop).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    vault.lock();
    returnToLock();
    return;
  }
  if (vault.maybeIdleLock()) returnToLock();
});

// The visibility check alone only catches a backgrounded app: one left open
// and foregrounded on a table never re-evaluates, so the idle clock also
// needs to be polled while the app just sits there.
setInterval(() => {
  if (vault.maybeIdleLock()) returnToLock();
}, IDLE_CHECK_MS);

// Driving the lock off a real timer means real activity must reset the
// clock, or she gets locked out mid-use between visibility changes.
document.addEventListener('pointerdown', () => { vault.touch(); });
document.addEventListener('keydown', () => { vault.touch(); });

start();
