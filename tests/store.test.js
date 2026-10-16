import { describe, it, expect } from 'vitest';
import { generateKey, randomBytes, SALT_BYTES } from '../src/crypto.js';
import {
  VAULT_KEY, META_KEY, memoryBackend,
  readMeta, writeMeta, saveDocument, loadDocument, eraseAll,
} from '../src/store.js';

const DOC = JSON.stringify({ version: 1, spans: [{ start: '2015-01-01' }], days: {} });

describe('memoryBackend', () => {
  it('returns null for a key never written', async () => {
    expect(await memoryBackend().get('nothing')).toBeNull();
  });

  it('round-trips a value', async () => {
    const backend = memoryBackend();
    await backend.set('k', { a: 1 });
    expect(await backend.get('k')).toEqual({ a: 1 });
  });

  it('replaces rather than merging', async () => {
    const backend = memoryBackend();
    await backend.set('k', { a: 1 });
    await backend.set('k', { b: 2 });
    expect(await backend.get('k')).toEqual({ b: 2 });
  });

  it('deletes', async () => {
    const backend = memoryBackend();
    await backend.set('k', 1);
    await backend.delete('k');
    expect(await backend.get('k')).toBeNull();
  });
});

describe('meta', () => {
  it('is null before anything is written', async () => {
    expect(await readMeta(memoryBackend())).toBeNull();
  });

  it('round-trips the non-secret key material', async () => {
    const backend = memoryBackend();
    const meta = { version: 1, salt: [...randomBytes(SALT_BYTES)], iterations: 310000 };
    await writeMeta(backend, meta);
    expect(await readMeta(backend)).toEqual(meta);
  });
});

describe('saveDocument and loadDocument', () => {
  it('round-trips a document through the store', async () => {
    const backend = memoryBackend();
    const key = await generateKey();
    await saveDocument(backend, key, DOC);
    expect(await loadDocument(backend, key)).toBe(DOC);
  });

  // Review Focus 1: "no vault yet" and "wrong passphrase" are different
  // answers, and conflating them would present years of history as a
  // fresh install.
  it('returns null when no vault has been written', async () => {
    expect(await loadDocument(memoryBackend(), await generateKey())).toBeNull();
  });

  it('throws when a vault exists but the key is wrong', async () => {
    const backend = memoryBackend();
    await saveDocument(backend, await generateKey(), DOC);
    await expect(loadDocument(backend, await generateKey())).rejects.toThrow();
  });

  it('stores nothing recognisable from the document', async () => {
    const backend = memoryBackend();
    await saveDocument(backend, await generateKey(), DOC);
    const stored = JSON.stringify(await backend.get(VAULT_KEY));
    for (const needle of ['version', 'spans', 'start', '2015', 'days']) {
      expect(stored).not.toContain(needle);
    }
  });

  it('writes only under the vault key', async () => {
    const backend = memoryBackend();
    await saveDocument(backend, await generateKey(), DOC);
    expect(await backend.get(VAULT_KEY)).not.toBeNull();
    expect(await backend.get(META_KEY)).toBeNull();
  });

  it('overwrites a previous document', async () => {
    const backend = memoryBackend();
    const key = await generateKey();
    await saveDocument(backend, key, DOC);
    await saveDocument(backend, key, '{"version":1,"spans":[]}');
    expect(await loadDocument(backend, key)).toBe('{"version":1,"spans":[]}');
  });

  // Review Focus 4: a failed write must leave the previous vault readable. The
  // store replaces in a single backend `set`; a delete-then-put would destroy
  // the document if it failed in between.
  it('leaves the previous document intact when a write fails', async () => {
    const backend = memoryBackend();
    const key = await generateKey();
    await saveDocument(backend, key, DOC);

    const failing = {
      ...backend,
      set: async () => { throw new Error('storage full'); },
    };
    await expect(saveDocument(failing, key, '{"version":1,"spans":[]}')).rejects.toThrow('storage full');
    expect(await loadDocument(backend, key)).toBe(DOC);
  });

  it('never deletes before writing', async () => {
    // A delete-then-put implementation would record a delete here.
    const calls = [];
    const backend = memoryBackend();
    const spy = {
      get: backend.get,
      set: async (k, v) => { calls.push(['set', k]); return backend.set(k, v); },
      delete: async (k) => { calls.push(['delete', k]); return backend.delete(k); },
    };
    await saveDocument(spy, await generateKey(), DOC);
    expect(calls.map(([verb]) => verb)).toEqual(['set']);
  });
});

describe('eraseAll', () => {
  it('removes both the vault and the meta', async () => {
    const backend = memoryBackend();
    const key = await generateKey();
    await writeMeta(backend, { version: 1, salt: [1, 2, 3], iterations: 1000 });
    await saveDocument(backend, key, DOC);

    await eraseAll(backend);

    expect(await readMeta(backend)).toBeNull();
    expect(await loadDocument(backend, key)).toBeNull();
  });

  it('is safe to call on an empty store', async () => {
    await expect(eraseAll(memoryBackend())).resolves.toBeUndefined();
  });

  // Review Focus 6: a failure partway through must leave the store in a
  // state setup can recover from. Deleting the vault first and meta second
  // leaves 'locked' (meta present, vault gone) on a mid-failure — a status
  // that reports an openable-looking vault with nothing inside it. Meta
  // first leaves 'empty' instead, which setup already knows how to recover.
  it('leaves a recoverable state when the second delete fails', async () => {
    const backend = memoryBackend();
    const key = await generateKey();
    await writeMeta(backend, { version: 1, salt: [1, 2, 3], iterations: 1000 });
    await saveDocument(backend, key, DOC);

    let calls = 0;
    const failing = {
      ...backend,
      delete: async (k) => {
        calls += 1;
        if (calls === 2) throw new Error('storage unavailable');
        return backend.delete(k);
      },
    };

    await expect(eraseAll(failing)).rejects.toThrow('storage unavailable');
    // Meta must be gone even though the overall call failed, so status()
    // reports 'empty' (recoverable by setup) rather than 'locked' (a vault
    // that looks present but cannot be opened).
    expect(await readMeta(backend)).toBeNull();
  });
});
