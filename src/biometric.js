import { randomBytes } from './crypto.js';
import { readMeta, writeMeta } from './store.js';

const subtle = globalThis.crypto.subtle;

// Fixed for the life of the app: the PRF output IS the wrapping key, so
// changing this label would make every enrolled face derive a different key
// and lock the vault.
export const PRF_SALT_LABEL = 'cyclelog-vault-key-v1';
export const CHALLENGE_BYTES = 32;

export function prfSalt() {
  return new TextEncoder().encode(PRF_SALT_LABEL);
}

// Detects WebAuthn, not PRF: whether the authenticator supports PRF is only
// knowable by attempting a ceremony. The caller treats a `no-prf` result as
// "this device does passphrases", which is why this returning true is not a
// promise that Face ID will work.
export function biometricSupported(env = globalThis) {
  return Boolean(env && env.PublicKeyCredential && env.navigator && env.navigator.credentials);
}

const toBytes = value => (value instanceof Uint8Array ? value : new Uint8Array(value));

async function keyFromPrf(bytes) {
  return subtle.importKey(
    'raw', toBytes(bytes), { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt'],
  );
}

export async function biometricKey({ credentials, credentialId, rpId }) {
  let assertion;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        ...(rpId ? { rpId } : {}),
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(credentialId) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: prfSalt() } } },
      },
    });
  } catch {
    // Cancelled, timed out, or no matching credential. All of these mean
    // "use the passphrase", and none of them are errors worth throwing.
    return { ok: false, reason: 'declined' };
  }

  const results = assertion.getClientExtensionResults().prf;
  const first = results && results.results && results.results.first;
  if (!first) return { ok: false, reason: 'no-prf' };
  return { ok: true, key: await keyFromPrf(first) };
}

export async function enrollBiometric({ credentials, rpId, rpName = 'CycleLog', userName }) {
  let created;
  try {
    created = await credentials.create({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        rp: rpId ? { id: rpId, name: rpName } : { name: rpName },
        user: { id: randomBytes(16), name: userName, displayName: userName },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },    // ES256
          { type: 'public-key', alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',  // Face ID, never a roaming key
          userVerification: 'required',
          residentKey: 'required',
        },
        extensions: { prf: {} },
      },
    });
  } catch {
    return { ok: false, reason: 'declined' };
  }

  const prf = created.getClientExtensionResults().prf;
  if (!prf || !prf.enabled) return { ok: false, reason: 'no-prf' };

  const credentialId = [...toBytes(created.rawId)];

  // Safari does not return PRF output from create(), so the key comes from an
  // immediate assertion: one extra prompt at enrolment, none afterwards. If
  // she cancels this one, the passkey exists on the device but is never
  // remembered — harmless, and enrolment can simply be retried.
  const unlocked = await biometricKey({ credentials, credentialId, rpId });
  if (!unlocked.ok) return unlocked;
  return { ok: true, credentialId, key: unlocked.key };
}

// The credential id is not a secret — it is the handle that tells the
// authenticator which passkey to use — so it lives beside the salt in the
// unencrypted meta, where the lock screen can read it before unlocking.
export async function rememberCredentialId(backend, credentialId) {
  const meta = await readMeta(backend);
  if (meta === null) throw new Error('no vault exists');
  await writeMeta(backend, { ...meta, credentialId });
}

export async function readCredentialId(backend) {
  const meta = await readMeta(backend);
  return (meta && meta.credentialId) || null;
}
