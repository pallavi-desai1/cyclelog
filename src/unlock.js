import {
  randomBytes, deriveKey, generateKey, wrapKey, unwrapKey,
  SALT_BYTES, KDF_ITERATIONS,
} from './crypto.js';
import {
  readMeta, writeMeta, saveDocument, loadDocument, eraseAll,
} from './store.js';

export const IDLE_LOCK_MS = 5 * 60 * 1000;
export const VAULT_VERSION = 1;

export function createVault({ backend, now = () => Date.now(), idleMs = IDLE_LOCK_MS }) {
  // A random data key encrypts the document. The passphrase only wraps that
  // key, so Face ID can be a second wrapping of the same key and a passphrase
  // change re-wraps rather than re-encrypting years of history.
  let dataKey = null;
  let plaintext = null;
  let lastTouch = 0;

  const lock = () => {
    dataKey = null;
    plaintext = null;
  };

  const requireUnlocked = () => {
    if (dataKey === null) throw new Error('vault is locked');
  };

  const requireMeta = async () => {
    const meta = await readMeta(backend);
    if (meta === null) throw new Error('no vault exists');
    return meta;
  };

  // Shared by both unlock paths: the key is already proved correct, so
  // anything that fails here is corruption and must throw.
  const adopt = async (key) => {
    const text = await loadDocument(backend, key);
    if (text === null) throw new Error('vault document is missing');
    dataKey = key;
    plaintext = text;
    lastTouch = now();
    return { ok: true };
  };

  return {
    async status() {
      if (dataKey !== null) return 'unlocked';
      return (await readMeta(backend)) === null ? 'empty' : 'locked';
    },

    async setup(passphrase, documentString) {
      if ((await readMeta(backend)) !== null) throw new Error('a vault already exists');

      const salt = randomBytes(SALT_BYTES);
      const key = await generateKey();
      const passphraseKey = await deriveKey(passphrase, salt, KDF_ITERATIONS);

      // Document first: if the meta write fails, the store still looks empty
      // and setup can be retried. The reverse order would leave a vault that
      // reports 'locked' with nothing inside it.
      await saveDocument(backend, key, documentString);
      await writeMeta(backend, {
        version: VAULT_VERSION,
        salt: [...salt],
        iterations: KDF_ITERATIONS,
        wrapped: { passphrase: await wrapKey(passphraseKey, key) },
      });

      dataKey = key;
      plaintext = documentString;
      lastTouch = now();
    },

    async unlock(passphrase) {
      const meta = await readMeta(backend);
      if (meta === null) return { ok: false, reason: 'empty' };

      const passphraseKey = await deriveKey(
        passphrase, new Uint8Array(meta.salt), meta.iterations,
      );

      let key;
      try {
        key = await unwrapKey(passphraseKey, meta.wrapped.passphrase);
      } catch {
        // The ONLY swallowed failure in this module, and only this one line:
        // an unwrap that fails means the passphrase was wrong.
        return { ok: false, reason: 'wrong-passphrase' };
      }
      return adopt(key);
    },

    async unlockWithKey(name, wrappingKey) {
      const meta = await readMeta(backend);
      if (meta === null) return { ok: false, reason: 'empty' };
      const wrapped = meta.wrapped[name];
      if (!wrapped) return { ok: false, reason: 'not-enrolled' };

      let key;
      try {
        key = await unwrapKey(wrappingKey, wrapped);
      } catch {
        return { ok: false, reason: 'wrong-key' };
      }
      return adopt(key);
    },

    async enrollWrapping(name, wrappingKey) {
      requireUnlocked();
      const meta = await requireMeta();
      meta.wrapped[name] = await wrapKey(wrappingKey, dataKey);
      await writeMeta(backend, meta);
    },

    async changePassphrase(nextPassphrase) {
      requireUnlocked();
      const meta = await requireMeta();
      const salt = randomBytes(SALT_BYTES);
      const passphraseKey = await deriveKey(nextPassphrase, salt, KDF_ITERATIONS);
      meta.salt = [...salt];
      meta.iterations = KDF_ITERATIONS;
      meta.wrapped.passphrase = await wrapKey(passphraseKey, dataKey);
      await writeMeta(backend, meta);
    },

    lock,

    read() {
      return plaintext;
    },

    async save(documentString) {
      requireUnlocked();
      // dataKey is captured before the write, not read again after it: a
      // lock arriving while saveDocument is in flight sets dataKey to null,
      // and writing the decrypted document back into `plaintext` after that
      // would put it back in memory on top of a lock that has nothing to do
      // with this save. The write to storage still completes either way —
      // the vault is the authority — only this module's own memory declines
      // to come back.
      const key = dataKey;
      await saveDocument(backend, key, documentString);
      if (dataKey !== key) return;
      plaintext = documentString;
      lastTouch = now();
    },

    touch() {
      lastTouch = now();
    },

    maybeIdleLock() {
      if (dataKey === null) return false;
      if (now() - lastTouch < idleMs) return false;
      lock();
      return true;
    },

    async erase() {
      lock();
      await eraseAll(backend);
    },
  };
}
