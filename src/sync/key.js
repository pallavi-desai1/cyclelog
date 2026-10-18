import { randomBytes } from '../crypto.js';

const subtle = globalThis.crypto.subtle;

export const SYNC_KEY_BYTES = 32;
const IV_BYTES = 12;
const FINGERPRINT_CHARS = 6;

// base64url throughout. The key is read off one screen and typed into
// another, and `+`, `/` and `=` are the characters that go wrong when that
// happens — in URLs, in copy buttons, in anything that trims.
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function generateSyncKey() {
  return toBase64Url(randomBytes(SYNC_KEY_BYTES));
}

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export async function importSyncKey(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!KEY_SHAPE.test(trimmed)) {
    throw new Error('that is not a sync key: expected 43 characters of base64url');
  }
  return subtle.importKey(
    'raw', fromBase64Url(trimmed), { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt'],
  );
}

// Shown on both screens so a mistyped character is caught before it becomes a
// silent failure. A hash, not a tag: it must be derivable from the key alone.
export async function fingerprint(text) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(text).trim()));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, FINGERPRINT_CHARS)
    .toUpperCase();
}

export async function sealPayload(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

// Throws on a wrong key, tampered bytes or a malformed payload. Never
// swallowed: a viewer who cannot decrypt must be told, not shown an empty
// calendar that looks like no data.
export async function openPayload(key, payload) {
  if (!payload || !payload.iv || !payload.ciphertext) {
    throw new Error('that payload is not readable: it has no iv or no ciphertext');
  }
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(payload.iv) },
    key,
    fromBase64Url(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
