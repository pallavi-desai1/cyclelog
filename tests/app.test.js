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
      'renderDay(dayDetail(openDoc, date, { todayISO: localToday(), adaptedDate: openSummary.adapted.date, baselineDate: openSummary.baseline.date, }))',
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
    const inHelper = (functionBody(text, 'returnToLock').match(/innerHTML = ''/g) || []).length;
    const everywhere = (text.match(/innerHTML = ''/g) || []).length;
    expect(inHelper).toBe(3);        // the summary, the calendar and the day panel
    expect(everywhere).toBe(inHelper);
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
    const body = functionBody(app(), 'create');
    expect(body).toMatch(/await offerFaceId\(\);\s*(\/\/[^\n]*\n\s*)*paint\(importNote\);/);
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
    expect(body).toMatch(/baselineDate/);
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
