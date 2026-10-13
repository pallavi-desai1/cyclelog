# CycleLog

A private, offline-first period tracker. All health data is stored on the owner's
device; this repository contains application code only.

**No personal data is in this repository, and none ever will be.** The owner's
Clue export, text log, generated `seed.json`, and all exports are gitignored.
Every committed test fixture is synthetic and invented.

## Status

Plan 1 of 4 complete: the data foundation (importers, merge, cycles, statistics).
Prediction, the app itself, and partner sync follow.

## Development

```bash
npm install
npm test
```

### Predictions

```bash
npm run predict            # uses today's date
npm run predict -- private/measurements.json private/legacy_periods.txt 2027-06-01
```

The report leads with a status rather than a date: `upcoming`, `N days late`, or
`no period expected` once a prediction is more than three days past on a method
expected to suppress bleeding. In that state no confidence percentage is shown —
a date asserted at low confidence is less useful than naming the expectation.

Prints the baseline model (what the natural cycle would do), the adapted model
(what it is actually doing on the current method), and the per-cycle divergence
between them. The script asserts only universal invariants — confidence within
0–100, no `NaN`, no prediction in the past — never any specific figure, so it
carries no personal data.

## Importing the owner's history

Place the source files under `private/` (gitignored), then:

```bash
node scripts/build-seed.mjs          # writes seed.json
node scripts/verify-real-import.mjs  # asserts the known-correct counts
```

`verify-real-import.mjs` compares the import against expected span counts,
cycle counts, and cycle-length statistics held in `private/expectations.json`
— a gitignored file that is not part of this repository. Those expectations
were derived from the owner's source export once, by hand, before any of
these importers existed, so the check is independent of the code it verifies.
A user who wants to run this script against their own data must create their
own `private/expectations.json` with the shape the script expects. If a run
fails a check, the importer is wrong, not the expectation — the expectations
file must never be edited to make a failing run pass.

## Design documents

- Spec: `docs/superpowers/specs/2026-10-11-cyclelog-design.md`
- Plans: `docs/superpowers/plans/`

## Architecture

Zero runtime dependencies, native ES modules, no build step. Vitest is the only
dev dependency. Every module under `src/` is pure: data in, data out, no I/O and
no DOM, which is what makes nine years of history testable in Node.

Dates are `YYYY-MM-DD` strings everywhere and all arithmetic goes through
`src/dates.js`, which is UTC-based — local-time date math silently shifts logged
dates by a day.
