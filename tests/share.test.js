import { describe, it, expect } from 'vitest';
import {
  SHARE_SCHEMA_VERSION, shareState, withSharing, withScope, withIdentity,
  withViewer, withoutViewer, withPushResult, withoutSharing,
  buildPayload, describePush,
} from '../src/sync/share.js';
import { generateSyncKey, importSyncKey, openPayload } from '../src/sync/key.js';

const doc = (sharing = undefined) => ({
  version: 1,
  spans: [{ start: '2015-01-29', end: '2015-02-02', source: 'clue' }],
  gaps: [],
  birthControl: [],
  days: {
    '2015-01-29': {
      flow: 'heavy', cramps: null, spotting: null, pms: false, mood: [], discharge: null,
      tests: { ovulation: null, pregnancy: null }, pain: [], notes: 'a private thought',
      source: 'clue', precision: 'exact',
    },
  },
  ...(sharing ? { sharing } : {}),
});

describe('shareState', () => {
  it('describes a document that has never shared', () => {
    expect(shareState(doc())).toEqual({
      key: null, scope: 'dates', viewers: [], identity: null, lastPush: null,
    });
  });

  it('reads back what was stored', () => {
    const withIt = withSharing(doc(), { key: 'KEY', scope: 'symptoms' });
    expect(shareState(withIt).key).toBe('KEY');
    expect(shareState(withIt).scope).toBe('symptoms');
  });
});

describe('purity', () => {
  it('leaves the document it was given untouched', () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    withSharing(before, { key: 'KEY', scope: 'dates' });
    withViewer(before, { uid: 'u', label: 'partner', grantedAt: '2015-03-26' });
    withPushResult(before, { at: '2015-03-26', status: 'ok' });
    withoutSharing(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('viewers', () => {
  const shared = () => withSharing(doc(), { key: 'KEY', scope: 'dates' });

  it('adds one', () => {
    const after = withViewer(shared(), { uid: 'viewer-one', label: 'partner', grantedAt: '2015-03-26' });
    expect(shareState(after).viewers).toEqual([
      { uid: 'viewer-one', label: 'partner', grantedAt: '2015-03-26' },
    ]);
  });

  it('replaces rather than duplicating the same uid', () => {
    let after = withViewer(shared(), { uid: 'viewer-one', label: 'old', grantedAt: '2015-03-26' });
    after = withViewer(after, { uid: 'viewer-one', label: 'new', grantedAt: '2015-04-01' });
    expect(shareState(after).viewers).toHaveLength(1);
    expect(shareState(after).viewers[0].label).toBe('new');
  });

  it('removes one and leaves the others', () => {
    let after = withViewer(shared(), { uid: 'one', label: 'a', grantedAt: '2015-03-26' });
    after = withViewer(after, { uid: 'two', label: 'b', grantedAt: '2015-03-26' });
    expect(shareState(withoutViewer(after, 'one')).viewers.map(v => v.uid)).toEqual(['two']);
  });

  it('removing a viewer who is not there changes nothing', () => {
    const after = withoutViewer(shared(), 'nobody');
    expect(shareState(after).viewers).toEqual([]);
  });
});

describe('withoutSharing', () => {
  it('drops the whole section, key included', () => {
    const shared = withViewer(
      withSharing(doc(), { key: 'KEY', scope: 'everything' }),
      { uid: 'u', label: 'partner', grantedAt: '2015-03-26' },
    );
    const after = withoutSharing(shared);
    expect(after.sharing).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('KEY');
  });

  it('leaves her history alone', () => {
    const after = withoutSharing(withSharing(doc(), { key: 'KEY', scope: 'dates' }));
    expect(after.spans).toEqual(doc().spans);
    expect(after.days).toEqual(doc().days);
  });
});

describe('the identity', () => {
  it('stores the anonymous uid and refresh token inside the encrypted document', () => {
    const after = withIdentity(doc(), { uid: 'anon-uid', refreshToken: 'refresh' });
    expect(shareState(after).identity).toEqual({ uid: 'anon-uid', refreshToken: 'refresh' });
  });

  it('survives a scope change, which must not log the device out', () => {
    let after = withIdentity(withSharing(doc(), { key: 'KEY', scope: 'dates' }), { uid: 'u', refreshToken: 'r' });
    after = withScope(after, 'everything');
    expect(shareState(after).identity).toEqual({ uid: 'u', refreshToken: 'r' });
    expect(shareState(after).scope).toBe('everything');
  });
});

describe('the push result', () => {
  it('records a success with its date', () => {
    const after = withPushResult(doc(), { at: '2015-03-26', status: 'ok' });
    expect(shareState(after).lastPush).toEqual({ at: '2015-03-26', status: 'ok' });
  });

  // Review Focus 3: she must be able to tell "he has this" from "this never
  // left the phone".
  it('records a failure and says which kind', () => {
    const after = withPushResult(doc(), { at: '2015-03-26', status: 'offline' });
    expect(shareState(after).lastPush.status).toBe('offline');
  });

  it('describes a success in words she can act on', () => {
    expect(describePush({ at: '2015-03-26', status: 'ok' })).toMatch(/2015-03-26/);
    expect(describePush({ at: '2015-03-26', status: 'ok' })).not.toMatch(/not|fail/i);
  });

  it('describes being offline as pending, not as broken', () => {
    expect(describePush({ at: '2015-03-26', status: 'offline' })).toMatch(/not .*sent|waiting|when you/i);
  });

  it('describes a refusal as something she has to fix', () => {
    expect(describePush({ at: '2015-03-26', status: 'denied' })).toMatch(/permission|refused|denied/i);
  });

  it('says nothing has been sent when nothing has', () => {
    expect(describePush(null)).toMatch(/not .*shared|nothing/i);
  });
});

describe('buildPayload', () => {
  const sharing = { key: generateSyncKey(), scope: 'dates' };

  it('seals the projection, not the document', async () => {
    const payload = await buildPayload(doc(), { ...sharing, updatedAt: '2015-03-26' });
    const plaintext = await openPayload(await importSyncKey(sharing.key), payload);
    const projected = JSON.parse(plaintext);
    expect(projected.spans).toHaveLength(1);
    expect(projected.days).toEqual({});          // the dates scope carries none
  });

  it('carries the metadata the viewer and the rules need', async () => {
    const payload = await buildPayload(doc(), { ...sharing, updatedAt: '2015-03-26' });
    expect(payload.scope).toBe('dates');
    expect(payload.updatedAt).toBe('2015-03-26');
    expect(payload.schemaVersion).toBe(SHARE_SCHEMA_VERSION);
    expect(Object.keys(payload).sort())
      .toEqual(['ciphertext', 'iv', 'schemaVersion', 'scope', 'updatedAt']);
  });

  // Review Focus 1, at the last point it could go wrong.
  it('leaks neither the key nor a note into the payload', async () => {
    const shared = withSharing(doc(), sharing);
    const payload = await buildPayload(shared, { ...sharing, updatedAt: '2015-03-26' });
    const text = JSON.stringify(payload);
    expect(text).not.toContain(sharing.key);
    expect(text).not.toContain('a private thought');
    expect(text).not.toContain('sharing');
  });

  it('includes the notes only under the everything scope', async () => {
    const key = generateSyncKey();
    const wide = await buildPayload(doc(), { key, scope: 'everything', updatedAt: '2015-03-26' });
    const plaintext = await openPayload(await importSyncKey(key), wide);
    expect(plaintext).toContain('a private thought');
  });

  it('refuses to build a payload with no key', async () => {
    await expect(buildPayload(doc(), { key: null, scope: 'dates', updatedAt: '2015-03-26' }))
      .rejects.toThrow(/key/i);
  });

  it('refuses an unknown scope rather than sending everything', async () => {
    await expect(buildPayload(doc(), { key: generateSyncKey(), scope: 'all-of-it', updatedAt: '2015-03-26' }))
      .rejects.toThrow(/scope/i);
  });
});
