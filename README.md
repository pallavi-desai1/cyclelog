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

## If you lose the phone

Download **`cyclelog-backup.json`** from the app and keep it somewhere you can
reach from another device — iCloud Drive, Dropbox, email to yourself. It is
encrypted with a key derived from the passphrase, so a cloud copy exposes
nothing; that is what the format is for.

To restore: open the app on the new device, pick that file in **"CycleLog
backup or data export"** on the setup screen, and type the passphrase the
backup was made with. Everything comes back.

Two things no backup can save you from:

- **A forgotten passphrase.** There is no reset, no recovery and no key
  escrow — the backup needs the same passphrase. Keep it in a password
  manager.
- **No backup at all.** The vault lives only in the browser storage of the
  device it was created on. Clearing website data, deleting the home-screen
  icon, or losing the phone takes it with them.

The app asks the browser for persistent storage so the vault is not treated as
cache, but that is a request the browser may refuse.

## Running the app

```bash
npm run serve   # python3 -m http.server 8000
```

Open `http://localhost:8000` — `localhost` is a secure context, so Web Crypto
and WebAuthn both work there. (A plain LAN IP is not a secure context, so the
app cannot be exercised that way; the phone pass happens after publishing.)

First run shows a setup screen: choose a passphrase and, optionally, pick the
Clue export and/or the legacy `.txt` log to import. Every later run shows a
lock screen instead.

**Encryption.** The passphrase is run through PBKDF2-SHA-256 at 310,000
iterations to derive a key that wraps a random AES-256-GCM data key; the data
key encrypts the document. The passphrase itself is never stored, and because
it is never stored **it cannot be recovered** — losing it means losing access
to the vault.

**Face ID.** On a supported device, the app offers to enroll a platform
passkey using the WebAuthn PRF extension, and uses its output as a second
wrapping of the same data key. If the device or browser does not support PRF,
or the enrollment is declined, the app falls back to the passphrase silently —
no error is shown, and the Face ID button simply does not appear.

**Remaining verification.** Desktop Safari and Chrome at `localhost` exercise
every code path, but the iPhone pass — installing to the home screen, Face ID
on that device, and the portrait layout — happens after the app is published
to GitHub Pages, since a secure context is required and a LAN address does
not qualify.

**No backup yet, and no erase button yet.** The export screen (spec §9) is a
later plan's scope. Until it ships, this app has no way to get your history
back out once it is in the vault, and no in-app way to erase or reset it.
Keep the original Clue export and the legacy `.txt` log somewhere safe — the
passphrase is the only key, and without it the vault cannot be opened or
recovered, so those source files are the only backup you have in the
meantime. If the vault is ever wrong, or you forget the passphrase, there is
no reset button in the app yet: clear the site's data for this page from
Safari's settings (Settings → Safari → Advanced → Website Data, or Settings →
Apps → Safari → Advanced → Website Data on newer iOS), then reload the page
and set it up again from your kept source files.

## Design documents

- Spec: `docs/superpowers/specs/2026-10-11-cyclelog-design.md`
- Plans: `docs/superpowers/plans/`

## Architecture

Zero runtime dependencies, native ES modules, no build step. Vitest is the only
dev dependency. Every module under `src/` is pure: data in, data out, no I/O and
no DOM, which is what makes years of history testable in Node.

Dates are `YYYY-MM-DD` strings everywhere and all arithmetic goes through
`src/dates.js`, which is UTC-based — local-time date math silently shifts logged
dates by a day.
