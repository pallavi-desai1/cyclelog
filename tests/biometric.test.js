import { describe, it, expect } from 'vitest';
import { generateKey, wrapKey, unwrapKey } from '../src/crypto.js';
import { memoryBackend } from '../src/store.js';
import { createVault } from '../src/unlock.js';
import {
  PRF_SALT_LABEL, CHALLENGE_BYTES, prfSalt, biometricSupported,
  enrollBiometric, biometricKey, rememberCredentialId, readCredentialId,
} from '../src/biometric.js';

// A stand-in for the platform authenticator, built to the shapes WebAuthn
// documents. It proves our code reads and writes those shapes correctly; it
// cannot prove iOS Safari enables PRF. That is verified on the phone.
function fakeAuthenticator({
  prfEnabled = true, prf = new Uint8Array(32).fill(7),
  failCreate = false, failGet = false, omitResults = false,
} = {}) {
  const calls = { create: [], get: [] };
  return {
    calls,
    async create(options) {
      calls.create.push(options);
      if (failCreate) throw new Error('NotAllowedError');
      return {
        rawId: new Uint8Array([9, 8, 7, 6]),
        getClientExtensionResults: () => ({ prf: { enabled: prfEnabled } }),
      };
    },
    async get(options) {
      calls.get.push(options);
      if (failGet) throw new Error('NotAllowedError');
      return {
        getClientExtensionResults: () =>
          (omitResults ? {} : { prf: { results: { first: prf } } }),
      };
    },
  };
}

const ENROLL = { rpId: 'pallavi-desai1.github.io', userName: 'cyclelog' };

describe('biometricSupported', () => {
  it('is false when the browser has no WebAuthn', () => {
    expect(biometricSupported({ navigator: { credentials: {} } })).toBe(false);
  });

  it('is false when there is no credentials container', () => {
    expect(biometricSupported({ PublicKeyCredential: function () {}, navigator: {} })).toBe(false);
  });

  it('is true when both are present', () => {
    expect(biometricSupported({
      PublicKeyCredential: function () {}, navigator: { credentials: {} },
    })).toBe(true);
  });

  it('is false rather than throwing when handed nothing', () => {
    expect(biometricSupported(undefined)).toBe(false);
  });
});

describe('prfSalt', () => {
  it('is a fixed label, so the same face yields the same key forever', () => {
    expect([...prfSalt()]).toEqual([...new TextEncoder().encode(PRF_SALT_LABEL)]);
  });
});

describe('enrollBiometric', () => {
  it('returns the credential id and a key', async () => {
    const credentials = fakeAuthenticator();
    const result = await enrollBiometric({ credentials, ...ENROLL });
    expect(result.ok).toBe(true);
    expect(result.credentialId).toEqual([9, 8, 7, 6]);
    expect(result.key).toBeDefined();
  });

  it('asks for the prf extension and a platform authenticator', async () => {
    const credentials = fakeAuthenticator();
    await enrollBiometric({ credentials, ...ENROLL });
    const { publicKey } = credentials.calls.create[0];
    expect(publicKey.extensions.prf).toEqual({});
    expect(publicKey.authenticatorSelection.authenticatorAttachment).toBe('platform');
    expect(publicKey.authenticatorSelection.userVerification).toBe('required');
  });

  it('sends a fresh 32-byte challenge every ceremony', async () => {
    const credentials = fakeAuthenticator();
    await enrollBiometric({ credentials, ...ENROLL });
    await enrollBiometric({ credentials, ...ENROLL });
    const [first, second] = credentials.calls.create.map(c => [...c.publicKey.challenge]);
    expect(first).toHaveLength(CHALLENGE_BYTES);
    expect(first).not.toEqual(second);
  });

  it('reports no-prf when the authenticator does not support it', async () => {
    const credentials = fakeAuthenticator({ prfEnabled: false });
    expect(await enrollBiometric({ credentials, ...ENROLL }))
      .toEqual({ ok: false, reason: 'no-prf' });
  });

  it('does not run an assertion when prf is unsupported', async () => {
    const credentials = fakeAuthenticator({ prfEnabled: false });
    await enrollBiometric({ credentials, ...ENROLL });
    expect(credentials.calls.get).toHaveLength(0);
  });

  it('reports declined when the user cancels the registration', async () => {
    const credentials = fakeAuthenticator({ failCreate: true });
    expect(await enrollBiometric({ credentials, ...ENROLL }))
      .toEqual({ ok: false, reason: 'declined' });
  });

  it('reports declined when the user cancels the follow-up assertion', async () => {
    const credentials = fakeAuthenticator({ failGet: true });
    expect(await enrollBiometric({ credentials, ...ENROLL }))
      .toEqual({ ok: false, reason: 'declined' });
  });

  it('reports no-prf when the assertion comes back without results', async () => {
    const credentials = fakeAuthenticator({ omitResults: true });
    expect(await enrollBiometric({ credentials, ...ENROLL }))
      .toEqual({ ok: false, reason: 'no-prf' });
  });
});

describe('biometricKey', () => {
  it('evaluates the prf under our fixed salt', async () => {
    const credentials = fakeAuthenticator();
    await biometricKey({ credentials, credentialId: [9, 8, 7, 6] });
    const { publicKey } = credentials.calls.get[0];
    expect([...publicKey.extensions.prf.eval.first]).toEqual([...prfSalt()]);
  });

  it('restricts the ceremony to the enrolled credential', async () => {
    const credentials = fakeAuthenticator();
    await biometricKey({ credentials, credentialId: [9, 8, 7, 6], rpId: ENROLL.rpId });
    const { publicKey } = credentials.calls.get[0];
    expect([...publicKey.allowCredentials[0].id]).toEqual([9, 8, 7, 6]);
    expect(publicKey.rpId).toBe(ENROLL.rpId);
    expect(publicKey.userVerification).toBe('required');
  });

  // Review Focus 3's other half: an enhancement that returned a different key
  // on each ceremony would lock her out of her own vault.
  it('derives the same key as enrolment did', async () => {
    const credentials = fakeAuthenticator();
    const enrolled = await enrollBiometric({ credentials, ...ENROLL });
    const later = await biometricKey({ credentials, credentialId: enrolled.credentialId });

    const dataKey = await generateKey();
    const wrapped = await wrapKey(enrolled.key, dataKey);
    await expect(unwrapKey(later.key, wrapped)).resolves.toBeDefined();
  });

  it('derives a different key from different prf output', async () => {
    const mine = await biometricKey({
      credentials: fakeAuthenticator({ prf: new Uint8Array(32).fill(7) }), credentialId: [1],
    });
    const theirs = await biometricKey({
      credentials: fakeAuthenticator({ prf: new Uint8Array(32).fill(8) }), credentialId: [1],
    });
    const wrapped = await wrapKey(mine.key, await generateKey());
    await expect(unwrapKey(theirs.key, wrapped)).rejects.toThrow();
  });

  it('reports declined when the user cancels', async () => {
    expect(await biometricKey({
      credentials: fakeAuthenticator({ failGet: true }), credentialId: [1],
    })).toEqual({ ok: false, reason: 'declined' });
  });

  it('reports no-prf when results are missing', async () => {
    expect(await biometricKey({
      credentials: fakeAuthenticator({ omitResults: true }), credentialId: [1],
    })).toEqual({ ok: false, reason: 'no-prf' });
  });
});

describe('remembering the credential', () => {
  const DOC = '{"version":1,"spans":[]}';

  it('round-trips the credential id', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', DOC);
    await rememberCredentialId(backend, [9, 8, 7, 6]);
    expect(await readCredentialId(backend)).toEqual([9, 8, 7, 6]);
  });

  it('is null when nothing is enrolled', async () => {
    const backend = memoryBackend();
    await createVault({ backend }).setup('correct horse', DOC);
    expect(await readCredentialId(backend)).toBeNull();
  });

  it('is null when there is no vault at all', async () => {
    expect(await readCredentialId(memoryBackend())).toBeNull();
  });

  it('refuses to write without a vault', async () => {
    await expect(rememberCredentialId(memoryBackend(), [1])).rejects.toThrow(/no vault/);
  });

  it('survives enrollWrapping, which rewrites the same meta', async () => {
    const backend = memoryBackend();
    const vault = createVault({ backend });
    await vault.setup('correct horse', DOC);
    await rememberCredentialId(backend, [9, 8, 7, 6]);
    await vault.enrollWrapping('biometric', await generateKey());
    expect(await readCredentialId(backend)).toEqual([9, 8, 7, 6]);
  });
});

describe('end to end', () => {
  it('unlocks a real vault with a second Face ID ceremony', async () => {
    const backend = memoryBackend();
    const credentials = fakeAuthenticator();
    const document = '{"version":1,"spans":[{"start":"2015-01-01"}]}';

    const vault = createVault({ backend });
    await vault.setup('correct horse', document);
    const enrolled = await enrollBiometric({ credentials, ...ENROLL });
    await rememberCredentialId(backend, enrolled.credentialId);
    await vault.enrollWrapping('biometric', enrolled.key);
    vault.lock();

    // A fresh page load: read the id, run the ceremony, unlock.
    const reopened = createVault({ backend });
    const credentialId = await readCredentialId(backend);
    const unlocked = await biometricKey({ credentials, credentialId });
    expect(await reopened.unlockWithKey('biometric', unlocked.key)).toEqual({ ok: true });
    expect(reopened.read()).toBe(document);
  });

  it('still opens with the passphrase when Face ID is unavailable', async () => {
    const backend = memoryBackend();
    const credentials = fakeAuthenticator({ prfEnabled: false });
    const vault = createVault({ backend });
    await vault.setup('correct horse', '{"version":1,"spans":[]}');

    expect(await enrollBiometric({ credentials, ...ENROLL })).toEqual({ ok: false, reason: 'no-prf' });
    vault.lock();
    expect(await createVault({ backend }).unlock('correct horse')).toEqual({ ok: true });
  });
});
