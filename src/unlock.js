import {
  randomBytes, deriveKey, generateKey, wrapKey, unwrapKey,
  SALT_BYTES, KDF_ITERATIONS,
} from './crypto.js';
import {
  readMeta, writeMeta, mutateMeta, saveDocument, loadDocument, eraseAll,
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
        // One of exactly two swallowed failures in this module — the other is
        // the identical unwrap in verifyPassphrase, which answers the same
        // question without unlocking. Both swallow for the same reason: an
        // unwrap that fails means the passphrase was wrong. Nothing else in
        // this file may hide an error.
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

    // Through mutateMeta so this cannot interleave with a passphrase change
    // on the same screen: the two both read, modify and write meta, and
    // whichever read first used to overwrite the other's field — leaving the
    // stored wrappings without the biometric one while Settings said "Face
    // ID is set up".
    async enrollWrapping(name, wrappingKey) {
      requireUnlocked();
      await mutateMeta(backend, async (meta) => {
        if (meta === null) throw new Error('no vault exists');
        // Same rule as changePassphrase below: wrap first, then write one new
        // meta object. Assigning onto the object readMeta returned would land
        // in storage ahead of the write on a backend that returns its stored
        // object by reference, so a throw from the wrap left a half-change
        // behind that no writeMeta had agreed to.
        const wrapped = await wrapKey(wrappingKey, dataKey);
        return {
          ...meta,
          wrapped: { ...meta.wrapped, [name]: wrapped },
        };
      });
    },

    // Settings asks for the current passphrase before changing it. The vault
    // itself does not need that proof — it is unlocked, so the caller already
    // has it — but the screen does: an unlocked phone on a table must not let
    // someone set a new passphrase and lock her out of her own history.
    //
    // Deliberately does not touch lastTouch: checking a passphrase is not
    // activity on her data, and must not extend the idle lock.
    async verifyPassphrase(passphrase) {
      requireUnlocked();
      const meta = await requireMeta();
      const passphraseKey = await deriveKey(
        passphrase, new Uint8Array(meta.salt), meta.iterations,
      );
      try {
        await unwrapKey(passphraseKey, meta.wrapped.passphrase);
        return true;
      } catch {
        // The second of the two swallowed failures named in unlock() above.
        return false;
      }
    },

    // Through mutateMeta: the derive here takes a second or two, and a
    // backup or a Face ID enrolment tapped during it used to read the old
    // meta and write its field back over this one's. Queuing means the meta
    // this reads is the newest one and nothing lands between the read and
    // the write.
    async changePassphrase(nextPassphrase) {
      requireUnlocked();
      await mutateMeta(backend, async (meta) => {
        if (meta === null) throw new Error('no vault exists');
        const salt = randomBytes(SALT_BYTES);
        // Derive and wrap before anything is assigned anywhere. A lock
        // arriving mid-derive nulls dataKey and makes wrapKey throw; the old
        // code had already put the new salt on the live meta object by then,
        // so a backend that hands back its stored object by reference was
        // left pairing a new salt with the old wrapped key - and neither
        // passphrase opened the vault again. Nothing is mutated here: a new
        // meta object is built and returned in one go, so a throw anywhere
        // above leaves the stored meta exactly as it was.
        const passphraseKey = await deriveKey(nextPassphrase, salt, KDF_ITERATIONS);
        const wrapped = await wrapKey(passphraseKey, dataKey);
        return {
          ...meta,
          salt: [...salt],
          iterations: KDF_ITERATIONS,
          wrapped: { ...meta.wrapped, passphrase: wrapped },
        };
      });
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
