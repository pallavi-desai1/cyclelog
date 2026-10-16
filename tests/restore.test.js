import { describe, it, expect } from 'vitest';
import {
  BACKUP_KIND, classifyRestoreFile, parseBackupBundle, restoreBackup,
  markBackup, readLastBackup, requestPersistentStorage,
} from '../src/restore.js';
import { backupBundle, documentJson } from '../src/export.js';
import { memoryBackend, readMeta, VAULT_KEY } from '../src/store.js';
import { createVault } from '../src/unlock.js';
import { serializeDocument } from '../src/import.js';

const doc = {
  version: 1,
  days: { '2015-01-29': { flow: 'heavy', cramps: null, spotting: null, pms: false, mood: [], discharge: null, tests: { ovulation: null, pregnancy: null }, pain: [], notes: '', source: 'clue', precision: 'exact' } },
  spans: [{ start: '2015-01-29', end: '2015-02-02', precision: 'exact', endPrecision: 'exact', source: 'clue' }],
  gaps: [],
  birthControl: [],
};

// A real vault, so the restore is tested against bytes the app actually wrote
// rather than a hand-built fixture.
async function exported(passphrase = 'correct horse battery') {
  const backend = memoryBackend();
  const vault = createVault({ backend });
  await vault.setup(passphrase, serializeDocument(doc));
  return backupBundle({
    meta: await readMeta(backend),
    vault: await backend.get(VAULT_KEY),
    exportedAt: '2015-03-26',
  });
}

describe('classifyRestoreFile', () => {
  it('recognises an encrypted backup', async () => {
    expect(classifyRestoreFile(await exported())).toBe('backup');
  });

  it('recognises a plaintext data export', () => {
    expect(classifyRestoreFile(documentJson(doc))).toBe('document');
  });

  it('refuses a Clue export, which belongs in the other picker', () => {
    expect(classifyRestoreFile('[{"type":"period","date":"2016-01-02"}]')).toBe('unknown');
  });

  it('refuses the legacy text log', () => {
    expect(classifyRestoreFile('January 1st, 2015 - started')).toBe('unknown');
  });

  it('refuses anything that is not JSON at all', () => {
    expect(classifyRestoreFile('not json')).toBe('unknown');
  });

  it('refuses an empty file', () => {
    expect(classifyRestoreFile('')).toBe('unknown');
  });
});

describe('parseBackupBundle', () => {
  it('returns the key material and the sealed vault', async () => {
    const bundle = parseBackupBundle(await exported());
    expect(bundle.meta.iterations).toBe(310000);
    expect(bundle.meta.salt).toHaveLength(16);
    expect(bundle.vault.ciphertext.length).toBeGreaterThan(0);
  });

  it('refuses a file that is not a backup', () => {
    expect(() => parseBackupBundle(documentJson(doc))).toThrow(/not a .*backup/i);
  });

  it('refuses a backup whose version it does not understand', async () => {
    const future = JSON.parse(await exported());
    future.version = 99;
    expect(() => parseBackupBundle(JSON.stringify(future))).toThrow(/version 99/);
  });

  it('refuses a backup with no key material', async () => {
    const broken = JSON.parse(await exported());
    delete broken.meta;
    expect(() => parseBackupBundle(JSON.stringify(broken))).toThrow(/key material/i);
  });

  it('refuses a backup with no sealed vault', async () => {
    const broken = JSON.parse(await exported());
    delete broken.vault;
    expect(() => parseBackupBundle(JSON.stringify(broken))).toThrow(/vault/i);
  });

  it('refuses key material missing its salt', async () => {
    const broken = JSON.parse(await exported());
    delete broken.meta.salt;
    expect(() => parseBackupBundle(JSON.stringify(broken))).toThrow(/salt/i);
  });

  it('names the kind it expects, so a reader knows what went wrong', () => {
    expect(BACKUP_KIND).toBe('cyclelog-backup');
  });
});

describe('restoreBackup', () => {
  it('puts a backup onto a fresh device so the passphrase opens it', async () => {
    const text = await exported();
    const backend = memoryBackend();

    await restoreBackup(backend, parseBackupBundle(text));

    const vault = createVault({ backend });
    expect(await vault.unlock('correct horse battery')).toEqual({ ok: true });
    expect(JSON.parse(vault.read())).toEqual(doc);
  });

  it('leaves the wrong passphrase refused after a restore', async () => {
    const backend = memoryBackend();
    await restoreBackup(backend, parseBackupBundle(await exported()));
    expect(await createVault({ backend }).unlock('wrong one'))
      .toEqual({ ok: false, reason: 'wrong-passphrase' });
  });

  it('reports the vault as locked, not empty, once restored', async () => {
    const backend = memoryBackend();
    await restoreBackup(backend, parseBackupBundle(await exported()));
    expect(await createVault({ backend }).status()).toBe('locked');
  });

  it('replaces a vault that was already on the device', async () => {
    const backend = memoryBackend();
    const existing = createVault({ backend });
    await existing.setup('the old passphrase', '{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}');

    await restoreBackup(backend, parseBackupBundle(await exported()));

    const vault = createVault({ backend });
    expect(await vault.unlock('the old passphrase')).toEqual({ ok: false, reason: 'wrong-passphrase' });
    expect(await vault.unlock('correct horse battery')).toEqual({ ok: true });
  });

  it('writes the vault before the meta, so a half-restore cannot look openable', async () => {
    const order = [];
    const backend = memoryBackend();
    const watched = {
      get: backend.get,
      set: async (key, value) => { order.push(key); return backend.set(key, value); },
      delete: backend.delete,
    };
    await restoreBackup(watched, parseBackupBundle(await exported()));
    expect(order).toEqual(['vault', 'meta']);
  });
});

describe('the last-backup marker', () => {
  it('is null before any backup is taken', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', '{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}');
    expect(await readLastBackup(backend)).toBeNull();
  });

  it('round-trips the date of a backup', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', '{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}');
    await markBackup(backend, '2015-03-26');
    expect(await readLastBackup(backend)).toBe('2015-03-26');
  });

  it('keeps the key material intact when it writes the marker', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', '{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}');
    const before = await readMeta(backend);
    await markBackup(backend, '2015-03-26');
    const after = await readMeta(backend);
    expect(after.salt).toEqual(before.salt);
    expect(after.wrapped).toEqual(before.wrapped);
  });

  it('still unlocks after the marker is written', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', '{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}');
    await markBackup(backend, '2015-03-26');
    expect(await createVault({ backend }).unlock('correct horse')).toEqual({ ok: true });
  });

  it('does nothing when there is no vault to mark', async () => {
    await expect(markBackup(memoryBackend(), '2015-03-26')).resolves.toBeUndefined();
  });

  it('is null when there is no vault at all', async () => {
    expect(await readLastBackup(memoryBackend())).toBeNull();
  });
});

describe('requestPersistentStorage', () => {
  it('asks the browser to keep the vault rather than treat it as cache', async () => {
    const calls = [];
    const navigatorLike = { storage: { persisted: async () => false, persist: async () => { calls.push('persist'); return true; } } };
    expect(await requestPersistentStorage(navigatorLike)).toBe(true);
    expect(calls).toEqual(['persist']);
  });

  it('does not ask twice when the browser already granted it', async () => {
    const calls = [];
    const navigatorLike = { storage: { persisted: async () => true, persist: async () => { calls.push('persist'); return true; } } };
    expect(await requestPersistentStorage(navigatorLike)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('reports false when the browser refuses', async () => {
    const navigatorLike = { storage: { persisted: async () => false, persist: async () => false } };
    expect(await requestPersistentStorage(navigatorLike)).toBe(false);
  });

  // Safari has shipped without this API; asking must never break the app.
  it('reports false rather than throwing where the API does not exist', async () => {
    expect(await requestPersistentStorage({})).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });

  it('reports false rather than throwing when the call itself fails', async () => {
    const navigatorLike = { storage: { persisted: async () => false, persist: async () => { throw new Error('denied'); } } };
    expect(await requestPersistentStorage(navigatorLike)).toBe(false);
  });
});
