import { describe, it, expect } from 'vitest';
import {
  SYNC_KEY_BYTES, generateSyncKey, importSyncKey, fingerprint,
  sealPayload, openPayload,
} from '../src/sync/key.js';

const PLAINTEXT = JSON.stringify({ spans: [{ start: '2015-01-01' }] });

describe('generateSyncKey', () => {
  it('is 256 bits', () => {
    expect(SYNC_KEY_BYTES).toBe(32);
  });

  it('encodes to 43 base64url characters', () => {
    expect(generateSyncKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateSyncKey()));
    expect(keys.size).toBe(50);
  });

  // base64url, not base64: the key is typed by hand and read off a screen, and
  // + / = are exactly the characters that go wrong there.
  it('contains no character that survives a copy badly', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateSyncKey()).not.toMatch(/[+/=]/);
    }
  });
});

describe('importSyncKey', () => {
  it('accepts a key it generated', async () => {
    await expect(importSyncKey(generateSyncKey())).resolves.toBeDefined();
  });

  it('refuses a key of the wrong length', async () => {
    await expect(importSyncKey('tooshort')).rejects.toThrow(/not a sync key/i);
  });

  it('refuses a key with characters it never generates', async () => {
    await expect(importSyncKey(`${'A'.repeat(42)}+`)).rejects.toThrow(/not a sync key/i);
  });

  it('refuses nothing at all', async () => {
    await expect(importSyncKey('')).rejects.toThrow(/not a sync key/i);
    await expect(importSyncKey(null)).rejects.toThrow(/not a sync key/i);
  });

  it('tolerates the whitespace a copy and paste adds', async () => {
    const key = generateSyncKey();
    await expect(importSyncKey(`  ${key}\n`)).resolves.toBeDefined();
  });
});

describe('fingerprint', () => {
  it('is six characters, short enough to read aloud', async () => {
    expect(await fingerprint(generateSyncKey())).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('is the same for the same key', async () => {
    const key = generateSyncKey();
    expect(await fingerprint(key)).toBe(await fingerprint(key));
  });

  it('differs for different keys', async () => {
    const prints = new Set();
    for (let i = 0; i < 20; i += 1) prints.add(await fingerprint(generateSyncKey()));
    expect(prints.size).toBe(20);
  });

  // The point of showing it on both screens: a mistyped character has to
  // change it, or it reassures her about a key that will never work.
  it('changes when a single character of the key changes', async () => {
    const key = generateSyncKey();
    const bent = `${key.slice(0, 20)}${key[20] === 'A' ? 'B' : 'A'}${key.slice(21)}`;
    expect(await fingerprint(bent)).not.toBe(await fingerprint(key));
  });

  // Pinned against an independently computed SHA-256 digest (not derived
  // from this module): `sha256("A".repeat(43))` hex-encoded starts with
  // `0f0073`. Nothing else here would catch a changed derivation — every
  // other test above compares the function's own output against itself,
  // which a broken-but-consistent change would still pass, and every
  // paired device would silently stop matching.
  it('matches an independently computed SHA-256 digest', async () => {
    expect(await fingerprint('A'.repeat(43))).toBe('0F0073');
  });
});

describe('sealPayload and openPayload', () => {
  it('round-trips a payload', async () => {
    const key = await importSyncKey(generateSyncKey());
    expect(await openPayload(key, await sealPayload(key, PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('produces base64url strings, which JSON and a URL both survive', async () => {
    const key = await importSyncKey(generateSyncKey());
    const sealed = await sealPayload(key, PLAINTEXT);
    expect(sealed.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses a fresh iv for every seal', async () => {
    const key = await importSyncKey(generateSyncKey());
    const first = await sealPayload(key, PLAINTEXT);
    const second = await sealPayload(key, PLAINTEXT);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('hides the plaintext', async () => {
    const key = await importSyncKey(generateSyncKey());
    const sealed = await sealPayload(key, PLAINTEXT);
    expect(JSON.stringify(sealed)).not.toContain('spans');
    expect(JSON.stringify(sealed)).not.toContain('2015');
  });

  it('throws under a different key', async () => {
    const sealed = await sealPayload(await importSyncKey(generateSyncKey()), PLAINTEXT);
    const other = await importSyncKey(generateSyncKey());
    await expect(openPayload(other, sealed)).rejects.toThrow();
  });

  it('throws on tampered ciphertext', async () => {
    const key = await importSyncKey(generateSyncKey());
    const sealed = await sealPayload(key, PLAINTEXT);
    const bent = { ...sealed, ciphertext: `A${sealed.ciphertext.slice(1)}` };
    await expect(openPayload(key, bent)).rejects.toThrow();
  });

  it('throws on a payload that is missing its iv', async () => {
    const key = await importSyncKey(generateSyncKey());
    const sealed = await sealPayload(key, PLAINTEXT);
    await expect(openPayload(key, { ciphertext: sealed.ciphertext })).rejects.toThrow();
  });
});
