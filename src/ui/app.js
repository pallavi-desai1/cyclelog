import { indexedDbBackend } from '../store.js';
import { createVault } from '../unlock.js';
import {
  biometricSupported, enrollBiometric, biometricKey,
  rememberCredentialId, readCredentialId,
} from '../biometric.js';
import {
  documentFromSources, emptyDocument, serializeDocument, parseDocument, describeImport,
} from '../import.js';
import { buildSummary } from '../summary.js';
import { monthGrid, monthOf, shiftMonth, projectedDates } from '../calendar.js';
import { dayDetail } from '../day.js';
import { renderSummary, renderCalendar, renderDay } from './render.js';
import { localToday } from '../today.js';
import { addDays } from '../dates.js';

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
  el('day-detail').innerHTML = '';
  say('cal-label', '');
  say('import-notice', '');
  // The decrypted document must not outlive the lock (spec §8), and the
  // calendar is the one place it was being held outside the vault.
  openDoc = null;
  openSummary = null;
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

function paint(note = '') {
  openDoc = parseDocument(vault.read());
  openSummary = buildSummary(openDoc, localToday());
  el('summary').innerHTML = renderSummary(openSummary);
  say('import-notice', note);
  viewMonth = monthOf(localToday());
  selectedDate = null;
  drawCalendar();
  screen('app');
}

// Where her period would have fallen in THIS month, not merely the next one
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

    let vaultDoc;
    let importNote = '';
    try {
      const clueJson = await readFile(el('clue-file'), true);
      const legacyText = await readFile(el('legacy-file'), false);
      if (clueJson || legacyText) {
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
    paint(importNote);
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
    paint();
  } catch {
    // Covers a correct passphrase against a corrupted or wrong-version
    // document: parseDocument inside paint() can throw, and without this the
    // click clears the error line and then does nothing at all.
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
    paint();
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
  if (cell !== null) selectDay(cell.dataset.date);
});
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
