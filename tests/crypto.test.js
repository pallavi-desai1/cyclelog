import { describe, it, expect } from 'vitest';
import {
  KDF_ITERATIONS, SALT_BYTES, IV_BYTES,
  randomBytes, deriveKey, generateKey, seal, open, wrapKey, unwrapKey,
} from '../src/crypto.js';

const PLAINTEXT = JSON.stringify({ version: 1, spans: [{ start: '2015-01-01' }] });

describe('parameters', () => {
  it('uses the iteration count and sizes the spec fixes', () => {
    expect(KDF_ITERATIONS).toBe(310000);
    expect(SALT_BYTES).toBe(16);
    expect(IV_BYTES).toBe(12);
  });
});

describe('randomBytes', () => {
  it('returns the requested length', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(randomBytes(12)).toHaveLength(12);
  });

  it('does not repeat', () => {
    const a = [...randomBytes(32)].join(',');
    const b = [...randomBytes(32)].join(',');
    expect(a).not.toBe(b);
  });

  it('is not all zeroes', () => {
    expect([...randomBytes(32)].some(byte => byte !== 0)).toBe(true);
  });
});

describe('seal and open', () => {
  it('round-trips a document', async () => {
    const key = await generateKey();
    const sealed = await seal(key, PLAINTEXT);
    expect(await open(key, sealed)).toBe(PLAINTEXT);
  });

  it('uses a fresh IV for every seal', async () => {
    const key = await generateKey();
    const first = await seal(key, PLAINTEXT);
    const second = await seal(key, PLAINTEXT);
    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  // Review Focus 1: a wrong passphrase must throw, never return something
  // plausible. A caller that caught this and returned an empty vault would
  // silently present nine years of history as a fresh install.
  it('throws on the wrong key rather than returning anything', async () => {
    const sealed = await seal(await generateKey(), PLAINTEXT);
    await expect(open(await generateKey(), sealed)).rejects.toThrow();
  });

  it('throws when the ciphertext is tampered with', async () => {
    const key = await generateKey();
    const sealed = await seal(key, PLAINTEXT);
    const tampered = { ...sealed, ciphertext: [...sealed.ciphertext] };
    tampered.ciphertext[0] ^= 1;
    await expect(open(key, tampered)).rejects.toThrow();
  });

  it('throws when the IV is tampered with', async () => {
    const key = await generateKey();
    const sealed = await seal(key, PLAINTEXT);
    const tampered = { ...sealed, iv: [...sealed.iv] };
    tampered.iv[0] ^= 1;
    await expect(open(key, tampered)).rejects.toThrow();
  });

  it('seals to plain arrays so the result is JSON-serialisable', async () => {
    const sealed = await seal(await generateKey(), PLAINTEXT);
    expect(Array.isArray(sealed.iv)).toBe(true);
    expect(Array.isArray(sealed.ciphertext)).toBe(true);
    expect(JSON.parse(JSON.stringify(sealed))).toEqual(sealed);
  });

  // The whole point of encrypting at rest: the stored bytes must not contain
  // anything recognisable from the document.
  it('leaves no recognisable field name in the ciphertext', async () => {
    const sealed = await seal(await generateKey(), PLAINTEXT);
    const asText = String.fromCharCode(...sealed.ciphertext);
    for (const needle of ['version', 'spans', 'start', '2015']) {
      expect(asText).not.toContain(needle);
    }
  });

  it('round-trips an empty string', async () => {
    const key = await generateKey();
    expect(await open(key, await seal(key, ''))).toBe('');
  });

  it('round-trips text outside the ASCII range', async () => {
    const key = await generateKey();
    const text = 'cramps — "heavy" · 28 días';
    expect(await open(key, await seal(key, text))).toBe(text);
  });
});

describe('deriveKey', () => {
  it('derives the same key from the same passphrase and salt', async () => {
    const salt = randomBytes(SALT_BYTES);
    const sealed = await seal(await deriveKey('correct horse battery', salt), PLAINTEXT);
    expect(await open(await deriveKey('correct horse battery', salt), sealed)).toBe(PLAINTEXT);
  });

  it('derives a different key from a different passphrase', async () => {
    const salt = randomBytes(SALT_BYTES);
    const sealed = await seal(await deriveKey('right passphrase', salt), PLAINTEXT);
    await expect(open(await deriveKey('wrong passphrase', salt), sealed)).rejects.toThrow();
  });

  // The salt is what stops one passphrase producing one key everywhere.
  it('derives a different key from a different salt', async () => {
    const sealed = await seal(await deriveKey('same passphrase', randomBytes(SALT_BYTES)), PLAINTEXT);
    await expect(open(await deriveKey('same passphrase', randomBytes(SALT_BYTES)), sealed)).rejects.toThrow();
  });

  it('accepts a lower iteration count for tests without changing the default', async () => {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey('fast', salt, 1000);
    expect(await open(key, await seal(key, PLAINTEXT))).toBe(PLAINTEXT);
    expect(KDF_ITERATIONS).toBe(310000);
  });
});

describe('key wrapping', () => {
  it('wraps and unwraps a data key', async () => {
    const dataKey = await generateKey();
    const wrapping = await deriveKey('wrapper', randomBytes(SALT_BYTES), 1000);
    const sealed = await seal(dataKey, PLAINTEXT);

    const wrapped = await wrapKey(wrapping, dataKey);
    const recovered = await unwrapKey(wrapping, wrapped);
    expect(await open(recovered, sealed)).toBe(PLAINTEXT);
  });

  it('refuses to unwrap with the wrong wrapping key', async () => {
    const wrapped = await wrapKey(await deriveKey('a', randomBytes(SALT_BYTES), 1000), await generateKey());
    await expect(unwrapKey(await deriveKey('b', randomBytes(SALT_BYTES), 1000), wrapped)).rejects.toThrow();
  });

  it('wraps to a JSON-serialisable shape', async () => {
    const wrapped = await wrapKey(await deriveKey('a', randomBytes(SALT_BYTES), 1000), await generateKey());
    expect(JSON.parse(JSON.stringify(wrapped))).toEqual(wrapped);
  });
});
