import { describe, it, expect } from 'vitest';
import {
  viewerRecord, parseViewerRecord, isViewerRecord, fetchShared,
} from '../src/sync/viewer.js';
import { renderViewerHeader } from '../src/ui/viewer.js';
import { generateSyncKey, importSyncKey, sealPayload } from '../src/sync/key.js';
import { SHARE_SCHEMA_VERSION } from '../src/sync/share.js';

const record = () => ({
  ownerUid: 'owner-uid',
  key: generateSyncKey(),
  identity: { uid: 'viewer-uid', refreshToken: 'refresh' },
});

const shared = { version: 1, spans: [{ start: '2015-01-29', end: '2015-02-02', source: 'clue' }], gaps: [], birthControl: [], days: {} };

function stubFetch(response) {
  return async () => ({ ok: true, status: 200, json: async () => response });
}

// Important 7: scope and updatedAt travel sealed, inside the ciphertext,
// alongside the document — not merely as the outer Firestore fields a host
// could relabel or replay. This builds what buildPayload actually produces,
// so fetchShared is exercised against its real shape, not a hand-rolled one.
const sealedWrapper = (key, { scope = 'dates', updatedAt = '2015-03-26' } = {}) => (
  sealPayload(key, JSON.stringify({ document: shared, scope, updatedAt }))
);

describe('the viewer record', () => {
  it('round-trips', () => {
    const original = record();
    expect(parseViewerRecord(viewerRecord(original))).toEqual(original);
  });

  it('is recognisable, so his app knows which mode it is in', () => {
    expect(isViewerRecord(viewerRecord(record()))).toBe(true);
    expect(isViewerRecord('{"version":1,"days":{},"spans":[],"gaps":[],"birthControl":[]}')).toBe(false);
  });

  it('refuses a record with no owner, key or identity', () => {
    for (const missing of ['ownerUid', 'key', 'identity']) {
      const broken = record();
      delete broken[missing];
      expect(() => parseViewerRecord(viewerRecord(broken)), missing).toThrow(new RegExp(missing, 'i'));
    }
  });

  it('refuses something that is not a record at all', () => {
    expect(() => parseViewerRecord('not json')).toThrow();
  });
});

describe('fetchShared', () => {
  it('decrypts what the owner wrote', async () => {
    const mine = record();
    const sealed = await sealedWrapper(await importSyncKey(mine.key));
    const result = await fetchShared({
      record: mine,
      idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext },
          iv: { stringValue: sealed.iv },
          scope: { stringValue: 'dates' },
          updatedAt: { stringValue: '2015-03-26' },
          schemaVersion: { integerValue: String(SHARE_SCHEMA_VERSION) },
        },
      }),
    });
    expect(result.doc).toEqual(shared);
    expect(result.scope).toBe('dates');
    expect(result.updatedAt).toBe('2015-03-26');
  });

  // Important 7: the outer Firestore fields are forged here to say
  // something different from what was sealed — proving the viewer reads
  // scope and updatedAt from the AEAD-protected copy, which the host
  // cannot have relabelled, rather than from fields the host does control.
  it('trusts the sealed scope and updatedAt, not the outer Firestore fields', async () => {
    const mine = record();
    const sealed = await sealedWrapper(await importSyncKey(mine.key), {
      scope: 'dates', updatedAt: '2015-03-26',
    });
    const result = await fetchShared({
      record: mine,
      idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext },
          iv: { stringValue: sealed.iv },
          // Forged: a host (or a tampered response) claiming a wider scope
          // and a newer date than what the owner actually sealed.
          scope: { stringValue: 'everything' },
          updatedAt: { stringValue: '2016-01-01' },
          schemaVersion: { integerValue: String(SHARE_SCHEMA_VERSION) },
        },
      }),
    });
    expect(result.scope).toBe('dates');
    expect(result.updatedAt).toBe('2015-03-26');
  });

  it('reports nothing shared yet rather than inventing an empty document', async () => {
    const result = await fetchShared({
      record: record(), idToken: 'id',
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(result).toBeNull();
  });

  // The wrong key must say so. An empty calendar would read as "she has not
  // logged anything", which is a lie about her body.
  it('throws when the key cannot open it', async () => {
    const mine = record();
    const sealed = await sealedWrapper(await importSyncKey(generateSyncKey()));
    await expect(fetchShared({
      record: mine, idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext }, iv: { stringValue: sealed.iv },
          scope: { stringValue: 'dates' }, updatedAt: { stringValue: '2015-03-26' },
          schemaVersion: { integerValue: String(SHARE_SCHEMA_VERSION) },
        },
      }),
    })).rejects.toThrow();
  });

  it('passes a revoked grant through as denied', async () => {
    await expect(fetchShared({
      record: record(), idToken: 'id',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'denied' } }) }),
    })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('refuses a payload from a schema version it does not understand', async () => {
    const mine = record();
    const sealed = await sealedWrapper(await importSyncKey(mine.key));
    await expect(fetchShared({
      record: mine, idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext }, iv: { stringValue: sealed.iv },
          scope: { stringValue: 'dates' }, updatedAt: { stringValue: '2015-03-26' },
          schemaVersion: { integerValue: '99' },
        },
      }),
    })).rejects.toThrow(/version 99/);
  });
});

describe('renderViewerHeader', () => {
  it('says whose data it is and how fresh', () => {
    const html = renderViewerHeader({ scope: 'dates', updatedAt: '2015-03-26', label: 'Pallavi' });
    expect(html).toContain('Pallavi');
    expect(html).toContain('2015-03-26');
  });

  it('names the scope, so he knows what he is not seeing', () => {
    expect(renderViewerHeader({ scope: 'dates', updatedAt: '2015-03-26', label: 'her' }))
      .toMatch(/dates and predictions/i);
    expect(renderViewerHeader({ scope: 'everything', updatedAt: '2015-03-26', label: 'her' }))
      .toMatch(/everything/i);
  });

  it('says it is read-only', () => {
    expect(renderViewerHeader({ scope: 'dates', updatedAt: '2015-03-26', label: 'her' }))
      .toMatch(/read-only|view only/i);
  });

  // The grant she makes names his sync id, and pairing a second time mints
  // him a new one — so when a 403 says "the grant was removed", the first
  // thing either of them needs is his CURRENT id. Showing it only once on
  // the setup screen meant the one value needed to repair the grant was the
  // one value no longer on screen, and re-pairing to see it again changed
  // it. It belongs on this screen, permanently.
  it('shows him his own sync id so a stale grant can be repaired', () => {
    const html = renderViewerHeader({
      scope: 'dates', updatedAt: '2015-03-26', label: 'her', uid: 'VIEWERUID123',
    });
    expect(html).toContain('VIEWERUID123');
    expect(html).toMatch(/your sync id/i);
  });

  it('shows his sync id even before anything has been shared with him', () => {
    const html = renderViewerHeader({
      scope: null, updatedAt: null, label: '', uid: 'VIEWERUID123',
    });
    expect(html).toContain('VIEWERUID123');
  });

  it('prints no null, undefined or NaN when nothing has arrived yet', () => {
    expect(renderViewerHeader({ scope: null, updatedAt: null, label: '' }))
      .not.toMatch(/null|undefined|NaN/);
    expect(renderViewerHeader({ scope: null, updatedAt: null, label: '', uid: null }))
      .not.toMatch(/null|undefined|NaN/);
  });
});
