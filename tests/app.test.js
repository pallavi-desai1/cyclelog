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

describe('precache', () => {
  it('lists every module the app now imports', () => {
    for (const module of [
      'src/today.js', 'src/summary.js', 'src/import.js', 'src/ui/render.js',
    ]) {
      expect(sw(), module).toContain(module);
    }
  });
});
