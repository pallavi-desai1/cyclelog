import { seal, open } from './crypto.js';

export const VAULT_KEY = 'vault';
export const META_KEY = 'meta';

// The logic is written against this interface rather than against IndexedDB,
// because `indexedDB` does not exist in Node and a vault nobody can test is
// not a vault worth trusting. The IndexedDB adapter below is deliberately
// thin — it is the one piece verified by hand on the device.
export function memoryBackend() {
  const entries = new Map();
  return {
    async get(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

export function indexedDbBackend(dbName = 'cyclelog', storeName = 'kv') {
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const run = async (mode, operation) => {
    const database = await db;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  return {
    async get(key) {
      const value = await run('readonly', store => store.get(key));
      return value === undefined ? null : value;
    },
    // A single `put` in a single transaction: the replace is atomic, so a
    // failure cannot leave the vault half-written.
    async set(key, value) {
      await run('readwrite', store => store.put(value, key));
    },
    async delete(key) {
      await run('readwrite', store => store.delete(key));
    },
  };
}

export async function readMeta(backend) {
  return backend.get(META_KEY);
}

export async function writeMeta(backend, meta) {
  await backend.set(META_KEY, meta);
}

export async function saveDocument(backend, key, documentString) {
  const sealed = await seal(key, documentString);
  // One replace, never delete-then-put: an interrupted delete-then-put would
  // destroy the document it was meant to update.
  await backend.set(VAULT_KEY, sealed);
}

// `null` means no vault exists. A wrong key THROWS, and that distinction is
// load-bearing: swallowing it would turn a mistyped passphrase into an
// apparently empty history.
export async function loadDocument(backend, key) {
  const sealed = await backend.get(VAULT_KEY);
  if (sealed === null) return null;
  return open(key, sealed);
}

export async function eraseAll(backend) {
  await backend.delete(VAULT_KEY);
  await backend.delete(META_KEY);
}
