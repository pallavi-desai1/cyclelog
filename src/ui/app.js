import { indexedDbBackend } from '../store.js';
import { createVault } from '../unlock.js';
import {
  biometricSupported, enrollBiometric, biometricKey,
  rememberCredentialId, readCredentialId,
} from '../biometric.js';
import { documentFromSources, emptyDocument, serializeDocument, parseDocument } from '../import.js';
import { buildSummary } from '../summary.js';
import { renderSummary } from './render.js';
import { localToday } from '../today.js';

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

// Shared by the lock button, the visibility check and the idle timer: the
// summary must not survive any path back to the lock screen.
function returnToLock() {
  el('summary').innerHTML = '';
  screen('lock');
}

function paint() {
  const summary = buildSummary(parseDocument(vault.read()), localToday());
  el('summary').innerHTML = renderSummary(summary);
  screen('app');
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

async function create() {
  try {
    const passphrase = el('setup-passphrase').value;
    if (passphrase.length < 8) return say('setup-error', 'Use at least 8 characters.');
    if (passphrase !== el('setup-confirm').value) return say('setup-error', 'The two passphrases differ.');

    say('setup-error', '');
    say('setup-progress', 'Reading your files…');

    let vaultDoc;
    try {
      const clueJson = await readFile(el('clue-file'), true);
      const legacyText = await readFile(el('legacy-file'), false);
      vaultDoc = (clueJson || legacyText)
        ? documentFromSources({ clueJson, legacyText }).doc
        : emptyDocument();
    } catch {
      say('setup-progress', '');
      // The file is not blamed by name: the message says what to do next.
      return say('setup-error', 'That file could not be read. Check you picked the right one.');
    }

    say('setup-progress', 'Encrypting…');
    await vault.setup(passphrase, serializeDocument(vaultDoc));
    clear('setup-passphrase');
    clear('setup-confirm');
    say('setup-progress', '');
    await offerFaceId();
    paint();
  } catch {
    // Backstop for anything above that was not already given its own
    // message: a storage failure from vault.setup, a quota error, etc.
    // Silence here would be a click that visibly does nothing.
    say('setup-progress', '');
    say('setup-error', 'Something went wrong. Please try again.');
  }
}

async function unlock() {
  try {
    const result = await vault.unlock(el('passphrase').value);
    if (!result.ok) return say('lock-error', 'That passphrase did not open the vault.');
    say('lock-error', '');
    paint();
  } catch {
    // Covers a correct passphrase against a corrupted or wrong-version
    // document: parseDocument inside paint() can throw, and without this the
    // click clears the error line and then does nothing at all.
    say('lock-error', 'Something went wrong. Please try again.');
  } finally {
    clear('passphrase');
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

async function offerFaceId() {
  if (!biometricSupported()) return;
  const enrolled = await enrollBiometric({
    credentials: navigator.credentials,
    rpId: window.location.hostname,
    rpName: RP_NAME,
    userName: 'cyclelog',
  });
  // A device without PRF, or a declined prompt, leaves the passphrase as the
  // only way in — which is the designed fallback, not an error worth showing.
  if (!enrolled.ok) return;
  await rememberCredentialId(backend, enrolled.credentialId);
  await vault.enrollWrapping('biometric', enrolled.key);
}

async function start() {
  try {
    const status = await vault.status();
    if (status === 'empty') return screen('setup');
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
el('lock-now').addEventListener('click', () => {
  vault.lock();
  returnToLock();
});
el('passphrase').addEventListener('keydown', event => {
  if (event.key === 'Enter') unlock();
});

// Backgrounding the app is activity stopping, so the idle clock is checked on
// every return. A phone left on a table locks itself.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    vault.touch();
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
