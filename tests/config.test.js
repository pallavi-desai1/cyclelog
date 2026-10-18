import { describe, it, expect } from 'vitest';
import { FIREBASE } from '../src/config.js';

describe('the Firebase config', () => {
  it('names a real project rather than a placeholder', () => {
    expect(FIREBASE.projectId).toMatch(/^[a-z0-9-]+$/);
    expect(FIREBASE.projectId).not.toMatch(/REPLACE|your-project|example/i);
  });

  it('carries a web api key of the shape Google issues', () => {
    expect(FIREBASE.apiKey).toMatch(/^AIza[\w-]{35}$/);
  });

  // These two are public by design. The test exists so nobody later "fixes"
  // the file by adding something that is not.
  it('holds nothing but those two values', () => {
    expect(Object.keys(FIREBASE).sort()).toEqual(['apiKey', 'projectId']);
  });
});
