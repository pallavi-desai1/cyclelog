import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = relative => readFileSync(join(root, relative), 'utf8');

const html = () => read('index.html');
const sw = () => read('sw.js');
const css = () => read('src/ui/theme.css');
const manifest = () => JSON.parse(read('manifest.webmanifest'));

// Every .js under src/, as paths relative to the repo root.
function moduleFiles(dir = 'src') {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? moduleFiles(`${dir}/${entry.name}`)
      : (entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []));
}

function precacheList() {
  const match = sw().match(/const PRECACHE = \[([^\]]*)\]/);
  return match[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

describe('content security policy', () => {
  const policy = () => html().match(/content="([^"]*default-src[^"]*)"/)[1];

  it('is declared in the page', () => {
    expect(html()).toContain('http-equiv="Content-Security-Policy"');
  });

  it('denies everything it does not explicitly allow', () => {
    expect(policy()).toContain("default-src 'none'");
  });

  it('allows scripts, styles and the manifest only from this origin', () => {
    for (const directive of ['script-src', 'style-src', 'manifest-src', 'connect-src']) {
      expect(policy()).toMatch(new RegExp(`${directive} 'self'`));
    }
  });

  it('names no external host and no wildcard', () => {
    expect(policy()).not.toMatch(/https?:\/\//);
    expect(policy()).not.toContain('*');
  });

  it('forbids inline script and eval', () => {
    expect(policy()).not.toContain('unsafe-inline');
    expect(policy()).not.toContain('unsafe-eval');
  });

  it('pins the form and base targets shut', () => {
    expect(policy()).toContain("base-uri 'none'");
    expect(policy()).toContain("form-action 'none'");
  });
});

describe('index.html', () => {
  it('loads no resource from another origin', () => {
    expect(html()).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  // The CSP forbids inline script, so an inline handler would silently do
  // nothing — a bug that looks like a dead button.
  it('uses no inline event handlers', () => {
    expect(html()).not.toMatch(/\son[a-z]+=/i);
  });

  it('contains no inline script body', () => {
    expect(html()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
  });

  it('loads the app as a module', () => {
    expect(html()).toMatch(/<script type="module" src="src\/ui\/app\.js"><\/script>/);
  });

  it('links the stylesheet and the manifest', () => {
    expect(html()).toContain('href="src/ui/theme.css"');
    expect(html()).toContain('href="manifest.webmanifest"');
  });

  it('declares an apple-touch-icon, which is how iOS gets a home screen icon', () => {
    expect(html()).toContain('rel="apple-touch-icon"');
    expect(html()).toContain('icons/icon-180.png');
  });

  it('fills the notch and blocks the pinch-zoom-on-input jump', () => {
    const viewport = html().match(/name="viewport" content="([^"]*)"/)[1];
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).toContain('width=device-width');
  });

  it('carries the lock screen markup the app will drive', () => {
    for (const id of ['lock', 'passphrase', 'unlock', 'faceid', 'lock-error', 'app']) {
      expect(html()).toContain(`id="${id}"`);
    }
  });
});

describe('manifest', () => {
  it('names the app', () => {
    expect(manifest().name).toBe('CycleLog');
    expect(manifest().short_name).toBe('CycleLog');
  });

  it('opens standalone from a relative start url', () => {
    expect(manifest().display).toBe('standalone');
    expect(manifest().start_url).toBe('./');
    expect(manifest().scope).toBe('./');
  });

  it('uses the palette background as its theme colour', () => {
    expect(manifest().theme_color).toBe('#FFF5F8');
    expect(manifest().background_color).toBe('#FFF5F8');
  });

  it('declares icons that exist and are the size they claim', () => {
    for (const icon of manifest().icons) {
      const path = join(root, icon.src);
      expect(existsSync(path), icon.src).toBe(true);
      const bytes = readFileSync(path);
      expect([...bytes.subarray(1, 4)].map(b => String.fromCharCode(b)).join('')).toBe('PNG');
      // IHDR width and height live at bytes 16-23.
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe('theme', () => {
  it('defines every light token from the spec', () => {
    const tokens = {
      '--bg': '#FFF5F8', '--surface': '#FFFFFF', '--border': '#FBCEDC',
      '--text': '#3A2630', '--heading': '#A62E5C', '--interactive': '#D4517E',
      '--flow-light': '#FBCEDC', '--flow-medium': '#F08CAE', '--flow-heavy': '#C83D6B',
      '--baseline': '#B9A4D4', '--positive': '#3F8F86', '--spotting': '#A9705B',
      '--warning': '#B06A1F',
    };
    for (const [token, value] of Object.entries(tokens)) {
      expect(css()).toContain(`${token}: ${value}`);
    }
  });

  it('lifts the accents in dark mode', () => {
    expect(css()).toContain('prefers-color-scheme: dark');
    for (const value of ['#1A1016', '#241820', '#F7E6EC', '#F7AFC8', '#E8799C', '#C9B6E4']) {
      expect(css()).toContain(value);
    }
  });

  it('respects a reduced-motion preference', () => {
    expect(css()).toContain('prefers-reduced-motion: reduce');
  });

  it('sets the 44px tap target as a token', () => {
    expect(css()).toContain('--tap: 44px');
  });
});

describe('service worker', () => {
  it('versions its cache name', () => {
    expect(sw()).toMatch(/const CACHE_VERSION = '[^']+'/);
    expect(sw()).toMatch(/const CACHE_NAME = `cyclelog-\$\{CACHE_VERSION\}`/);
  });

  // Review Focus 5: a module left out of the precache list is a module the
  // app cannot load offline — and one the cache will keep serving stale if
  // it was cached under an older name.
  it('precaches every module under src/', () => {
    const precached = precacheList();
    for (const file of moduleFiles()) {
      expect(precached, file).toContain(file);
    }
  });

  it('precaches the page, the manifest, the stylesheet and the icons', () => {
    const precached = precacheList();
    for (const asset of [
      './', 'index.html', 'manifest.webmanifest', 'src/ui/theme.css',
      'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
    ]) {
      expect(precached, asset).toContain(asset);
    }
  });

  it('precaches nothing that does not exist', () => {
    for (const asset of precacheList()) {
      if (asset === './') continue;
      expect(existsSync(join(root, asset)), asset).toBe(true);
    }
  });

  it('deletes caches from older versions on activate', () => {
    expect(sw()).toContain('caches.delete');
    expect(sw()).toContain('clients.claim');
  });

  it('takes over immediately rather than waiting for every tab to close', () => {
    expect(sw()).toContain('skipWaiting');
  });

  it('never caches a response it did not fetch from this origin', () => {
    expect(sw()).toContain('new URL(request.url).origin');
  });
});

describe('boot module', () => {
  const app = () => read('src/ui/app.js');

  it('registers the service worker at the app scope', () => {
    expect(app()).toContain("register('sw.js'");
    expect(app()).toContain("scope: './'");
  });

  // Vitest, and any browser without service workers, must not crash on import.
  it('guards on service worker support', () => {
    expect(app()).toContain("'serviceWorker' in navigator");
  });

  it('imports only relative modules', () => {
    for (const [, specifier] of app().matchAll(/from '([^']+)'/g)) {
      expect(specifier.startsWith('.'), specifier).toBe(true);
    }
  });
});
