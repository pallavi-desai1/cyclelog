import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// src/ui/app.js touches `navigator` and `document` at module scope, so it is
// read as text rather than imported. These assertions pin the wiring that the
// manual pass in Step 7 then confirms actually works.
const root = join(import.meta.dirname, '..');
const app = () => readFileSync(join(root, 'src/ui/app.js'), 'utf8');
const html = () => readFileSync(join(root, 'index.html'), 'utf8');
const sw = () => readFileSync(join(root, 'sw.js'), 'utf8');

// Extracts the balanced-brace body of `function name(...) { ... }` from the
// given source text, so error-handling assertions check inside the actual
// function rather than matching a `catch` anywhere in the file.
function functionBody(text, name) {
  const marker = `function ${name}(`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = text.indexOf('{', markerIndex);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

// Extracts the balanced-brace block immediately following `marker` (which
// must end just before the opening `{`) — for checking what IS and is NOT
// inside a specific nested `if { ... }`, rather than searching the first
// occurrence of a token (like `return;`) anywhere in the enclosing function,
// which can land on an earlier, unrelated guard.
function balancedBlockAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = text.indexOf('{', markerIndex);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

describe('index.html first-run markup', () => {
  it('has the setup screen the app drives', () => {
    for (const id of [
      'setup', 'setup-passphrase', 'setup-confirm', 'clue-file', 'legacy-file',
      'create', 'setup-error', 'setup-progress',
    ]) {
      expect(html(), id).toContain(`id="${id}"`);
    }
  });

  it('accepts the two export formats and nothing else', () => {
    expect(html()).toMatch(/id="clue-file"[^>]*accept="[^"]*\.json/);
    expect(html()).toMatch(/id="legacy-file"[^>]*accept="[^"]*\.txt/);
  });

  it('offers a lock button once unlocked', () => {
    expect(html()).toContain('id="lock-now"');
  });
});

describe('app wiring', () => {
  it('stores through IndexedDB, not memory', () => {
    expect(app()).toContain('indexedDbBackend()');
    expect(app()).not.toContain('memoryBackend');
  });

  it('renders through the tested renderer', () => {
    expect(app()).toContain('renderSummary(');
    expect(app()).toContain('buildSummary(');
  });

  it('dates the summary with local parts', () => {
    expect(app()).toContain('localToday()');
  });

  it('assigns only the renderer output to innerHTML', () => {
    // Markup reaches the page from the two tested renderers or not at all;
    // anything else here would be a string built outside their escaping.
    const squash = text => text.replace(/\s+/g, ' ').trim();
    const allowed = [
      'renderSummary(openSummary)',
      'renderCalendar(grid)',
      "''",
      'renderDay(dayDetail(openDoc, date, { todayISO: localToday(), adaptedDate: openSummary.adapted.date, baselineDates: ghostDatesFor(monthOf(date)), }))',
      'renderMonthPicker({ month: viewMonth, range: monthRange(openDoc, localToday()), })',
      'renderEditor(dayDetail(openDoc, date, { todayISO: localToday(), adaptedDate: openSummary.adapted.date, baselineDates: ghostDatesFor(monthOf(date)), }))',
      "renderShareCard({ state, fingerprint: state.key === null ? '' : await fingerprint(state.key), ownerUid: state.identity === null ? null : state.identity.uid, })",
      "renderViewerHeader({ scope: null, updatedAt: null, label: '' })",
      "renderViewerHeader({ scope, updatedAt, label: 'her' }) + renderSummary(summary) + renderCalendar(grid)",
    ];
    for (const [, expression] of app().matchAll(/innerHTML = ([^;]+);/g)) {
      expect(allowed).toContain(squash(expression));
    }
  });

  it('locks when the page is hidden, so a backgrounded app is not open', () => {
    // Before the fix, the hidden branch called vault.touch() (extending the
    // session across backgrounding) instead of vault.lock(). Assert the real
    // behaviour, not just that the string "visibilitychange" appears.
    const text = app();
    expect(text).toContain('visibilitychange');
    const handlerMatch = text.match(
      /addEventListener\('visibilitychange', \(\) => \{([\s\S]*?)\n\}\);/,
    );
    expect(handlerMatch, 'visibilitychange handler').not.toBeNull();
    const handler = handlerMatch[1];
    const hiddenBranchMatch = handler.match(
      /if \(document\.visibilityState === 'hidden'\) \{([\s\S]*?)\}/,
    );
    expect(hiddenBranchMatch, 'hidden branch').not.toBeNull();
    const hiddenBranch = hiddenBranchMatch[1];
    expect(hiddenBranch).toContain('vault.lock()');
    expect(hiddenBranch).not.toContain('vault.touch()');
    expect(text).toContain('maybeIdleLock');
  });

  it('offers Face ID only when the browser could support it', () => {
    expect(app()).toContain('biometricSupported(');
    expect(app()).toContain('readCredentialId(');
  });

  it('remembers the credential before enrolling the wrapping', () => {
    // enrollWrapping re-reads the meta, so the reverse order drops it.
    const text = app();
    expect(text.indexOf('rememberCredentialId(')).toBeLessThan(text.indexOf('enrollWrapping('));
  });

  it('never writes the document or the passphrase to the console', () => {
    for (const [, argument] of app().matchAll(/console\.\w+\(([^)]*)\)/g)) {
      expect(argument).not.toMatch(/document|passphrase|summary|doc\b/);
    }
  });

  it('clears the passphrase field after using it', () => {
    expect(app()).toMatch(/\.value = ''/);
  });
});

describe('error handling', () => {
  it('catches inside every top-level async entry point', () => {
    const text = app();
    for (const name of ['create', 'unlock', 'faceIdUnlock', 'start']) {
      const body = functionBody(text, name);
      expect(body, name).not.toBeNull();
      expect(body, name).toMatch(/\bcatch\b/);
    }
  });

  it('shows a visible message rather than failing silently', () => {
    // A catch block that does nothing is as silent as no catch at all, so
    // the text after each `catch` must still call `say(...)`.
    const text = app();
    for (const name of ['create', 'unlock', 'faceIdUnlock', 'start']) {
      const body = functionBody(text, name);
      const afterCatch = body.slice(body.search(/\bcatch\b/));
      expect(afterCatch, name).toMatch(/say\(/);
    }
  });
});

describe('idle locking', () => {
  it('evaluates the idle clock on a timer, not only on visibility change', () => {
    // Before this fix, maybeIdleLock() was only called from the
    // visibilitychange handler, so a foregrounded, untouched app never
    // locked. A second call site driven by setInterval is required.
    const text = app();
    expect(text).toMatch(/setInterval\(/);
    const calls = (text.match(/maybeIdleLock\(\)/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('touches the vault on real user activity', () => {
    // Without this, a real idle timer would lock the screen mid-use even
    // while she is actively reading the card. (Page-hide is deliberately NOT
    // one of these sites any more: hiding now locks immediately rather than
    // extending the session — see the visibilitychange test above.)
    const text = app();
    expect(text).toContain("addEventListener('pointerdown'");
    expect(text).toContain("addEventListener('keydown'");
    const touches = (text.match(/vault\.touch\(\)/g) || []).length;
    expect(touches).toBeGreaterThanOrEqual(2);
  });

  it('shares one lock-and-clear sequence across every lock site', () => {
    // lock-now, the visibility branch and the timer all return to the lock
    // screen through returnToLock(); no other site clears rendered markup, so
    // there is exactly one place that can forget a pane.
    const text = app();
    const helper = functionBody(text, 'returnToLock');
    const inHelper = (helper.match(/innerHTML = ''/g) || []).length;
    const everywhere = (text.match(/innerHTML = ''/g) || []).length;
    expect(inHelper).toBe(5);             // the summary, the calendar, the day panel, the share card and his viewer pane
    expect(helper).toMatch(/closePicker\(\)/);   // the picker, through its own helper
    // Those five are the only sites that clear rendered markup, so there is
    // exactly one place that can forget a pane.
    expect(everywhere).toBe(inHelper + 1);
  });
});

describe('setup robustness', () => {
  it('isolates a Face ID enrolment failure from the setup result', () => {
    // Before this fix, offerFaceId() had no catch of its own: a throw from
    // rememberCredentialId or enrollWrapping (both touch IndexedDB) would
    // propagate into create()'s outer catch and report a vault that was
    // already created and written as a failed setup.
    const text = app();
    const body = functionBody(text, 'offerFaceId');
    expect(body, 'offerFaceId').not.toBeNull();
    expect(body).toMatch(/\bcatch\b/);
  });

  it('runs paint() unconditionally after offering Face ID, passing the import note through', () => {
    // Before this fix, create() called `paint();` with no argument, and a
    // throw inside offerFaceId (now caught there, but the ordering itself
    // matters) would have skipped paint() entirely, leaving the setup screen
    // up over an already-created vault.
    // paint() is awaited now (Important 7, final review): it itself awaits
    // any pendingSave before reading, and must stay inside create()'s try
    // so a parseDocument throw there is still caught there.
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/await offerFaceId\(\);\s*(\/\/[^\n]*\n\s*)*await paint\(importNote\);/);
  });

  it('shows the Face ID button immediately on successful enrolment, not only on next start()', () => {
    const body = functionBody(app(), 'offerFaceId');
    expect(body).toContain("show('faceid')");
  });

  it('disables "Create my vault" for the duration of create(), re-enabling in a finally', () => {
    // Two concurrent create() runs each mint their own data key; whichever
    // writeMeta lands second can seal the stored blob with a key the stored
    // meta does not wrap, leaving the vault permanently unopenable. Guard: a
    // second click while disabled must be a no-op, and `disabled` must
    // return to false even on failure.
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/if \(el\('create'\)\.disabled\) return;/);
    expect(body).toMatch(/el\('create'\)\.disabled = true;/);
    expect(body).toMatch(/finally\s*\{[\s\S]*el\('create'\)\.disabled = false;[\s\S]*\}/);
  });

  it('disables "Unlock" for the duration of unlock(), re-enabling in a finally', () => {
    const body = functionBody(app(), 'unlock');
    expect(body).toMatch(/if \(el\('unlock'\)\.disabled\) return;/);
    expect(body).toMatch(/el\('unlock'\)\.disabled = true;/);
    expect(body).toMatch(/finally\s*\{[\s\S]*el\('unlock'\)\.disabled = false;[\s\S]*\}/);
  });

  it('reports what was imported instead of discarding warnings and counts', () => {
    // documentFromSources returns { doc, warnings, conflicts }; before this
    // fix create() destructured only .doc, so a dropped period or an
    // unparsed legacy line was invisible, with no way to fix it from inside
    // the app (import only runs during first-run setup). describeImport (in
    // src/import.js, tested directly in tests/import.test.js) computes the
    // message; this only pins that create() actually calls it rather than
    // discarding .warnings the way it used to.
    const text = app();
    expect(text).toContain('describeImport(');
    expect(text).not.toMatch(/documentFromSources\([^)]*\)\.doc\b/);
  });

  it('requires an explicit second press before creating an empty vault', () => {
    // No file chosen used to fall straight through to emptyDocument() with
    // no confirmation, so a mis-tap silently produced a vault with no
    // history and nothing on screen saying so.
    const text = app();
    expect(text).toContain('awaitingEmptyConfirm');
    expect(text).toMatch(/No files chosen\. Press Create again/);
  });
});

describe('setup is not interrupted by a lock', () => {
  // The bug this pins: returnToLock() switched screens unconditionally, so a
  // page-hide during first-run setup — picking a file, taking a call, glancing
  // at another app — replaced the setup screen with a lock screen for a vault
  // that did not exist yet. Her passphrase then "did not work", because there
  // was nothing to unlock, and only a reload got her back.
  it('does not show the lock screen when no vault exists', () => {
    const body = functionBody(app(), 'returnToLock');
    expect(body, 'returnToLock').not.toBeNull();
    const guard = body.indexOf('hasVault');
    const switchToLock = body.indexOf("screen('lock')");
    expect(guard, 'guards on hasVault').toBeGreaterThan(-1);
    expect(guard, 'guard precedes the screen switch').toBeLessThan(switchToLock);
  });

  it('records that a vault exists once setup completes', () => {
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/hasVault = true/);
  });

  it('records what start() found, so a reload knows too', () => {
    const body = functionBody(app(), 'start');
    expect(body).toMatch(/hasVault = /);
  });
});

describe('an empty vault is not reported as a bad passphrase', () => {
  // src/unlock.js distinguishes 'empty' from 'wrong-passphrase' precisely so
  // this message can be honest. Collapsing them tells her a correct
  // passphrase was wrong.
  it('reads the reason rather than assuming a wrong passphrase', () => {
    const body = functionBody(app(), 'unlock');
    expect(body).toMatch(/reason === 'empty'/);
  });

  it('sends her back to setup when there is nothing to unlock', () => {
    const body = functionBody(app(), 'unlock');
    const emptyBranch = body.slice(body.indexOf("reason === 'empty'"));
    expect(emptyBranch).toMatch(/screen\('setup'\)/);
  });
});

describe('the calendar', () => {
  it('has its markup and its month controls', () => {
    for (const id of ['calendar', 'cal-label', 'cal-prev', 'cal-next']) {
      expect(html(), id).toContain(`id="${id}"`);
    }
  });

  it('renders the grid through the tested renderer', () => {
    expect(app()).toContain('renderCalendar(');
    expect(app()).toContain('monthGrid(');
  });

  it('draws the month that contains today on first paint', () => {
    expect(app()).toMatch(/monthOf\(/);
  });

  it('steps the month without unlocking or re-reading the vault', () => {
    const text = app();
    expect(text).toContain("shiftMonth(");
    expect(text).toMatch(/cal-prev'\)\.addEventListener/);
    expect(text).toMatch(/cal-next'\)\.addEventListener/);
  });

  it('feeds the calendar both predicted dates', () => {
    const body = functionBody(app(), 'drawCalendar');
    expect(body, 'drawCalendar').not.toBeNull();
    expect(body).toMatch(/adaptedDate/);
    expect(body).toMatch(/baselineDates/);
  });

  it('clears the grid when the vault locks', () => {
    const body = functionBody(app(), 'returnToLock');
    expect(body).toMatch(/calendar'\)\.innerHTML = ''/);
  });
});

describe('precache', () => {
  it('lists every module the app now imports', () => {
    for (const module of [
      'src/today.js', 'src/summary.js', 'src/import.js', 'src/ui/render.js',
    ]) {
      expect(sw(), module).toContain(module);
    }
  });
});

describe('tapping a day', () => {
  it('has somewhere to put the day panel', () => {
    expect(html()).toContain('id="day-detail"');
  });

  it('renders the panel through the tested renderer', () => {
    expect(app()).toContain('renderDay(');
    expect(app()).toContain('dayDetail(');
  });

  // One delegated listener on the grid, not one per cell: the grid is
  // re-rendered on every month step, and per-cell listeners would be
  // re-attached (or silently lost) each time.
  it('listens once on the grid rather than per cell', () => {
    const text = app();
    expect(text).toMatch(/calendar'\)\.addEventListener\('click'/);
    expect(text).toMatch(/closest\('\[data-date\]'\)|dataset\.date/);
  });

  it('clears the panel when the vault locks', () => {
    expect(functionBody(app(), 'returnToLock')).toMatch(/day-detail'\)\.innerHTML = ''/);
  });

  it('keeps the selected day across a month step', () => {
    expect(functionBody(app(), 'stepMonth')).not.toMatch(/selectedDate = null/);
  });
});

describe('the counterfactual across every month', () => {
  it('projects the ghost cadence for the month on screen', () => {
    const body = functionBody(app(), 'ghostDatesFor');
    expect(body, 'ghostDatesFor').not.toBeNull();
    expect(body).toMatch(/projectedDates\(/);
    expect(body).toMatch(/baseline\.length/);
  });

  it('says nothing when there is no usable natural-cycle history', () => {
    expect(functionBody(app(), 'ghostDatesFor')).toMatch(/baseline\.available/);
  });

  it('feeds the same cadence to the grid and the day panel', () => {
    expect(functionBody(app(), 'drawCalendar')).toMatch(/ghostDatesFor\(/);
    expect(functionBody(app(), 'selectDay')).toMatch(/ghostDatesFor\(/);
  });
});

describe('the ghost cadence starts at the anchor', () => {
  // A `?? baseline.date` fallback here would project from the next ghost
  // instead of the anchor, silently dropping every month before it.
  it('uses the anchor with no silent fallback', () => {
    const body = functionBody(app(), 'ghostDatesFor');
    expect(body).toMatch(/baseline\.anchor/);
    expect(body).not.toMatch(/anchor \?\?/);
  });
});

describe('editing a day', () => {
  it('offers an edit button on the day panel', () => {
    // index.html holds only the empty #day-detail container — every day's
    // markup, this button included, comes from renderDay() in render.js.
    const render = () => readFileSync(join(root, 'src/ui/render.js'), 'utf8');
    expect(render()).toContain('id="edit-day"');
  });

  it('renders the form through the tested renderer', () => {
    expect(app()).toContain('renderEditor(');
  });

  it('builds the patch through the tested function', () => {
    expect(app()).toContain('patchFromValues(');
  });

  // Critical 1 (final review): saveDay used to call setDayFields/setFlow
  // directly, calling setFlow unconditionally even when the flow had not
  // changed — which read an untouched save on an entry-less day as a
  // deliberate clear and corrupted the period it fell inside. applyDayEdit
  // (src/edit.js, tested directly in tests/edit.test.js) is the guarded
  // composition; saveDay must delegate to it rather than re-implementing
  // the guard itself where no test here could exercise it.
  it('composes the edit through the guarded, tested applyDayEdit rather than the raw functions', () => {
    const body = functionBody(app(), 'saveDay');
    expect(body, 'saveDay').not.toBeNull();
    expect(body).toMatch(/applyDayEdit\(/);
    expect(body).not.toMatch(/\bsetFlow\(/);
    expect(body).not.toMatch(/\bsetDayFields\(/);
  });

  it('persists through the vault rather than writing storage directly', () => {
    expect(functionBody(app(), 'saveDay')).toMatch(/vault\.save\(/);
    expect(functionBody(app(), 'saveDay')).toMatch(/serializeDocument\(/);
  });

  // Review Focus 1: a failed save must never look like a successful one.
  it('keeps the form open and says so when the save fails', () => {
    const body = functionBody(app(), 'saveDay');
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/edit-error/);
  });

  it('only adopts the new document after the save resolves', () => {
    // The write is issued as vault.save(...) and awaited separately as
    // `await writePromise;` (so pendingSave can hold the same promise for
    // paint() to wait on) — that second line is the actual await point.
    const body = functionBody(app(), 'saveDay');
    expect(body.indexOf('vault.save(')).toBeGreaterThan(-1);
    expect(body.indexOf('await writePromise;')).toBeLessThan(body.indexOf('openDoc = '));
  });

  it('re-renders the card and the grid from the saved document', () => {
    expect(functionBody(app(), 'saveDay')).toMatch(/paint\(|drawCalendar\(/);
  });

  it('drops a draft when the vault locks', () => {
    expect(functionBody(app(), 'returnToLock')).toMatch(/editing = null/);
  });

  it('guards the save button against a second tap', () => {
    const body = functionBody(app(), 'saveDay');
    expect(body).toMatch(/disabled/);
    expect(body).toMatch(/finally/);
  });

  // Critical 1 (review, round 1): vault.save awaits two IndexedDB round
  // trips (seal(), then backend.set()). A lock firing in that window must
  // not let the continuation bring the decrypted document back into memory
  // or repaint the summary, calendar and day panel on top of the lock
  // screen once the save resolves.
  it('bumps the session epoch on every path back to the lock screen', () => {
    expect(functionBody(app(), 'returnToLock')).toMatch(/sessionEpoch \+= 1/);
  });

  // Critical 2 (review, round 2): the epoch means "the vault locked", full
  // stop. Opening a different editor mid-save is a separate event — the
  // save in flight still needs to land in memory, which bumping this same
  // counter there would have prevented. One counter, one meaning.
  it('does not bump the session epoch when a fresh editor opens — only a lock does', () => {
    expect(functionBody(app(), 'openEditor')).not.toMatch(/sessionEpoch/);
  });

  // Critical 2 (review, round 3): `editing` holds a date, not a session
  // identity, so two sessions opened back-to-back on the SAME day (open X,
  // Save pending, Cancel, reopen X, type new values) are otherwise
  // indistinguishable by date alone when the first save resolves. A real
  // token, bumped on every open, is what tells them apart.
  it('gives every fresh editor its own session token', () => {
    expect(functionBody(app(), 'openEditor')).toMatch(/editSession \+= 1;/);
  });

  it('captures the session token before the first await, alongside the epoch', () => {
    const body = functionBody(app(), 'saveDay');
    const sessionCaptureIndex = body.indexOf('const session = editSession;');
    const awaitIndex = body.indexOf('await writePromise;');
    expect(sessionCaptureIndex, 'const session = editSession;').toBeGreaterThan(-1);
    expect(awaitIndex, 'await writePromise;').toBeGreaterThan(-1);
    expect(sessionCaptureIndex).toBeLessThan(awaitIndex);
  });

  // The date dropped out of saveOutcome entirely in round 3 — a session
  // token implies its date, and only the token can tell two sessions on the
  // same day apart. Pin that saveDay passes tokens, not editing/date.
  it('calls saveOutcome with both session tokens, not with editing/date', () => {
    const body = functionBody(app(), 'saveDay');
    const calls = [...body.matchAll(/saveOutcome\(\{([^}]*)\}\)/g)];
    // Without this, removing every call would make the loop below run zero
    // times and the test would pass having asserted nothing. There are two
    // call sites — the success path and the failure path.
    expect(calls.length, 'saveOutcome( call sites').toBeGreaterThanOrEqual(2);
    for (const [, call] of calls) {
      expect(call).toMatch(/sessionAtStart:\s*session/);
      expect(call).toMatch(/sessionNow:\s*editSession/);
      expect(call).not.toMatch(/\bediting\b/);
      expect(call).not.toMatch(/\bdate\b/);
    }
  });

  // Critical 2 (review, round 2): the data-loss mechanism after round 1's
  // fix was that openDoc was only resynced when the save was still the
  // visible session — so a superseded save's write landed in the vault but
  // never in memory, and the next save computed `next` from that stale
  // base and overwrote it. openDoc must be assigned on every outcome except
  // 'abandon' (the vault locked, so memory must stay null), and specifically
  // before the 'adopt-only' check that decides whether to also repaint.
  it('updates memory on an abandoned-screen save too, before deciding whether to repaint', () => {
    const body = functionBody(app(), 'saveDay');
    const abandonIndex = body.indexOf("outcome === 'abandon'");
    const openDocIndex = body.indexOf('openDoc = next;');
    const adoptOnlyIndex = body.indexOf("outcome === 'adopt-only'");
    expect(abandonIndex, "the 'abandon' check").toBeGreaterThan(-1);
    expect(openDocIndex, 'openDoc = next;').toBeGreaterThan(abandonIndex);
    expect(adoptOnlyIndex, "the 'adopt-only' check").toBeGreaterThan(openDocIndex);
  });

  it('decides with the pure, tested saveOutcome function rather than its own logic', () => {
    expect(functionBody(app(), 'saveDay')).toMatch(/saveOutcome\(/);
  });

  // Critical 2 (review, round 2): the button's `disabled` attribute is not a
  // lock — Cancel/openEditor re-render the panel and hand out a brand-new,
  // enabled button while an earlier save is still pending. A real flag at
  // module scope is what actually serialises concurrent saves.
  it('serialises saves with a real in-flight flag, not just the button attribute', () => {
    const body = functionBody(app(), 'saveDay');
    expect(body).toMatch(/saveInFlight = true;/);
    expect(body).toMatch(/finally\s*\{[\s\S]*saveInFlight = false;[\s\S]*\}/);
  });

  // Critical 2 follow-up (review, round 2): round 1's in-flight flag made a
  // tap during a pending save a dead click — it returned with no message and
  // no visible change. The block must say so instead of doing nothing.
  it('tells her when a tap is blocked because a save is already in flight', () => {
    const body = functionBody(app(), 'saveDay');
    const guardIndex = body.indexOf('if (saveInFlight)');
    expect(guardIndex, 'the saveInFlight guard').toBeGreaterThan(-1);
    const guardBlock = body.slice(guardIndex, body.indexOf('saveInFlight = true;'));
    expect(guardBlock).toMatch(/edit-error/);
    expect(guardBlock).toMatch(/errorField !== null/);
  });

  // Critical 2 (review, round 1): before this fix, the failure branch called
  // say('edit-error', ...), which assumes the element exists. #edit-error
  // can be gone by the time a stale save's catch runs (a later re-render
  // replaced the panel), and a throw inside a catch is worse than the
  // silent failure it would be reporting.
  it('does not assume #edit-error still exists when reporting a failure', () => {
    const body = functionBody(app(), 'saveDay');
    const catchBody = body.slice(body.search(/\bcatch\b/));
    expect(catchBody).toMatch(/getElementById\('edit-error'\)/);
    expect(catchBody).toMatch(/if \(errorField !== null\)/);
  });

  // Important (review, round 4): open day X's editor, Save (pending),
  // Cancel, tap day Y on the calendar — editSession has not moved (only
  // openEditor bumps it, and nothing reopened), so the outcome is
  // 'adopt-and-render'. The summary and calendar must still refresh and
  // `editing` must still clear, but pulling the panel back to X with
  // selectDay(date) would yank her away from Y, which she never asked for.
  it('refreshes the summary and calendar unconditionally, but only repaints the panel if she is still looking at that day', () => {
    const body = functionBody(app(), 'saveDay');
    const summaryIndex = body.indexOf("el('summary').innerHTML = renderSummary(openSummary);");
    const drawIndex = body.indexOf('drawCalendar();');
    const clearIndex = body.indexOf('editing = null;');
    const guardIndex = body.indexOf('if (selectedDate === date) selectDay(date);');
    expect(summaryIndex, "el('summary').innerHTML = ...").toBeGreaterThan(-1);
    expect(drawIndex, 'drawCalendar();').toBeGreaterThan(summaryIndex);
    expect(clearIndex, 'editing = null;').toBeGreaterThan(drawIndex);
    expect(guardIndex, 'if (selectedDate === date) selectDay(date);').toBeGreaterThan(clearIndex);
  });

  // Important 4 (final review): openSummary was recomputed in the
  // 'adopt-only' branch but the function then returned without repainting
  // #summary or the calendar — so recording today as heavy flow while a
  // different editor happened to be open left the card showing stale
  // lateness over a period that was now in the vault. The summary/calendar
  // refresh must sit BEFORE the 'adopt-only' check, so it runs on that
  // outcome too; only the panel repaint and clearing `editing` stay gated.
  it("repaints the summary and calendar even when the outcome is 'adopt-only'", () => {
    const body = functionBody(app(), 'saveDay');
    const openDocIndex = body.indexOf('openDoc = next;');
    const summaryIndex = body.indexOf("el('summary').innerHTML = renderSummary(openSummary);");
    const drawIndex = body.indexOf('drawCalendar();');
    const adoptOnlyIndex = body.indexOf("outcome === 'adopt-only'");
    expect(openDocIndex, 'openDoc = next;').toBeGreaterThan(-1);
    expect(summaryIndex, "el('summary').innerHTML = ...").toBeGreaterThan(openDocIndex);
    expect(drawIndex, 'drawCalendar();').toBeGreaterThan(summaryIndex);
    expect(adoptOnlyIndex, "the 'adopt-only' check").toBeGreaterThan(drawIndex);
  });

  // Important 3 (final review): on the failure path, both 'abandon' and
  // 'adopt-only' used to return with no trace at all — a save that failed
  // while the vault was locking, or while a different editor was open, left
  // nothing recorded anywhere. unsavedWarning (surfaced by paint()) is the
  // one place left that can still tell her, on the next unlock.
  it('remembers a failed save that could not show its own message', () => {
    const body = functionBody(app(), 'saveDay');
    const catchBody = body.slice(body.search(/\bcatch\b/));
    const outcomeCheckIndex = catchBody.indexOf("outcome !== 'adopt-and-render'");
    const warningIndex = catchBody.indexOf('unsavedWarning = date;');
    expect(outcomeCheckIndex, "the 'adopt-and-render' check").toBeGreaterThan(-1);
    expect(warningIndex, 'unsavedWarning = date;').toBeGreaterThan(outcomeCheckIndex);
  });

  it('surfaces a remembered save failure the next time paint() runs, then forgets it', () => {
    const body = functionBody(app(), 'paint');
    expect(body, 'paint').not.toBeNull();
    expect(body).toMatch(/unsavedWarning !== null/);
    expect(body).toMatch(/unsavedWarning = null;/);
  });

  // Important 7 (final review): an unlock arriving while a save was still
  // writing used to call vault.read() immediately, reading the pre-save
  // document; her next save would then compute from that stale base and
  // silently overwrite the earlier edit. paint() must wait for any pending
  // write before it reads.
  it('holds the in-flight save so paint() can wait for it before reading', () => {
    const body = functionBody(app(), 'saveDay');
    expect(body).toMatch(/pendingSave = writePromise;/);
    const paintBody = functionBody(app(), 'paint');
    expect(paintBody, 'paint').not.toBeNull();
    const pendingIndex = paintBody.indexOf('await pendingSave');
    const readIndex = paintBody.indexOf('vault.read()');
    expect(pendingIndex, 'await pendingSave').toBeGreaterThan(-1);
    expect(readIndex, 'vault.read()').toBeGreaterThan(pendingIndex);
  });

  it('awaits paint() in unlock and faceIdUnlock, so a throw inside it is still caught there', () => {
    // create()'s own await-paint wiring has its own test above
    // ("runs paint() unconditionally..."); this covers the other two
    // call sites, which this round's fix (paint() now awaits pendingSave
    // first) turned into real await points for the first time.
    expect(functionBody(app(), 'unlock')).toMatch(/await paint\(\);/);
    expect(functionBody(app(), 'faceIdUnlock')).toMatch(/await paint\(\);/);
  });

  // Data loss (review, round 4), pre-existing but the same class of problem
  // this whole task has been about: the calendar's click listener used to
  // call selectDay(cell.dataset.date) unconditionally, replacing
  // #day-detail wholesale and wiping a half-typed entry with no warning.
  describe('tapping the calendar while the editor is open', () => {
    const calendarHandler = () => {
      const match = app().match(/calendar'\)\.addEventListener\('click', event => \{([\s\S]*?)\n\}\);/);
      expect(match, 'calendar click handler').not.toBeNull();
      return match[1];
    };

    it('checks editing before ever calling selectDay', () => {
      const handler = calendarHandler();
      const guardIndex = handler.indexOf('editing !== null');
      const selectDayIndex = handler.lastIndexOf('selectDay(date)');
      expect(guardIndex, 'editing !== null check').toBeGreaterThan(-1);
      expect(selectDayIndex, 'selectDay(date) call').toBeGreaterThan(guardIndex);
    });

    // Minor (final branch review): the earlier version of this test anchored
    // on the first `return;` in the handler, which is the `cell === null`
    // guard at the very top — it would not have caught selectDay being
    // called from inside the `editing !== date` sub-branch. This extracts
    // the `if (editing !== null) { ... }` block itself by balanced braces,
    // so it can assert selectDay is nowhere inside it, and still runs once
    // that block is behind it.
    it('never calls selectDay from inside the editing guard, but still reaches it once editing is null', () => {
      const handler = calendarHandler();
      const guardBlock = balancedBlockAfter(handler, 'if (editing !== null)');
      expect(guardBlock, 'if (editing !== null) { ... } block').not.toBeNull();
      expect(guardBlock).not.toContain('selectDay(');
      const afterGuard = handler.slice(handler.indexOf(guardBlock) + guardBlock.length);
      expect(afterGuard).toContain('selectDay(date)');
    });

    it('warns rather than silently discarding when a different day is tapped mid-edit', () => {
      const handler = calendarHandler();
      expect(handler).toMatch(/editing !== date/);
      expect(handler).toMatch(/edit-error/);
      expect(handler).toMatch(/Save or cancel this day first/);
    });
  });
});

describe('the Today button', () => {
  it('sits in the calendar head', () => {
    expect(html()).toContain('id="cal-today"');
    // After the next-month arrow, which is where she asked for it.
    expect(html().indexOf('id="cal-today"')).toBeGreaterThan(html().indexOf('id="cal-next"'));
  });

  it('is wired to a handler', () => {
    expect(app()).toMatch(/cal-today'\)\.addEventListener\('click'/);
  });

  it('jumps to the month that contains today, not a hardcoded one', () => {
    const body = functionBody(app(), 'goToToday');
    expect(body, 'goToToday').not.toBeNull();
    expect(body).toMatch(/monthOf\(localToday\(\)\)/);
  });

  it('selects today as well as its month, since that is the date she asked for', () => {
    expect(functionBody(app(), 'goToToday')).toMatch(/selectDay\(localToday\(\)\)/);
  });

  it('closes the month picker on the way', () => {
    expect(functionBody(app(), 'goToToday')).toMatch(/closePicker\(\)/);
  });

  // The same rule the calendar cells follow: navigation must not destroy a
  // half-typed entry.
  it('refuses to navigate out from under an open editor', () => {
    const body = functionBody(app(), 'goToToday');
    const guard = body.indexOf('editing !== null');
    const jump = body.indexOf('viewMonth =');
    expect(guard, 'editing guard').toBeGreaterThan(-1);
    expect(guard, 'guard precedes the jump').toBeLessThan(jump);
  });

  it('does nothing while the vault is locked', () => {
    expect(functionBody(app(), 'goToToday')).toMatch(/openDoc === null/);
  });
});

describe('export', () => {
  it('offers all four of the spec outputs', () => {
    for (const id of ['export-backup', 'export-data', 'export-days', 'export-cycles']) {
      expect(html(), id).toContain(`id="${id}"`);
    }
  });

  it('builds every file through the tested formatters', () => {
    const text = app();
    for (const builder of ['backupBundle(', 'documentJson(', 'daysCsv(', 'cyclesCsv(']) {
      expect(text, builder).toContain(builder);
    }
  });

  it('names the files as the spec does, rather than inventing names', () => {
    expect(app()).toContain('FILENAMES.');
    expect(app()).not.toMatch(/'cyclelog-[a-z]+\.(json|csv)'/);
  });

  // Spec §9: a plaintext export is confirmed behind an explicit warning
  // naming what is about to leave the encrypted store.
  it('warns before anything plaintext leaves the vault', () => {
    const body = functionBody(app(), 'exportPlaintext');
    expect(body, 'exportPlaintext').not.toBeNull();
    expect(body).toMatch(/confirm\(/);
    expect(body).toMatch(/not encrypted|unencrypted|plain text/i);
  });

  it('does not warn for the encrypted backup, which needs no warning', () => {
    expect(functionBody(app(), 'exportBackup')).not.toMatch(/confirm\(/);
  });

  it('reads the sealed blob and the key material straight from the store', () => {
    const body = functionBody(app(), 'exportBackup');
    expect(body).toMatch(/readMeta\(/);
    expect(body).toMatch(/VAULT_KEY/);
  });

  it('downloads through a Blob, with no network anywhere in it', () => {
    const body = functionBody(app(), 'download');
    expect(body, 'download').not.toBeNull();
    expect(body).toMatch(/new Blob\(/);
    expect(body).toMatch(/createObjectURL/);
    expect(body).toMatch(/revokeObjectURL/);
    expect(body).not.toMatch(/fetch\(|XMLHttpRequest|\.send\(/);
  });

  it('does nothing while the vault is locked', () => {
    for (const fn of ['exportBackup', 'exportPlaintext']) {
      expect(functionBody(app(), fn), fn).toMatch(/openDoc === null|status\(\)/);
    }
  });
});

describe('restore and storage durability', () => {
  it('offers a restore picker on the setup screen', () => {
    expect(html()).toContain('id="restore-file"');
    expect(html()).toMatch(/id="restore-file"[^>]*accept="[^"]*\.json/);
  });

  it('classifies the picked file rather than guessing from its name', () => {
    expect(app()).toContain('classifyRestoreFile(');
  });

  it('restores an encrypted backup through the tested path', () => {
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/parseBackupBundle\(/);
    expect(body).toMatch(/restoreBackup\(/);
  });

  // A backup carries its own key material, so the passphrase that opens it is
  // the one it was made with — not whatever she typed into the setup form.
  it('opens a restored backup with the passphrase typed on the form', () => {
    const body = functionBody(app(), 'create');
    const restore = body.indexOf('restoreBackup(');
    const unlock = body.indexOf('vault.unlock(');
    expect(restore).toBeGreaterThan(-1);
    expect(unlock).toBeGreaterThan(restore);
  });

  it('treats a plaintext data export as a document to seal under a new passphrase', () => {
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/'document'/);
    expect(body).toMatch(/parseDocument\(/);
  });

  it('asks the browser to keep the vault rather than treat it as cache', () => {
    expect(app()).toContain('requestPersistentStorage(');
  });

  it('records when a backup was taken, and shows it', () => {
    expect(functionBody(app(), 'exportBackup')).toMatch(/markBackup\(/);
    expect(app()).toMatch(/readLastBackup\(/);
  });

  it('says plainly when no backup has ever been taken', () => {
    expect(app()).toMatch(/No backup yet|never backed up/i);
  });
});

describe('the owner side of sharing', () => {
  it('has somewhere to put the share card', () => {
    expect(html()).toContain('id="share"');
  });

  it('renders it through the tested renderer', () => {
    expect(app()).toContain('renderShareCard(');
  });

  it('signs in anonymously rather than with Google', () => {
    expect(app()).toContain('signInAnonymously(');
    expect(app()).not.toMatch(/GoogleAuthProvider|accounts\.google\.com|gapi/);
  });

  it('loads no Firebase SDK', () => {
    expect(app()).not.toMatch(/firebase\/app|firebase-app|firebase\.initializeApp/);
    expect(html()).not.toMatch(/gstatic\.com|firebasejs/);
  });

  it('pushes through the tested payload builder, never a raw document', () => {
    const body = functionBody(app(), 'pushShare');
    expect(body, 'pushShare').not.toBeNull();
    const built = body.match(/(\w+)\s*=\s*await\s+buildPayload\(/);
    expect(built, 'builds the payload via buildPayload(...)').not.toBeNull();
    const [, payloadVar] = built;
    const call = body.match(/putVault\(\{[\s\S]*?\}\)/);
    expect(call, 'calls putVault(...)').not.toBeNull();
    expect(call[0]).toMatch(new RegExp(`[{,]\\s*(payload:\\s*)?${payloadVar}\\s*[,}]`));
  });

  // Review Focus 3: the status she reads has to come from what happened.
  it('records the outcome of every push, success or failure', () => {
    const body = functionBody(app(), 'pushShare');
    expect(body).toMatch(/withPushResult\(/);
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/error\.kind|'offline'|'denied'/);
  });

  it('debounces the push rather than writing on every keystroke', () => {
    expect(app()).toMatch(/PUSH_DEBOUNCE_MS/);
    expect(app()).toMatch(/setTimeout\(/);
  });

  it('never blocks a save on the network', () => {
    // The vault write is hers; the push is a courtesy to him.
    const body = functionBody(app(), 'saveDay');
    expect(body).not.toMatch(/await pushShare/);
  });

  it('drops the share card with everything else on lock', () => {
    expect(functionBody(app(), 'returnToLock')).toMatch(/share'\)\.innerHTML = ''/);
  });

  // A lock can run to completion during any await in these handlers,
  // nulling openDoc out from under the resumed code — the handler must
  // notice and stop rather than read `.sharing` off null or build a `with*`
  // call from a document that no longer exists.
  it('re-checks openDoc after every await that could straddle a lock', () => {
    for (const name of [
      'syncIdentity', 'pushShare', 'startSharing', 'changeShareScope',
      'addShareViewer', 'removeShareViewer', 'rekeyShare', 'stopSharing',
    ]) {
      const body = functionBody(app(), name);
      expect(body, name).not.toBeNull();
      const awaits = (body.match(/\bawait\b/g) || []).length;
      const guards = (body.match(/openDoc === null/g) || []).length;
      // Every handler already guards at entry (one of these `openDoc ===
      // null` checks pays for that, not a post-await recheck), so there
      // must be strictly more awaits than there are guards accounted for
      // by entry checks alone — i.e. at least one guard survives per
      // function beyond the first.
      expect(guards, `${name}: no post-await null check found`).toBeGreaterThanOrEqual(2);
      expect(awaits, `${name}: expected at least one await`).toBeGreaterThanOrEqual(1);
    }
  });

  // persistShareDoc is the one place every handler writes the sharing
  // section to the vault; it must not adopt a write into memory before that
  // write is confirmed, and it must not revive the document after a lock
  // already cleared it out from under an in-flight write.
  it('does not adopt a write into memory before the vault confirms it', () => {
    const body = functionBody(app(), 'persistShareDoc');
    expect(body, 'persistShareDoc').not.toBeNull();
    const save = body.indexOf('vault.save(');
    const adopt = body.indexOf('openDoc = doc');
    expect(save).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(save);
  });

  it('say() is null-safe, so a stale element reference cannot throw', () => {
    const text = app();
    const match = text.match(/const say = \(id, message\) => \{([\s\S]*?)\n\};/);
    expect(match, 'say() definition').not.toBeNull();
    expect(match[1]).toMatch(/if\s*\([^)]*!==\s*null\)/);
  });

  // Review Focus 2: the card must never say "off" while the document says
  // "on" — if the network step after the local write fails, she must still
  // see that a key exists, or a second press mints and silently discards it.
  it('redraws the card on a failed start, not just on success', () => {
    const body = functionBody(app(), 'startSharing');
    expect(body, 'startSharing').not.toBeNull();
    const catchBlock = body.slice(body.indexOf('} catch'));
    expect(catchBlock).toMatch(/drawShare\(/);
  });

  // §7.5: a partial revoke failure must say sharing is still on, not just
  // "something went wrong" — she is mid-withdrawal and needs to know a retry
  // is required.
  it('tells her plainly when stopping sharing did not fully succeed', () => {
    const body = functionBody(app(), 'stopSharing');
    expect(body, 'stopSharing').not.toBeNull();
    const catchBlock = body.slice(body.indexOf('} catch'));
    expect(catchBlock).toMatch(/still on/i);
  });
});

describe('the viewer mode', () => {
  it('offers it on the setup screen', () => {
    expect(html()).toContain('id="setup-viewer"');
    expect(html()).toContain('id="viewer-owner-uid"');
    expect(html()).toContain('id="viewer-key"');
  });

  it('has a screen of its own', () => {
    expect(html()).toContain('id="viewer"');
  });

  it('stores his key and identity in his own vault, under his own passphrase', () => {
    const body = functionBody(app(), 'createViewer');
    expect(body, 'createViewer').not.toBeNull();
    expect(body).toMatch(/viewerRecord\(/);
    expect(body).toMatch(/vault\.setup\(/);
  });

  it('shows the fingerprint so he can check it against her screen', () => {
    expect(functionBody(app(), 'createViewer')).toMatch(/fingerprint\(/);
  });

  // Review Focus 5: read-only is not a hidden button.
  it('has no editor and no write path in viewer mode', () => {
    const body = functionBody(app(), 'paintViewer');
    expect(body, 'paintViewer').not.toBeNull();
    expect(body).not.toMatch(/renderEditor|applyDayEdit|openEditor/);
  });

  it('renders her data with the same tested renderers', () => {
    const body = functionBody(app(), 'paintViewer');
    expect(body).toMatch(/renderSummary\(/);
    expect(body).toMatch(/renderCalendar\(/);
    expect(body).toMatch(/renderViewerHeader\(/);
  });

  it('refreshes on open and on an explicit refresh, since there is no push', () => {
    expect(html()).toContain('id="viewer-refresh"');
    expect(app()).toMatch(/viewer-refresh'\)\.addEventListener/);
  });

  it('tells him when a refresh was refused rather than showing stale data as current', () => {
    const body = functionBody(app(), 'refreshViewer');
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/viewer-error/);
  });

  it('drops her data from his screen when his vault locks', () => {
    expect(functionBody(app(), 'returnToLock')).toMatch(/viewer'\)\.innerHTML = ''/);
  });
});
