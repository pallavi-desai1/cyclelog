// Firestore and Identity Toolkit over plain fetch. No SDK: the host of the
// ciphertext must not also supply the code that handles the key, and the app
// has no runtime dependencies to spend on one either.
//
// Every function takes its transport. Nothing here reaches for
// globalThis.fetch, so every failure path is reachable from a test.

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN = 'https://securetoken.googleapis.com/v1';
const FIRESTORE = 'https://firestore.googleapis.com/v1';

export class SyncError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.status = status;
  }
}

// Which kind of failure this is, because the UI says something different for
// each: offline is "it will go when you reconnect", denied is "he has no
// grant", unauthenticated is "this device needs to pair again".
//
// `isAuthEndpoint` scopes the blanket 400 mapping: on Identity Toolkit a 400
// really does mean the credential is wrong, but on Firestore a 400 is a
// malformed field or a bad document mask — telling her to re-pair a working
// device while the real bug (a data-shape problem) goes unmentioned.
function kindFor(status, message, { isAuthEndpoint = false } = {}) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'denied';
  if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED/i.test(message)) return 'unauthenticated';
  if (/ADMIN_ONLY_OPERATION|OPERATION_NOT_ALLOWED/i.test(message)) return 'unauthenticated';
  if (status >= 500) return 'server';
  if (status === 400) return isAuthEndpoint ? 'unauthenticated' : 'server';
  return 'server';
}

function friendly(message) {
  if (/ADMIN_ONLY_OPERATION|OPERATION_NOT_ALLOWED/i.test(message)) {
    return 'Anonymous sign-in is not enabled on this Firebase project '
      + '(Authentication → Sign-in method → Anonymous).';
  }
  return message;
}

async function request(fetchImpl, url, options = {}, { isAuthEndpoint = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    // fetch rejects only on a transport failure; everything else is a status.
    throw new SyncError('offline', 'No connection to the sync service.');
  }

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const message = (body.error && body.error.message) || `HTTP ${response.status}`;
    throw new SyncError(
      kindFor(response.status, message, { isAuthEndpoint }),
      friendly(message),
      response.status,
    );
  }
  return body;
}

// A malformed response must not surface as NaN, Infinity or -0 — an explicit
// null (or a normalised 0) instead. Number.isFinite(-0) is true, so the
// finite check alone is not enough: a signed zero has to be folded into 0.
function toFiniteNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Object.is(number, -0) ? 0 : number;
}

const postJson = (body, idToken = null) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
  },
  body: JSON.stringify(body),
});

export async function signInAnonymously({ apiKey, fetchImpl }) {
  const body = await request(
    fetchImpl,
    `${IDENTITY}/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    postJson({ returnSecureToken: true }),
    { isAuthEndpoint: true },
  );
  return {
    uid: body.localId,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresInSeconds: toFiniteNumber(body.expiresIn),
  };
}

export async function refreshIdToken({ apiKey, refreshToken, fetchImpl }) {
  const body = await request(
    fetchImpl,
    `${TOKEN}/token?key=${encodeURIComponent(apiKey)}`,
    postJson({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    { isAuthEndpoint: true },
  );
  return {
    uid: body.user_id,
    idToken: body.id_token,
    expiresInSeconds: toFiniteNumber(body.expires_in),
  };
}

// Firestore's REST shape: every value is tagged with its type.
const TYPED = {
  string: value => ({ stringValue: value }),
  number: value => ({ integerValue: String(value) }),
};

function toFields(payload) {
  const fields = {};
  for (const [name, value] of Object.entries(payload)) {
    const encode = TYPED[typeof value];
    if (encode === undefined) throw new SyncError('server', `cannot send a ${typeof value} to Firestore`);
    fields[name] = encode(value);
  }
  return fields;
}

function fromFields(fields = {}) {
  const payload = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value.stringValue !== undefined) payload[name] = value.stringValue;
    else if (value.integerValue !== undefined) payload[name] = toFiniteNumber(value.integerValue);
    else if (value.booleanValue !== undefined) payload[name] = value.booleanValue;
    else {
      // Symmetric with toFields, which throws on a type it cannot send: a
      // type this decoder cannot read must not just vanish from the result,
      // which would make a corrupted ciphertext field look like a validly
      // shaped payload with that field absent.
      const [type] = Object.keys(value);
      throw new SyncError('server', `cannot decode a Firestore ${type ?? 'unknown'} value for "${name}"`);
    }
  }
  return payload;
}

const documentUrl = (projectId, path) => `${FIRESTORE}/projects/${projectId}/databases/(default)/documents/${path}`;

// Uids are opaque strings handed to us, not path syntax; encode each
// dynamic segment on its own so a stray '/' or other reserved character
// can't be read back as a path separator. Firebase uids are alphanumeric
// today, so this guards an assumption rather than a live bug.
const segment = value => encodeURIComponent(value);

const patch = (idToken, fields) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ fields }),
});

export async function putVault({ projectId, idToken, ownerUid, payload, fetchImpl }) {
  await request(
    fetchImpl,
    documentUrl(projectId, `vaults/${segment(ownerUid)}`),
    patch(idToken, toFields(payload)),
  );
}

export async function getVault({ projectId, idToken, ownerUid, fetchImpl }) {
  try {
    const body = await request(fetchImpl, documentUrl(projectId, `vaults/${segment(ownerUid)}`), {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    return fromFields(body.fields);
  } catch (error) {
    // Nothing shared yet is not a failure. A refusal is, and must not be
    // flattened into "no data" — a revoked viewer has to be told.
    if (error instanceof SyncError && error.status === 404) return null;
    throw error;
  }
}

export async function grantViewer({
  projectId, idToken, ownerUid, viewerUid, label, grantedAt, fetchImpl,
}) {
  await request(
    fetchImpl,
    documentUrl(projectId, `vaults/${segment(ownerUid)}/viewers/${segment(viewerUid)}`),
    patch(idToken, toFields({ label, grantedAt })),
  );
}

export async function revokeViewer({ projectId, idToken, ownerUid, viewerUid, fetchImpl }) {
  try {
    await request(fetchImpl, documentUrl(projectId, `vaults/${segment(ownerUid)}/viewers/${segment(viewerUid)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch (error) {
    // Already gone is the state she asked for.
    if (error instanceof SyncError && error.status === 404) return;
    throw error;
  }
}

// Pulled out of listViewers so a malformed document — one with no name at
// all — fails as a typed SyncError instead of a raw TypeError reaching the
// caller. Thrown, not skipped: a document the API cannot even identify is
// an anomaly worth surfacing, the same call made for an unreadable field
// value above.
function viewerUidFromName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SyncError('server', 'malformed viewer document: missing name');
  }
  return name.split('/').pop();
}

export async function listViewers({ projectId, idToken, ownerUid, fetchImpl }) {
  const body = await request(fetchImpl, documentUrl(projectId, `vaults/${segment(ownerUid)}/viewers`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return (body.documents ?? []).map(document => {
    const fields = fromFields(document.fields);
    return {
      uid: viewerUidFromName(document.name),
      label: fields.label ?? '',
      grantedAt: fields.grantedAt ?? null,
    };
  });
}
