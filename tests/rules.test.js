import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rules = () => readFileSync(join(import.meta.dirname, '..', 'firestore.rules'), 'utf8');

describe('firestore.rules', () => {
  it('pins the rules version', () => {
    expect(rules()).toMatch(/rules_version\s*=\s*'2'/);
  });

  it('lets the owner read and write her own vault', () => {
    expect(rules()).toMatch(/allow read[^;]*request\.auth\.uid == ownerUid/);
    expect(rules()).toMatch(/allow write[^;]*request\.auth\.uid == ownerUid/);
  });

  // Review Focus 4: a granted viewer may read, and may never write.
  it('lets a granted viewer read', () => {
    expect(rules()).toMatch(/exists\(.*viewers\/\$\(request\.auth\.uid\)\)/);
  });

  it('never allows a write to anyone but the owner', () => {
    for (const [, condition] of rules().matchAll(/allow write:\s*if([^;]+);/g)) {
      expect(condition).toMatch(/request\.auth\.uid == ownerUid/);
      expect(condition).not.toMatch(/viewers/);
    }
  });

  it('keeps the grant documents readable and writable only by the owner', () => {
    const viewers = rules().slice(rules().indexOf('match /viewers'));
    expect(viewers).toMatch(/request\.auth\.uid == ownerUid/);
  });

  it('denies everything it does not name', () => {
    // No catch-all allow, and nothing granted to an unauthenticated caller.
    expect(rules()).not.toMatch(/allow read, write:\s*if true/);
    expect(rules()).not.toMatch(/if request\.auth != null;/);
  });

  it('is deployed from this file, not pasted into a console', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8'))
      .toMatch(/firestore\.rules/);
  });
});
