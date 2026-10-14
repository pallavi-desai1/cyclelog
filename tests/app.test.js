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
    for (const [, expression] of app().matchAll(/innerHTML = ([^;]+);/g)) {
      expect(['renderSummary(summary)', "''"]).toContain(expression.trim());
    }
  });

  it('locks when the page is hidden, so a backgrounded app is not open', () => {
    expect(app()).toContain('visibilitychange');
    expect(app()).toContain('maybeIdleLock');
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
    // while she is actively reading the card.
    const text = app();
    expect(text).toContain("addEventListener('pointerdown'");
    expect(text).toContain("addEventListener('keydown'");
    const touches = (text.match(/vault\.touch\(\)/g) || []).length;
    expect(touches).toBeGreaterThanOrEqual(3);
  });

  it('shares one lock-and-clear sequence across every lock site', () => {
    // lock-now, the visibility branch and the timer all return to the lock
    // screen; a single shared assignment (rather than three inlined copies)
    // is what the brief's duplication note asked for.
    const text = app();
    const clears = (text.match(/innerHTML = ''/g) || []).length;
    expect(clears).toBe(1);
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
