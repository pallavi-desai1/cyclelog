// Web Crypto only — available in Safari and in Node 22, so this module is
// fully testable outside a browser. No third-party dependency is involved in
// protecting the data at rest.
const subtle = globalThis.crypto.subtle;

// Spec 8. 310,000 PBKDF2 iterations is the OWASP floor for SHA-256 at the time
// of writing; it costs a noticeable fraction of a second on a phone, which is
// the point.
export const KDF_ITERATIONS = 310000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    // Not extractable: this key only ever wraps and unwraps the data key, so
    // nothing needs its bytes and the browser can keep them out of reach.
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// Plain arrays rather than typed arrays, because the result is stored as JSON
// and a Uint8Array serialises to an object keyed by index.
export async function seal(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
  );
  return { iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
}

// Throws on a wrong key or tampered bytes — AES-GCM authenticates, and that
// failure is information the caller needs. Never swallow it into an empty
// document: a wrong passphrase would then look exactly like a fresh install.
export async function open(key, sealed) {
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(sealed.iv) },
    key,
    new Uint8Array(sealed.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function wrapKey(wrappingKey, keyToWrap) {
  const raw = await subtle.exportKey('raw', keyToWrap);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return { iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
}

export async function unwrapKey(wrappingKey, wrapped) {
  const raw = await subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(wrapped.iv) },
    wrappingKey,
    new Uint8Array(wrapped.ciphertext),
  );
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
