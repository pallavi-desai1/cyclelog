import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/crypto.js';
import { memoryBackend, readMeta, VAULT_KEY } from '../src/store.js';
import { createVault, IDLE_LOCK_MS, VAULT_VERSION } from '../src/unlock.js';

const DOC = JSON.stringify({ version: 1, spans: [{ start: '2015-01-01' }] });
const OTHER = JSON.stringify({ version: 1, spans: [] });

// A clock the test drives, so idle-locking is tested by advancing time rather
// than by waiting five minutes.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

const fresh = (backend = memoryBackend(), clock = fakeClock()) =>
  ({ backend, clock, vault: createVault({ backend, now: clock.now }) });

describe('status', () => {
  it('is empty before setup', async () => {
    const { vault } = fresh();
    expect(await vault.status()).toBe('empty');
  });

  it('is unlocked right after setup', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    expect(await vault.status()).toBe('unlocked');
  });

  it('is locked for a new vault object over an existing backend', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    expect(await createVault({ backend }).status()).toBe('locked');
  });
});

describe('setup', () => {
  it('makes the document readable', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    expect(vault.read()).toBe(DOC);
  });

  it('records the version, salt and iteration count', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const meta = await readMeta(backend);
    expect(meta.version).toBe(VAULT_VERSION);
    expect(meta.salt).toHaveLength(16);
    expect(meta.iterations).toBe(310000);
  });

  it('uses a different salt for every vault', async () => {
    const a = fresh(); const b = fresh();
    await a.vault.setup('correct horse', DOC);
    await b.vault.setup('correct horse', DOC);
    expect((await readMeta(a.backend)).salt).not.toEqual((await readMeta(b.backend)).salt);
  });

  it('refuses to overwrite an existing vault', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await expect(createVault({ backend }).setup('other', OTHER)).rejects.toThrow(/exists/);
  });
});

describe('unlock', () => {
  it('accepts the right passphrase and restores the document', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const reopened = createVault({ backend });
    expect(await reopened.unlock('correct horse')).toEqual({ ok: true });
    expect(reopened.read()).toBe(DOC);
  });

  // Review Focus 1: a mistyped passphrase must be a refusal, not a fresh start.
  it('rejects the wrong passphrase without unlocking', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const reopened = createVault({ backend });
    expect(await reopened.unlock('wrong horse')).toEqual({ ok: false, reason: 'wrong-passphrase' });
    expect(reopened.read()).toBeNull();
    expect(await reopened.status()).toBe('locked');
  });

  it('leaves the vault openable after a wrong attempt', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const reopened = createVault({ backend });
    await reopened.unlock('wrong horse');
    expect(await reopened.unlock('correct horse')).toEqual({ ok: true });
    expect(reopened.read()).toBe(DOC);
  });

  it('reports an empty store distinctly from a wrong passphrase', async () => {
    const { vault } = fresh();
    expect(await vault.unlock('correct horse')).toEqual({ ok: false, reason: 'empty' });
  });

  // The wrong-passphrase catch wraps the key unwrap ONLY. A document that
  // fails to decrypt under a key that already proved correct is corruption,
  // and reporting it as "wrong passphrase" would send her hunting for a
  // passphrase that was right all along.
  it('throws rather than blaming the passphrase when the document is corrupt', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const sealed = await backend.get(VAULT_KEY);
    sealed.ciphertext[0] ^= 0xff;
    await backend.set(VAULT_KEY, sealed);
    await expect(createVault({ backend }).unlock('correct horse')).rejects.toThrow();
  });

  it('throws when the meta exists but the document is gone', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await backend.delete(VAULT_KEY);
    await expect(createVault({ backend }).unlock('correct horse')).rejects.toThrow(/missing/);
  });
});

describe('lock', () => {
  // Review Focus 2: after locking, the decrypted document must not be
  // reachable from the vault object.
  it('drops the decrypted document', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    vault.lock();
    expect(vault.read()).toBeNull();
    expect(await vault.status()).toBe('locked');
  });

  it('is idempotent', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    vault.lock();
    vault.lock();
    expect(vault.read()).toBeNull();
  });
});

describe('save', () => {
  it('persists across a lock and unlock', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await vault.save(OTHER);
    vault.lock();
    await vault.unlock('correct horse');
    expect(vault.read()).toBe(OTHER);
  });

  it('updates what read returns immediately', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    await vault.save(OTHER);
    expect(vault.read()).toBe(OTHER);
  });

  it('refuses to write while locked', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    vault.lock();
    await expect(vault.save(OTHER)).rejects.toThrow(/locked/);
  });

  // Important 2 (final branch review): save() used to write the decrypted
  // document back into `plaintext` unconditionally after the await, even
  // if lock() ran while that write was still in flight — putting the whole
  // decrypted document back in memory on top of a lock that had nothing to
  // do with this save.
  it('does not put the decrypted document back in memory if locked while the write was in flight', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    const pending = vault.save(OTHER);
    vault.lock();
    await pending;
    expect(vault.read()).toBeNull();
  });

  it('still completes the write to storage even though a lock mid-save keeps memory from adopting it', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    const pending = vault.save(OTHER);
    vault.lock();
    await pending;
    await vault.unlock('correct horse');
    expect(vault.read()).toBe(OTHER);
  });
});

describe('idle locking', () => {
  it('does nothing before the idle window elapses', async () => {
    const clock = fakeClock();
    const { vault } = fresh(memoryBackend(), clock);
    await vault.setup('correct horse', DOC);
    clock.advance(IDLE_LOCK_MS - 1);
    expect(vault.maybeIdleLock()).toBe(false);
    expect(vault.read()).toBe(DOC);
  });

  it('locks once the idle window elapses', async () => {
    const clock = fakeClock();
    const { vault } = fresh(memoryBackend(), clock);
    await vault.setup('correct horse', DOC);
    clock.advance(IDLE_LOCK_MS);
    expect(vault.maybeIdleLock()).toBe(true);
    expect(vault.read()).toBeNull();
  });

  it('is reset by activity', async () => {
    const clock = fakeClock();
    const { vault } = fresh(memoryBackend(), clock);
    await vault.setup('correct horse', DOC);
    clock.advance(IDLE_LOCK_MS - 1);
    vault.touch();
    clock.advance(IDLE_LOCK_MS - 1);
    expect(vault.maybeIdleLock()).toBe(false);
    expect(vault.read()).toBe(DOC);
  });

  it('reports false when already locked', async () => {
    const clock = fakeClock();
    const { vault } = fresh(memoryBackend(), clock);
    await vault.setup('correct horse', DOC);
    vault.lock();
    clock.advance(IDLE_LOCK_MS * 10);
    expect(vault.maybeIdleLock()).toBe(false);
  });
});

describe('additional wrappings', () => {
  it('unlocks with an enrolled key', async () => {
    const { backend, vault } = fresh();
    const deviceKey = await generateKey();
    await vault.setup('correct horse', DOC);
    await vault.enrollWrapping('biometric', deviceKey);

    const reopened = createVault({ backend });
    expect(await reopened.unlockWithKey('biometric', deviceKey)).toEqual({ ok: true });
    expect(reopened.read()).toBe(DOC);
  });

  it('rejects the wrong key', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await vault.enrollWrapping('biometric', await generateKey());
    const reopened = createVault({ backend });
    expect(await reopened.unlockWithKey('biometric', await generateKey()))
      .toEqual({ ok: false, reason: 'wrong-key' });
    expect(reopened.read()).toBeNull();
  });

  it('reports a name that was never enrolled', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    expect(await createVault({ backend }).unlockWithKey('biometric', await generateKey()))
      .toEqual({ ok: false, reason: 'not-enrolled' });
  });

  it('reports an empty store', async () => {
    const { vault } = fresh();
    expect(await vault.unlockWithKey('biometric', await generateKey()))
      .toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses to enroll while locked', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    vault.lock();
    await expect(vault.enrollWrapping('biometric', await generateKey())).rejects.toThrow(/locked/);
  });
});

describe('changePassphrase', () => {
  it('opens with the new passphrase and not the old one', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await vault.changePassphrase('new battery');

    const reopened = createVault({ backend });
    expect(await reopened.unlock('correct horse')).toEqual({ ok: false, reason: 'wrong-passphrase' });
    expect(await reopened.unlock('new battery')).toEqual({ ok: true });
    expect(reopened.read()).toBe(DOC);
  });

  it('keeps Face ID working', async () => {
    const { backend, vault } = fresh();
    const deviceKey = await generateKey();
    await vault.setup('correct horse', DOC);
    await vault.enrollWrapping('biometric', deviceKey);
    await vault.changePassphrase('new battery');

    expect(await createVault({ backend }).unlockWithKey('biometric', deviceKey)).toEqual({ ok: true });
  });

  it('does not re-encrypt the document', async () => {
    // The data key is unchanged, so the sealed document is byte-identical.
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const before = JSON.stringify(await backend.get(VAULT_KEY));
    await vault.changePassphrase('new battery');
    expect(JSON.stringify(await backend.get(VAULT_KEY))).toBe(before);
  });

  it('refuses while locked', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    vault.lock();
    await expect(vault.changePassphrase('new battery')).rejects.toThrow(/locked/);
  });
});

describe('erase', () => {
  it('returns the vault to empty and locks it', async () => {
    const { vault } = fresh();
    await vault.setup('correct horse', DOC);
    await vault.erase();
    expect(await vault.status()).toBe('empty');
    expect(vault.read()).toBeNull();
  });
});
