import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/crypto.js';
import { memoryBackend, readMeta, mutateMeta, VAULT_KEY } from '../src/store.js';
import { createVault, IDLE_LOCK_MS, VAULT_VERSION } from '../src/unlock.js';
import { markBackup, readLastBackup } from '../src/restore.js';
import { rememberCredentialId } from '../src/biometric.js';

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

  it('leaves the old passphrase working when a lock interrupts the change', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('the original passphrase', '{"version":1}');
    const changing = vault.changePassphrase('the new passphrase');
    vault.lock();
    await changing.catch(() => {});
    // The change did not complete, so the vault must still be exactly as it
    // was. The failure this pins is not "the new passphrase does not work"
    // - it is BOTH failing, which is permanent loss of her history.
    expect(await vault.unlock('the original passphrase')).toEqual({ ok: true });
  });

  it('never writes a salt that does not match the stored wrapped key', async () => {
    const backend = memoryBackend();
    const vault = createVault({ backend });
    await vault.setup('the original passphrase', '{"version":1}');
    const before = JSON.stringify(await readMeta(backend));
    const changing = vault.changePassphrase('the new passphrase');
    vault.lock();
    await changing.catch(() => {});
    expect(JSON.stringify(await readMeta(backend))).toBe(before);
  });
});

describe('verifyPassphrase', () => {
  it('is true for the passphrase that opens the vault', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('correct horse battery', '{"version":1}');
    expect(await vault.verifyPassphrase('correct horse battery')).toBe(true);
  });

  it('is false for any other passphrase', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('correct horse battery', '{"version":1}');
    expect(await vault.verifyPassphrase('wrong horse battery')).toBe(false);
  });

  it('leaves the vault unlocked and its document readable either way', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('correct horse battery', '{"version":1}');
    await vault.verifyPassphrase('wrong horse battery');
    expect(await vault.status()).toBe('unlocked');
    expect(vault.read()).toBe('{"version":1}');
  });

  it('refuses when the vault is locked rather than reporting false', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('correct horse battery', '{"version":1}');
    vault.lock();
    await expect(vault.verifyPassphrase('correct horse battery')).rejects.toThrow(/locked/);
  });
});

// Review Focus 1: the data key is what Face ID's wrapping wraps. A passphrase
// change re-wraps that same key, so Face ID must keep working. An
// implementation that regenerated the data key would pass every
// passphrase-change test and silently destroy the Face ID path.
describe('changePassphrase and Face ID together', () => {
  it('leaves an enrolled Face ID wrapping able to unlock', async () => {
    const backend = memoryBackend();
    const vault = createVault({ backend });
    await vault.setup('first passphrase', '{"version":1}');

    const faceKey = await generateKey();
    await vault.enrollWrapping('faceid', faceKey);
    await vault.changePassphrase('second passphrase');
    vault.lock();

    expect(await vault.unlockWithKey('faceid', faceKey)).toEqual({ ok: true });
    expect(vault.read()).toBe('{"version":1}');
  });

  it('still opens with the new passphrase and not the old one', async () => {
    const vault = createVault({ backend: memoryBackend() });
    await vault.setup('first passphrase', '{"version":1}');
    await vault.changePassphrase('second passphrase');
    vault.lock();

    expect(await vault.unlock('first passphrase')).toEqual({ ok: false, reason: 'wrong-passphrase' });
    expect(await vault.unlock('second passphrase')).toEqual({ ok: true });
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

// Finding F. markBackup, enrollWrapping, rememberCredentialId and
// changePassphrase are all read-modify-write on the same unencrypted meta
// record, and Settings puts the buttons that trigger them on one screen —
// "Download encrypted backup" has no in-flight guard at all, so it can be
// tapped during a passphrase change's one-to-two-second derive. Whichever
// write landed second used to revert the other's field. mutateMeta
// serialises them; these tests start the second mutation while the first is
// still deriving.
describe('concurrent meta writers', () => {
  it('does not lose the backup date to a passphrase change running at the same time', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    await markBackup(backend, '2015-01-01');

    // Started, not awaited: the derive is the slow part, and this is the
    // window she can reach with two taps.
    const change = vault.changePassphrase('new battery');
    const backup = markBackup(backend, '2015-02-02');
    await Promise.all([change, backup]);

    const meta = await readMeta(backend);
    expect(meta.lastBackupAt).toBe('2015-02-02');
    expect(await readLastBackup(backend)).toBe('2015-02-02');

    // And the passphrase change still completed.
    const reopened = createVault({ backend });
    expect(await reopened.unlock('correct horse')).toEqual({ ok: false, reason: 'wrong-passphrase' });
    expect(await reopened.unlock('new battery')).toEqual({ ok: true });
  });

  it('keeps the backup date whichever order the two are started in', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);

    const backup = markBackup(backend, '2015-03-03');
    const change = vault.changePassphrase('new battery');
    await Promise.all([backup, change]);

    expect((await readMeta(backend)).lastBackupAt).toBe('2015-03-03');
    expect(await createVault({ backend }).unlock('new battery')).toEqual({ ok: true });
  });

  it('keeps both the new wrapping and the new salt when an enrolment straddles a change', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    const beforeSalt = (await readMeta(backend)).salt.join(',');
    const deviceKey = await generateKey();

    const change = vault.changePassphrase('new battery');
    const enroll = vault.enrollWrapping('biometric', deviceKey);
    await Promise.all([change, enroll]);

    const meta = await readMeta(backend);
    expect(Object.keys(meta.wrapped).sort()).toEqual(['biometric', 'passphrase']);
    expect(meta.salt.join(',')).not.toBe(beforeSalt);

    const reopened = createVault({ backend });
    expect(await reopened.unlockWithKey('biometric', deviceKey)).toEqual({ ok: true });
    const again = createVault({ backend });
    expect(await again.unlock('new battery')).toEqual({ ok: true });
    expect(await createVault({ backend }).unlock('correct horse'))
      .toEqual({ ok: false, reason: 'wrong-passphrase' });
  });

  it('keeps the credential id across a concurrent passphrase change', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);

    const change = vault.changePassphrase('new battery');
    const remember = rememberCredentialId(backend, [1, 2, 3]);
    await Promise.all([change, remember]);

    expect((await readMeta(backend)).credentialId).toEqual([1, 2, 3]);
    expect(await createVault({ backend }).unlock('new battery')).toEqual({ ok: true });
  });

  it('lets a later mutation run after an earlier one rejects', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);

    // The rejection has to happen INSIDE the queue to test anything. A
    // locked vault does not: changePassphrase calls requireUnlocked() before
    // it ever reaches mutateMeta, so this test used to pass without creating
    // the rejected tail its own name describes — it was green because an
    // earlier test had already poisoned the shared queue.
    const realSet = backend.set.bind(backend);
    let failNextWrite = true;
    backend.set = async (key, value) => {
      if (failNextWrite && key === 'meta') {
        failNextWrite = false;
        throw new Error('storage is full');
      }
      return realSet(key, value);
    };
    await expect(vault.changePassphrase('new battery')).rejects.toThrow(/storage is full/);
    backend.set = realSet;

    // A rejected queue tail must not make the next mutation skip its work.
    await markBackup(backend, '2015-04-04');
    expect((await readMeta(backend)).lastBackupAt).toBe('2015-04-04');
    // The old passphrase still opens it: the failed change wrote nothing.
    expect(await createVault({ backend }).unlock('correct horse')).toEqual({ ok: true });
  });

  it('reports a failed mutation to its own caller', async () => {
    const backend = memoryBackend();
    // No vault, so there is no meta to modify.
    await expect(rememberCredentialId(backend, [1])).rejects.toThrow(/no vault exists/);
    expect(await readMeta(backend)).toBeNull();
  });

  it('lets a later mutation run after one rejects inside the queue', async () => {
    const { backend, vault } = fresh();
    await vault.setup('correct horse', DOC);
    // Rejecting after it is already queued, which is what a wrap failing on
    // a vault locked mid-change looks like. The queue must not be left in a
    // rejected state: a tail that every later mutation chains onto through
    // its rejection handler would make each of them skip its own work in
    // silence — the backup date would simply never be written again.
    await expect(mutateMeta(backend, () => { throw new Error('nope'); }))
      .rejects.toThrow(/nope/);
    await markBackup(backend, '2015-05-05');
    expect((await readMeta(backend)).lastBackupAt).toBe('2015-05-05');
    await rememberCredentialId(backend, [9]);
    expect((await readMeta(backend)).credentialId).toEqual([9]);
  });
});
