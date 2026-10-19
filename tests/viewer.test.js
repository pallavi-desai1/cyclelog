import { describe, it, expect } from 'vitest';
import {
  viewerRecord, parseViewerRecord, isViewerRecord, fetchShared,
} from '../src/sync/viewer.js';
import { renderViewerHeader } from '../src/ui/viewer.js';
import { generateSyncKey, importSyncKey, sealPayload } from '../src/sync/key.js';

const record = () => ({
  ownerUid: 'owner-uid',
  key: generateSyncKey(),
  identity: { uid: 'viewer-uid', refreshToken: 'refresh' },
});

const shared = { version: 1, spans: [{ start: '2015-01-29', end: '2015-02-02', source: 'clue' }], gaps: [], birthControl: [], days: {} };

function stubFetch(response) {
  return async () => ({ ok: true, status: 200, json: async () => response });
}

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
    const sealed = await sealPayload(await importSyncKey(mine.key), JSON.stringify(shared));
    const result = await fetchShared({
      record: mine,
      idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext },
          iv: { stringValue: sealed.iv },
          scope: { stringValue: 'dates' },
          updatedAt: { stringValue: '2015-03-26' },
          schemaVersion: { integerValue: '1' },
        },
      }),
    });
    expect(result.doc).toEqual(shared);
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
    const sealed = await sealPayload(await importSyncKey(generateSyncKey()), JSON.stringify(shared));
    await expect(fetchShared({
      record: mine, idToken: 'id',
      fetchImpl: stubFetch({
        fields: {
          ciphertext: { stringValue: sealed.ciphertext }, iv: { stringValue: sealed.iv },
          scope: { stringValue: 'dates' }, updatedAt: { stringValue: '2015-03-26' },
          schemaVersion: { integerValue: '1' },
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
    const sealed = await sealPayload(await importSyncKey(mine.key), JSON.stringify(shared));
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

  it('prints no null, undefined or NaN when nothing has arrived yet', () => {
    expect(renderViewerHeader({ scope: null, updatedAt: null, label: '' }))
      .not.toMatch(/null|undefined|NaN/);
  });
});
