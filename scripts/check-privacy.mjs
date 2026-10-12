#!/usr/bin/env node
// Content-level privacy check. The .gitignore safety net only ever kept real
// *filenames* out of version control (private/, seed.json, measurements.json).
// It says nothing about a real date typed into a committed file by mistake —
// a hard-coded expectation, a copy-pasted fixture, a comment. This script
// greps the actual content of every git-tracked file for dates that fall in
// the real data's range, so a mistake like that cannot land silently.
//
// docs/ is excluded: those files are the repository owner's design documents
// and are being handled separately. Dates in 2015-2017 are excluded because
// that is the invented range used by synthetic test fixtures throughout the
// suite (see tests/*.test.js) and would otherwise flood this check with
// false positives.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REAL_RANGE = /(?:2018|2019|2020|2021|2022|2023|2024|2025|2026)-\d{2}-\d{2}/g;

// Load known real dates from private/expectations.json if available.
// These are the actual sensitive values and will be checked with no allowlist.
let knownRealDates = new Set();
let skippedKnownRealDateCheck = false;

try {
  const expectationsText = readFileSync('private/expectations.json', 'utf8');
  const expectations = JSON.parse(expectationsText);

  // Recursively collect all string values matching YYYY-MM-DD format.
  function collectDates(obj) {
    if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj)) {
      knownRealDates.add(obj);
    } else if (typeof obj === 'object' && obj !== null) {
      for (const value of Object.values(obj)) {
        collectDates(value);
      }
    }
  }

  collectDates(expectations);
} catch (err) {
  if (err.code === 'ENOENT') {
    skippedKnownRealDateCheck = true;
    console.log('⚠ private/expectations.json not found; skipping known-real-date check.');
  } else {
    throw err;
  }
}

// A date immediately followed by a slug and `.md` is a reference to a spec or
// plan document's filename (this project's convention is to date-stamp those
// files, e.g. `2026-10-11-cyclelog-design.md`), not a logged health date. Such
// references appear outside docs/ too — e.g. this README links to the spec.
const DOC_FILENAME = /^-[a-z0-9]+(?:-[a-z0-9]+)*\.md/;

// Known-synthetic date literals that pre-date this check and are not logged
// health data: they exercise calendar arithmetic (a leap day, a DST
// transition, a month boundary) in tests/dates.test.js's own documented edge
// cases, not period/cycle/gap/episode fixtures. Each is accounted for by the
// code comments at its use site. This is a narrow, auditable allowlist of
// exact values, not a path or file exclusion — a real date that happens not to
// be one of these literals is still caught everywhere, including this file.
const KNOWN_SYNTHETIC = new Set([
  '2021-02-28', '2021-12-31',
  '2024-02-28', '2024-02-29',
  '2026-01-31', '2026-02-01', '2026-02-28',
  '2026-03-01', '2026-03-07', '2026-03-09', '2026-03-14', '2026-03-15',
]);

// A calendar-impossible date (February 30th, month 13) cannot be a real
// logged event by construction — only src/dates.js's own test suite for
// Finding 5's calendar validation deliberately writes such strings, to prove
// parseISO rejects them. This is a shape check, not a lookup: it needs no
// allowlist entry, and it cannot hide a real date, because a real date is
// always calendar-valid. Uses the same UTC-roundtrip technique parseISO uses.
function isCalendarImpossible(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  if (month < 1 || month > 12) return true;
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).toISOString().slice(0, 10) !== iso;
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter(path => !path.startsWith('docs/'));

let hits = 0;

for (const path of files) {
  let text;
  try {
    // Read from the working tree, not the git index, so a pending edit that
    // has not been staged yet is still checked before it gets committed.
    text = readFileSync(path, 'utf8');
  } catch {
    continue; // binary or unreadable as text; not a date-leak risk
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Existing range scan
    for (const match of line.matchAll(REAL_RANGE)) {
      const date = match[0];
      const tail = line.slice(match.index + date.length);
      if (DOC_FILENAME.test(tail)) continue;
      if (KNOWN_SYNTHETIC.has(date)) continue;
      if (isCalendarImpossible(date)) continue;
      hits += 1;
      console.log(`${path}:${i + 1}`);
      break;
    }

    // New known-real-date check (no allowlist applied)
    if (knownRealDates.size > 0) {
      for (const date of knownRealDates) {
        if (line.includes(date)) {
          hits += 1;
          console.log(`${path}:${i + 1} KNOWN REAL DATE`);
          break;
        }
      }
    }
  }
}

if (hits > 0) {
  console.log(`\n${hits} potential real-date hit(s) found outside docs/.`);
  process.exit(1);
}

console.log('No real-range dates found in tracked content outside docs/.');
process.exit(0);
