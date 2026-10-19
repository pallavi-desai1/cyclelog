import { describe, it, expect } from 'vitest';
import {
  EXPORT_VERSION, FILENAMES, csvCell, documentJson, daysCsv, cyclesCsv, backupBundle,
} from '../src/export.js';
import { withoutSharing } from '../src/sync/share.js';
import { buildCycles } from '../src/cycles.js';
import { createVault } from '../src/unlock.js';
import { memoryBackend, readMeta, VAULT_KEY } from '../src/store.js';

const day = (overrides = {}) => ({
  flow: null, cramps: null, spotting: null, pms: false, mood: [], discharge: null,
  tests: { ovulation: null, pregnancy: null }, pain: [], notes: '',
  source: 'clue', precision: 'exact', ...overrides,
});

const doc = {
  version: 1,
  spans: [
    { start: '2015-01-01', end: '2015-01-05', precision: 'approx', endPrecision: 'exact', source: 'legacy' },
    { start: '2015-01-29', end: '2015-02-02', precision: 'exact', endPrecision: 'exact', source: 'clue' },
    { start: '2015-02-26', end: null, precision: 'exact', endPrecision: null, source: 'manual' },
  ],
  days: {
    '2015-01-29': day({ flow: 'heavy', cramps: 'severe', mood: ['sad', 'anxious'], pms: true }),
    '2015-01-30': day({ flow: 'light', spotting: 'brown', pain: ['headache'] }),
    '2015-01-15': day({ notes: 'ran 5k, felt "fine"', source: 'manual' }),
    '2015-02-01': day({ discharge: 'creamy', tests: { ovulation: 'positive', pregnancy: 'negative' } }),
  },
  gaps: [],
  birthControl: [
    { startedOn: '2015-02-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' },
  ],
};

const rows = csv => csv.trim().split('\n');

// A real parser, not a split on commas: a quoted note containing a comma is
// exactly what this format has to survive, so the test reads it the way a
// spreadsheet would.
function cells(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; } else cell += ch;
  }
  out.push(cell);
  return out;
}

describe('the filenames the spec names', () => {
  it('are exactly those four', () => {
    expect(FILENAMES).toEqual({
      backup: 'cyclelog-backup.json',
      data: 'cyclelog-data.json',
      days: 'cyclelog-days.csv',
      cycles: 'cyclelog-cycles.csv',
    });
  });
});

describe('csvCell', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('heavy')).toBe('heavy');
    expect(csvCell(28)).toBe('28');
  });

  it('writes an empty cell for nothing', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  // A note is her own prose, so it will contain commas and quotes sooner or
  // later. An unquoted comma silently shifts every later column.
  it('quotes a value containing a comma', () => {
    expect(csvCell('ran 5k, felt fine')).toBe('"ran 5k, felt fine"');
  });

  it('doubles an embedded quote and quotes the cell', () => {
    expect(csvCell('felt "fine"')).toBe('"felt ""fine"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes booleans as true and false, which every tool parses', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
  });
});

describe('daysCsv', () => {
  const csv = () => daysCsv(doc);

  it('names every field in the header', () => {
    expect(cells(rows(csv())[0])).toEqual([
      'date', 'flow', 'cramps', 'spotting', 'pms', 'discharge',
      'ovulation_test', 'pregnancy_test', 'mood', 'pain', 'medicine', 'notes',
      'source', 'date_precision',
    ]);
  });

  it('writes one row per logged day and no more', () => {
    expect(rows(csv())).toHaveLength(1 + Object.keys(doc.days).length);
  });

  it('sorts the rows by date, so a spreadsheet opens in order', () => {
    const dates = rows(csv()).slice(1).map(line => cells(line)[0]);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe('2015-01-15');
  });

  it('carries the values of a day', () => {
    const row = rows(csv()).find(line => line.startsWith('2015-01-29'));
    expect(row).toContain('heavy');
    expect(row).toContain('severe');
    expect(row).toContain('true');
  });

  it('joins a list without breaking the column', () => {
    const row = rows(csv()).find(line => line.startsWith('2015-01-29'));
    expect(row).toContain('sad; anxious');
    expect(cells(row)).toHaveLength(14);
  });

  it('escapes a note that contains a comma and a quote', () => {
    const line = rows(csv()).find(row => row.startsWith('2015-01-15'));
    expect(line).toContain('"ran 5k, felt ""fine"""');
    // And it reads back as the one value she typed, rather than as shifted
    // columns — which is the failure this escaping exists to prevent.
    expect(cells(line)[11]).toBe('ran 5k, felt "fine"');
  });

  it('gives every row the same number of columns as the header', () => {
    const width = cells(rows(csv())[0]).length;
    for (const line of rows(csv()).slice(1)) {
      expect(cells(line), line.slice(0, 12)).toHaveLength(width);
    }
  });

  it('carries both test results in their own columns', () => {
    const row = cells(rows(csv()).find(line => line.startsWith('2015-02-01')));
    expect(row[6]).toBe('positive');
    expect(row[7]).toBe('negative');
  });

  it('says where each entry came from', () => {
    const row = cells(rows(csv()).find(line => line.startsWith('2015-01-15')));
    expect(row[12]).toBe('manual');
  });

  it('returns a header and nothing else for a document with no days', () => {
    expect(rows(daysCsv({ ...doc, days: {} }))).toHaveLength(1);
  });
});

describe('cyclesCsv', () => {
  const csv = () => cyclesCsv(buildCycles(doc));

  it('names every field in the header', () => {
    expect(cells(rows(csv())[0])).toEqual([
      'cycle_start', 'period_end', 'period_length', 'cycle_length',
      'peak_flow', 'cramp_days', 'pms_days', 'spotting_days',
      'birth_control', 'date_precision', 'source', 'excluded', 'excluded_reason',
    ]);
  });

  it('writes one row per cycle', () => {
    // Three spans make two cycles: the last period has no cycle yet.
    expect(rows(csv())).toHaveLength(1 + 2);
  });

  it('carries the lengths a clinician asks for', () => {
    const first = cells(rows(csv())[1]);
    expect(first[0]).toBe('2015-01-01');
    expect(first[2]).toBe('5');    // period length
    expect(first[3]).toBe('28');   // cycle length
  });

  it('carries the symptom aggregates', () => {
    const second = cells(rows(csv())[2]);
    expect(second[4]).toBe('heavy');   // peak flow
    expect(second[5]).toBe('1');       // cramp days
    expect(second[6]).toBe('1');       // PMS days
    expect(second[7]).toBe('1');       // spotting days
  });

  it('names the method in force at the start of the cycle', () => {
    const second = cells(rows(csv())[2]);
    expect(second[8]).toBe('');        // the first cycle predates the pill
  });

  it('marks an excluded cycle and says why', () => {
    const gapped = {
      ...doc,
      gaps: [{ from: '2015-01-10', to: '2015-01-20', reason: 'not logged' }],
    };
    const row = rows(cyclesCsv(buildCycles(gapped)))[1];
    expect(row).toContain('true');
    expect(row.toLowerCase()).toContain('gap');
  });

  it('returns a header and nothing else when there are no cycles', () => {
    expect(rows(cyclesCsv([]))).toHaveLength(1);
  });

  it('leaves a missing period end empty rather than writing null', () => {
    expect(csv()).not.toMatch(/null|undefined|NaN/);
  });
});

describe('documentJson', () => {
  it('round-trips the document exactly', () => {
    expect(JSON.parse(documentJson(doc))).toEqual(doc);
  });

  it('is indented, since she may read it herself', () => {
    expect(documentJson(doc)).toContain('\n  ');
  });
});

describe('backupBundle', () => {
  const meta = { version: 1, salt: [1, 2, 3], iterations: 310000, wrapped: { passphrase: { iv: [4], ciphertext: [5] } } };
  const vault = { iv: [6, 7], ciphertext: [8, 9, 10] };
  const bundle = () => JSON.parse(backupBundle({ meta, vault, exportedAt: '2015-03-26' }));

  it('carries the sealed vault and the key material needed to open it', () => {
    expect(bundle().meta).toEqual(meta);
    expect(bundle().vault).toEqual(vault);
  });

  it('says what it is and when it was made', () => {
    expect(bundle().kind).toBe('cyclelog-backup');
    expect(bundle().version).toBe(EXPORT_VERSION);
    expect(bundle().exportedAt).toBe('2015-03-26');
  });

  // The whole point of this file: it can sit in a Dropbox without exposing
  // anything, because only her passphrase opens it.
  it('contains no plaintext from the document', () => {
    const text = backupBundle({ meta, vault, exportedAt: '2015-03-26' });
    for (const needle of ['spans', 'days', 'birthControl', 'flow', 'heavy', '2015-01-29']) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it('says in plain words that the passphrase is the only key', () => {
    expect(bundle().note).toMatch(/passphrase/i);
  });

  it('refuses to build a backup with no vault in it', () => {
    expect(() => backupBundle({ meta, vault: null, exportedAt: '2015-03-26' })).toThrow();
  });
});

describe('sharing state never leaves in an export', () => {
  const shared = {
    ...doc,
    sharing: {
      key: 'SECRETSYNCKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      scope: 'dates',
      identity: { uid: 'anon-uid', refreshToken: 'refresh-token' },
      viewers: [{ uid: 'viewer-uid', label: 'partner', grantedAt: '2015-03-26' }],
    },
  };

  // The encrypted backup SHOULD carry it — it is her own document, sealed
  // under her own passphrase, and a restore has to bring sharing back. Built
  // from a real sealed vault (not a hand-made fake blob that never held the
  // key), so the first assertion can actually fail if sealing ever breaks.
  it('keeps it inside the encrypted backup, where only she can read it', async () => {
    const backend = memoryBackend();
    const vault = createVault({ backend });
    const passphrase = 'correct horse battery staple';
    await vault.setup(passphrase, JSON.stringify(shared));

    const meta = await readMeta(backend);
    const sealedVault = await backend.get(VAULT_KEY);
    const text = backupBundle({ meta, vault: sealedVault, exportedAt: '2015-03-26' });
    expect(text).not.toContain('SECRETSYNCKEY');   // because the vault is sealed

    // Prove it is sealing, not absence: the same passphrase that produced
    // this backup can open it and find the key still inside.
    vault.lock();
    const unlocked = await vault.unlock(passphrase);
    expect(unlocked.ok).toBe(true);
    expect(vault.read()).toContain('SECRETSYNCKEY');
  });

  // The CSVs are a different matter: they are plaintext and must not carry it.
  it('writes no sharing state into either CSV', () => {
    for (const csv of [daysCsv(shared), cyclesCsv([])]) {
      expect(csv).not.toContain('SECRETSYNCKEY');
      expect(csv).not.toContain('refresh-token');
      expect(csv).not.toContain('viewer-uid');
    }
  });

  // Critical 1 (whole-branch review): the plaintext JSON export used to
  // carry `sharing` whole — the sync key, and worse, the refresh token that
  // mints the owner's own id tokens, letting anyone holding the file write
  // her vault and grant viewers. documentJson is called at the export
  // boundary on withoutSharing(doc), never on the raw document, which is
  // what this test now pins: the export boundary strips it, not the
  // formatter itself (documentJson still round-trips whatever it is given,
  // proven above).
  it('carries neither the key nor the refresh token once the export boundary strips sharing first', () => {
    const exported = documentJson(withoutSharing(shared));
    expect(exported).not.toContain('SECRETSYNCKEY');
    expect(exported).not.toContain('refresh-token');
    expect(exported).not.toContain('viewer-uid');
    expect(JSON.parse(exported).sharing).toBeUndefined();
    // Her history must survive the strip untouched.
    expect(JSON.parse(exported).days).toEqual(shared.days);
  });

  // documentJson itself must stay a pure, honest round-trip formatter — the
  // stripping belongs at the export boundary (src/ui/app.js), not buried
  // inside the formatter where a caller could not reason about what it
  // does. Proven by exercising it directly on a document that still has
  // sharing in it, same as the very first test in this file already does.
  it('documentJson itself is a plain round-trip and does not strip anything on its own', () => {
    expect(JSON.parse(documentJson(shared)).sharing).toEqual(shared.sharing);
  });
});
