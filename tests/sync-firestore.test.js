import { describe, it, expect } from 'vitest';
import {
  SyncError, signInAnonymously, refreshIdToken,
  putVault, getVault, grantViewer, revokeViewer, listViewers,
} from '../src/sync/firestore.js';

// A stub transport. Every test drives the network by hand, which is the only
// way the failure paths get exercised at all.
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body ? JSON.parse(options.body) : null });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json ?? {},
    };
  };
  return { fetchImpl, calls };
}

const ok = json => ({ status: 200, json });
const PROJECT = { projectId: 'cyclelog-test', idToken: 'id-token-123', ownerUid: 'owner-uid' };
const PAYLOAD = { ciphertext: 'AAAA', iv: 'BBBB', scope: 'dates', updatedAt: '2015-03-26', schemaVersion: 1 };

describe('signInAnonymously', () => {
  it('posts to the identity toolkit with the api key', async () => {
    const { fetchImpl, calls } = stubFetch([
      ok({ localId: 'new-uid', idToken: 'id', refreshToken: 'refresh', expiresIn: '3600' }),
    ]);
    await signInAnonymously({ apiKey: 'api-key', fetchImpl });
    expect(calls[0].url).toContain('identitytoolkit.googleapis.com');
    expect(calls[0].url).toContain('key=api-key');
    expect(calls[0].method).toBe('POST');
  });

  it('asks for a persistent token', async () => {
    const { fetchImpl, calls } = stubFetch([
      ok({ localId: 'new-uid', idToken: 'id', refreshToken: 'refresh', expiresIn: '3600' }),
    ]);
    await signInAnonymously({ apiKey: 'api-key', fetchImpl });
    expect(calls[0].body).toEqual({ returnSecureToken: true });
  });

  it('returns the identity the device will keep', async () => {
    const { fetchImpl } = stubFetch([
      ok({ localId: 'new-uid', idToken: 'id', refreshToken: 'refresh', expiresIn: '3600' }),
    ]);
    expect(await signInAnonymously({ apiKey: 'api-key', fetchImpl })).toEqual({
      uid: 'new-uid', idToken: 'id', refreshToken: 'refresh', expiresInSeconds: 3600,
    });
  });

  it('reports a refusal as unauthenticated rather than throwing a raw error', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, json: { error: { message: 'ADMIN_ONLY_OPERATION' } } }]);
    await expect(signInAnonymously({ apiKey: 'api-key', fetchImpl }))
      .rejects.toMatchObject({ name: 'SyncError', kind: 'unauthenticated' });
  });

  // Anonymous sign-in is off until she enables it in the console, and that is
  // the single most likely setup mistake. The message has to say so.
  it('names the console setting when anonymous sign-in is disabled', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, json: { error: { message: 'ADMIN_ONLY_OPERATION' } } }]);
    await expect(signInAnonymously({ apiKey: 'api-key', fetchImpl }))
      .rejects.toThrow(/anonymous/i);
  });

  it('reports a dead network as offline', async () => {
    const { fetchImpl } = stubFetch([new TypeError('Failed to fetch')]);
    await expect(signInAnonymously({ apiKey: 'api-key', fetchImpl }))
      .rejects.toMatchObject({ kind: 'offline' });
  });
});

describe('refreshIdToken', () => {
  it('posts the refresh token to the token endpoint', async () => {
    const { fetchImpl, calls } = stubFetch([
      ok({ user_id: 'uid', id_token: 'fresh', expires_in: '3600' }),
    ]);
    const result = await refreshIdToken({ apiKey: 'api-key', refreshToken: 'refresh', fetchImpl });
    expect(calls[0].url).toContain('securetoken.googleapis.com');
    expect(calls[0].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh' });
    expect(result).toEqual({ uid: 'uid', idToken: 'fresh', expiresInSeconds: 3600 });
  });

  it('reports an expired refresh token as unauthenticated, so the UI can re-pair', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, json: { error: { message: 'TOKEN_EXPIRED' } } }]);
    await expect(refreshIdToken({ apiKey: 'k', refreshToken: 'r', fetchImpl }))
      .rejects.toMatchObject({ kind: 'unauthenticated' });
  });
});

describe('putVault', () => {
  it('patches the owner document at the path the rules expect', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl });
    expect(calls[0].url).toContain('firestore.googleapis.com');
    expect(calls[0].url).toContain('/databases/(default)/documents/vaults/owner-uid');
    expect(calls[0].method).toBe('PATCH');
  });

  it('authenticates with the id token', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl });
    expect(calls[0].headers.Authorization).toBe('Bearer id-token-123');
  });

  it('sends the payload in Firestore typed-value form', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl });
    expect(calls[0].body.fields.ciphertext).toEqual({ stringValue: 'AAAA' });
    expect(calls[0].body.fields.schemaVersion).toEqual({ integerValue: '1' });
  });

  // Review Focus 1: the only thing that may travel is ciphertext.
  it('sends nothing but the sealed payload', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl });
    expect(Object.keys(calls[0].body.fields).sort())
      .toEqual(['ciphertext', 'iv', 'schemaVersion', 'scope', 'updatedAt']);
  });

  // Review Focus 3: a rejected write must not look like a success.
  it('reports a rules refusal as denied', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, json: { error: { message: 'Missing or insufficient permissions.' } } }]);
    await expect(putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl }))
      .rejects.toMatchObject({ name: 'SyncError', kind: 'denied' });
  });

  it('reports an expired token as unauthenticated', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, json: { error: { message: 'invalid auth' } } }]);
    await expect(putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl }))
      .rejects.toMatchObject({ kind: 'unauthenticated' });
  });

  it('reports a dead network as offline', async () => {
    const { fetchImpl } = stubFetch([new TypeError('Failed to fetch')]);
    await expect(putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl }))
      .rejects.toMatchObject({ kind: 'offline' });
  });

  it('reports a server failure as server', async () => {
    const { fetchImpl } = stubFetch([{ status: 500, json: { error: { message: 'internal' } } }]);
    await expect(putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl }))
      .rejects.toMatchObject({ kind: 'server', status: 500 });
  });

  it('resolves quietly on success, since there is nothing to report', async () => {
    const { fetchImpl } = stubFetch([ok({})]);
    await expect(putVault({ ...PROJECT, payload: PAYLOAD, fetchImpl })).resolves.toBeUndefined();
  });
});

describe('getVault', () => {
  it('reads the owner document and decodes the typed values', async () => {
    const { fetchImpl } = stubFetch([ok({
      fields: {
        ciphertext: { stringValue: 'AAAA' },
        iv: { stringValue: 'BBBB' },
        scope: { stringValue: 'dates' },
        updatedAt: { stringValue: '2015-03-26' },
        schemaVersion: { integerValue: '1' },
      },
    })]);
    expect(await getVault({ ...PROJECT, fetchImpl })).toEqual(PAYLOAD);
  });

  it('returns null when nothing has been shared yet', async () => {
    const { fetchImpl } = stubFetch([{ status: 404, json: { error: { message: 'not found' } } }]);
    expect(await getVault({ ...PROJECT, fetchImpl })).toBeNull();
  });

  it('reports a refusal as denied rather than as an empty vault', async () => {
    // The viewer whose grant was revoked must be told, not shown nothing.
    const { fetchImpl } = stubFetch([{ status: 403, json: { error: { message: 'denied' } } }]);
    await expect(getVault({ ...PROJECT, fetchImpl })).rejects.toMatchObject({ kind: 'denied' });
  });
});

describe('viewer grants', () => {
  it('writes a grant at the path the rules check', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await grantViewer({
      ...PROJECT, viewerUid: 'viewer-uid', label: 'partner', grantedAt: '2015-03-26', fetchImpl,
    });
    expect(calls[0].url).toContain('/vaults/owner-uid/viewers/viewer-uid');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body.fields.label).toEqual({ stringValue: 'partner' });
  });

  it('deletes a grant to revoke', async () => {
    const { fetchImpl, calls } = stubFetch([ok({})]);
    await revokeViewer({ ...PROJECT, viewerUid: 'viewer-uid', fetchImpl });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/vaults/owner-uid/viewers/viewer-uid');
  });

  it('treats revoking a grant that is already gone as done', async () => {
    const { fetchImpl } = stubFetch([{ status: 404, json: {} }]);
    await expect(revokeViewer({ ...PROJECT, viewerUid: 'gone', fetchImpl })).resolves.toBeUndefined();
  });

  it('lists the viewers with their labels', async () => {
    const { fetchImpl } = stubFetch([ok({
      documents: [
        { name: 'projects/p/databases/(default)/documents/vaults/owner-uid/viewers/viewer-one', fields: { label: { stringValue: 'partner' }, grantedAt: { stringValue: '2015-03-26' } } },
      ],
    })]);
    expect(await listViewers({ ...PROJECT, fetchImpl })).toEqual([
      { uid: 'viewer-one', label: 'partner', grantedAt: '2015-03-26' },
    ]);
  });

  it('returns an empty list when nobody is granted', async () => {
    const { fetchImpl } = stubFetch([ok({})]);
    expect(await listViewers({ ...PROJECT, fetchImpl })).toEqual([]);
  });
});
