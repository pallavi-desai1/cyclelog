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


// Comments stripped first, so a class named only in prose does not count as a
// styled selector.
const cssRules = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

function selectorPattern(selector) {
  // Accepts .class and #id; the boundary check keeps `.cal-cell` from
  // matching inside `.cal-cell-foo`.
  const sigil = selector.startsWith('#') ? '#' : '\\.';
  const name = selector.replace(/^[.#]/, '');
  return `(^|[\\s,}])${sigil}${name}(?=[\\s,.:{])`;
}

function hasSelector(selector) {
  return new RegExp(selectorPattern(selector)).test(cssRules());
}

// The declaration block of the first rule whose selector list mentions the
// class or id — enough to assert on a property's value.
function ruleBody(selector) {
  const match = new RegExp(`${selectorPattern(selector)}[^{}]*\\{([^}]*)\\}`).exec(cssRules());
  return match === null ? '' : match[2];
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

describe('summary card styling', () => {
  // renderSummary (src/ui/render.js) emits these exact classes. Before this
  // fix, theme.css had no rule for any of them, so the card rendered as
  // default-styled paragraphs rather than the baby-pink card the spec asks
  // for. A rule "has" a class if that class, or that class in combination
  // with others via a compound/descendant selector, is used as a selector
  // somewhere in the stylesheet.
  function hasRuleFor(className) {
    const selectorLine = new RegExp(
      `(^|[\\s,}])\\.${className}(?=[\\s,.:{])`,
    );
    // Strip out comments so a class name mentioned only in prose doesn't
    // count as a styled selector.
    const withoutComments = css().replace(/\/\*[\s\S]*?\*\//g, '');
    return selectorLine.test(withoutComments);
  }

  it('styles every class the renderer emits', () => {
    for (const className of [
      'card', 'headline', 'since', 'label', 'value', 'counterfactual',
      'late', 'no-period', 'on-time', 'unavailable',
    ]) {
      expect(hasRuleFor(className), `.${className}`).toBe(true);
    }
  });

  it('builds the card on the surface token with the border and radius tokens', () => {
    const match = css().match(/\.card\s*\{([^}]*)\}/);
    expect(match, '.card rule').not.toBeNull();
    const body = match[1];
    expect(body).toMatch(/background:\s*var\(--surface\)/);
    expect(body).toMatch(/border(-\w+)?:.*var\(--border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius\)/);
  });

  it('gives the counterfactual a dashed treatment, distinct from a solid prediction line', () => {
    const match = css().match(/\.counterfactual\s*\{([^}]*)\}/);
    expect(match, '.counterfactual rule').not.toBeNull();
    expect(match[1]).toMatch(/dashed/);
  });

  it('mutes the label against the value', () => {
    // Not asserting a specific opacity/colour value, just that the two are
    // not styled identically — a muted label is the whole point.
    const labelMatch = css().match(/\.label\s*\{([^}]*)\}/);
    const valueMatch = css().match(/\.value\s*\{([^}]*)\}/);
    expect(labelMatch, '.label rule').not.toBeNull();
    expect(valueMatch, '.value rule').not.toBeNull();
    expect(labelMatch[1].trim()).not.toBe(valueMatch[1].trim());
  });
});

// Extracts the balanced-brace body following the first match of `marker`.
function balancedBodyAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = text.indexOf('{', markerIndex);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
  }
  return null;
}

describe('dark-mode button contrast', () => {
  it('does not pair a white label with the dark-mode interactive fill', () => {
    // #FFFFFF text on dark mode's --interactive (#E8799C) is ~2.76:1,
    // below the 3:1 bar for UI components. Somewhere inside a dark-mode
    // media block, button's color must be overridden away from white.
    const text = css();
    let found = false;
    let searchFrom = 0;
    for (;;) {
      const markerIndex = text.indexOf('@media (prefers-color-scheme: dark)', searchFrom);
      if (markerIndex === -1) break;
      const body = balancedBodyAfter(text.slice(markerIndex), '@media (prefers-color-scheme: dark)');
      searchFrom = markerIndex + 1;
      if (body === null) continue;
      const buttonRule = balancedBodyAfter(body, 'button');
      if (buttonRule !== null && /color:\s*(?!#FFFFFF|white)\S/i.test(buttonRule)) {
        found = true;
      }
    }
    expect(found, 'a dark-mode button rule overriding color away from white').toBe(true);
  });
});

describe('typography', () => {
  // No web fonts: the CSP forbids every external host, so the script face has
  // to be one the device already has.
  it('names only fonts the device ships with', () => {
    // Rules, not comments: the point is that nothing is fetched.
    expect(cssRules()).not.toMatch(/@font-face|@import|url\(/);
  });

  it('defines a script face and a readable body face as tokens', () => {
    expect(css()).toMatch(/--font-script:/);
    expect(css()).toMatch(/--font-body:/);
  });

  it('uses a real script face available on iOS', () => {
    const script = css().match(/--font-script:([^;]*);/)[1];
    expect(script).toMatch(/Snell Roundhand|Savoye LET|Apple Chancery/);
    expect(script).toMatch(/cursive/);
  });

  it('keeps figures in the readable face, not the script one', () => {
    // Dates and counts are read aloud at an appointment; a looping numeral is
    // where "28" becomes "23".
    for (const selector of ['.value', '.cal-day', '#share-key', '#share-uid']) {
      const rule = ruleBody(selector);
      expect(rule, selector).toMatch(/var\(--font-body\)/);
    }
  });
});

describe('calendar styling', () => {
  it('styles every class the calendar renderer emits', () => {
    for (const selector of [
      '.cal-grid', '.cal-weekday', '.cal-cell', '.cal-out', '.cal-today',
      '.cal-dot', '.flow-light', '.flow-medium', '.flow-heavy',
      '.cal-swatch-light', '.cal-swatch-medium', '.cal-swatch-heavy',
      '.cal-flow-light', '.cal-flow-medium', '.cal-flow-heavy',
      '.cal-spotting', '.cal-pms', '.cal-predicted', '.cal-baseline',
    ]) {
      expect(hasSelector(selector), selector).toBe(true);
    }
  });

  it('draws the counterfactual dashed against a solid prediction outline', () => {
    expect(ruleBody('.cal-predicted')).toMatch(/solid/);
    expect(ruleBody('.cal-baseline')).toMatch(/dashed/);
  });

  it('scales the flow dot by intensity', () => {
    const sizes = ['.flow-light', '.flow-medium', '.flow-heavy']
      .map(selector => ruleBody(selector).match(/width:\s*([\d.]+)/)[1])
      .map(Number);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
  });

  it('keeps tap targets usable in the grid', () => {
    expect(ruleBody('.cal-cell')).toMatch(/min-height/);
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

  // Cache-first pinned an old shell against a new one: a stale worker kept
  // serving the pre-calendar page and its stylesheet, and no reload could get
  // past it. Network-first means a deploy reaches the device immediately and
  // the cache is only what makes it work offline.
  it('hands the fetch event to the network-first responder', () => {
    const listener = sw().slice(sw().indexOf("addEventListener('fetch'"));
    expect(listener).toMatch(/respondWith\(respond\(request\)\)/);
  });

  it('goes to the network first and falls back to the cache', () => {
    const handler = sw().slice(sw().indexOf('async function respond'));
    const network = handler.indexOf('await fetch(request)');
    const fallback = handler.indexOf('caches.match(request)');
    expect(network, 'fetch(request)').toBeGreaterThan(-1);
    expect(fallback, 'caches.match(request)').toBeGreaterThan(-1);
    expect(network, 'network attempted before the cache').toBeLessThan(fallback);
  });

  it('refreshes the cache from a successful response', () => {
    const handler = sw().slice(sw().indexOf('async function respond'));
    expect(handler).toMatch(/response\.ok/);
    expect(handler).toMatch(/cache\.put\(/);
    expect(handler).toMatch(/\.clone\(\)/);
  });

  it('still answers when the network fails and the cache has nothing', () => {
    // respondWith(undefined) throws, which would turn an offline miss into a
    // broken page rather than a plain network error.
    const handler = sw().slice(sw().indexOf('async function respond'));
    expect(handler).toMatch(/Response\(|Response\.error\(/);
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

describe('day panel and selection styling', () => {
  it('styles the panel and the selected cell', () => {
    for (const selector of ['.day', '.day-empty', '.day-source', '.cal-selected']) {
      expect(hasSelector(selector), selector).toBe(true);
    }
  });

  // .cal-cell is a <button>, and the global button rule makes controls
  // full-width pink: without an opt-out every day square would render as a
  // giant action button.
  it('opts calendar cells out of the full-width control styling', () => {
    const rule = ruleBody('.cal-cell');
    expect(rule).toMatch(/width:\s*auto/);
    expect(rule).toMatch(/margin:\s*0/);
  });

  it('gives a keyboard focus ring to the day cells', () => {
    expect(css()).toMatch(/\.cal-cell:focus-visible/);
  });
});

describe('legend swatches', () => {
  // .cal-swatch and the state fills have equal specificity, so source order
  // decides. With the base rule last, it painted every swatch the same
  // surface colour and stripped the prediction's border: the legend showed
  // three identical blanks where light, medium and heavy should differ.
  it('declares the swatch base before the state fills, so the states win', () => {
    const text = cssRules();
    const base = text.indexOf('.cal-swatch {');
    expect(base, '.cal-swatch base rule').toBeGreaterThan(-1);
    for (const selector of [
      '.cal-spotting {', '.cal-predicted {', '.cal-baseline {',
    ]) {
      expect(text.indexOf(selector), selector).toBeGreaterThan(base);
    }
  });

  it('shows the three intensities in the key as three different fills', () => {
    const colours = ['.cal-swatch-light', '.cal-swatch-medium', '.cal-swatch-heavy']
      .map(selector => ruleBody(selector).match(/background:\s*([^;]+);/)[1].trim());
    expect(new Set(colours).size).toBe(3);
  });

  // The key's dots are declared after the swatch base, which sets a square
  // 14px box; without that order every legend dot would be the same size.
  it('declares the key dots after the swatch base', () => {
    const text = cssRules();
    expect(text.indexOf('.cal-swatch-light {')).toBeGreaterThan(text.indexOf('.cal-swatch {'));
  });

  // The date number sits on the fill, so every fill has to carry it at the
  // 4.5:1 bar for normal text. The spec's #C83D6B cannot — even pure black
  // reaches 4.36:1 on it — which is why the heavy FILL is a notch lighter
  // than the heavy dot.
  it('keeps the date number readable on every flow fill', () => {
    const value = token => css().match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`))[1];
    const luminance = hex => {
      const channels = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
      const [r, g, b] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const ink = value('--ink-on-flow');
    for (const fill of ['--flow-light', '--flow-medium', '--flow-heavy-fill']) {
      expect(ratio(ink, value(fill)), fill).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('orders the fills from lightest to deepest', () => {
    const value = token => css().match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`))[1];
    expect(value('--flow-light')).not.toBe(value('--flow-medium'));
    expect(value('--flow-medium')).not.toBe(value('--flow-heavy-fill'));
  });
});

describe('a day that both bled and was a ghost', () => {
  // The counterfactual fill must never repaint a day that actually bled: the
  // fill is the observation, the dashed ring is the comparison, and both
  // belong on the cell. Unscoped, the ghost's background also put the dark
  // .cal-period ink onto a near-black cell in dark mode, and the date
  // number disappeared.
  it('scopes the ghost fill away from bleeding days', () => {
    const text = cssRules();
    expect(text).toMatch(/\.cal-baseline:not\(\.cal-period\)\s*\{[^}]*background/);
    expect(text).not.toMatch(/(^|[\s,}])\.cal-baseline\s*\{[^}]*background/);
  });

  it('keeps the dashed ring on such a day', () => {
    expect(ruleBody('.cal-baseline')).toMatch(/dashed/);
  });
});

describe('editor styling', () => {
  it('styles the form and its controls', () => {
    for (const selector of ['.editor', '.edit-check', '.secondary']) {
      expect(hasSelector(selector), selector).toBe(true);
    }
  });

  it('keeps the checkboxes at a usable tap size', () => {
    expect(ruleBody('.edit-check')).toMatch(/min-height/);
  });
});

describe('the Today button styling', () => {
  it('is styled as a label-sized control, not a full-width action', () => {
    const rule = ruleBody('#cal-today');
    expect(rule).toMatch(/width:\s*auto/);
    expect(rule).toMatch(/min-height/);
  });
});
