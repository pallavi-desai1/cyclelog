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
  markBackup, readLastBackup, requestPersistentStorage,
} from '../restore.js';
import {
  monthGrid, monthOf, shiftMonth, projectedDates, monthRange, clampMonth,
} from '../calendar.js';
import { dayDetail } from '../day.js';
import {
  renderSummary, renderCalendar, renderDay, renderMonthPicker,
} from './render.js';
import { localToday } from '../today.js';
import { addDays } from '../dates.js';
import { applyDayEdit } from '../edit.js';
import { renderEditor, patchFromValues, saveOutcome } from './editor.js';

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
const say = (id, message) => { el(id).textContent = message; };

function screen(name) {
  for (const id of ['setup', 'lock', 'app']) {
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
  say('cal-label', '');
  say('import-notice', '');
  // The decrypted document must not outlive the lock (spec §8), and the
  // calendar is the one place it was being held outside the vault.
  openDoc = null;
  openSummary = null;
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

async function paint(note = '') {
  // See pendingSave above. Ignoring a rejection here is deliberate: a save
  // that failed is unsavedWarning's problem to surface, not a reason to
  // block getting back into the app.
  await pendingSave?.catch(() => {});
  openDoc = parseDocument(vault.read());
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
  screen('app');
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
      download(FILENAMES.data, documentJson(openDoc), 'application/json');
    } else if (kind === 'days') {
      download(FILENAMES.days, daysCsv(openDoc), 'text/csv');
    } else {
      download(FILENAMES.cycles, cyclesCsv(buildCycles(openDoc)), 'text/csv');
    }
  } catch {
    say('export-error', 'That download did not start. Please try again.');
  }
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
    if (!biometricSupported()) return;
    const enrolled = await enrollBiometric({
      credentials: navigator.credentials,
      rpId: window.location.hostname,
      rpName: RP_NAME,
      userName: 'cyclelog',
    });
    // A device without PRF, or a declined prompt, leaves the passphrase as
    // the only way in — the designed fallback, not an error worth showing.
    if (!enrolled.ok) return;
    await rememberCredentialId(backend, enrolled.credentialId);
    await vault.enrollWrapping('biometric', enrolled.key);
    // Enrolment just succeeded without a reload, so the lock screen (reached
    // later via lock-now, idle or page-hide) needs its Face ID button shown
    // now rather than only on the next cold start().
    show('faceid');
  } catch {
    // Silent on purpose: Face ID is an enhancement, and failing here must
    // leave the vault setup it followed looking exactly as successful as it
    // actually was.
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
el('export-backup').addEventListener('click', () => { exportBackup(); });
el('export-data').addEventListener('click', () => { exportPlaintext('data'); });
el('export-days').addEventListener('click', () => { exportPlaintext('days'); });
el('export-cycles').addEventListener('click', () => { exportPlaintext('cycles'); });
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
