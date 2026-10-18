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
function kindFor(status, message) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'denied';
  if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED/i.test(message)) return 'unauthenticated';
  if (/ADMIN_ONLY_OPERATION|OPERATION_NOT_ALLOWED/i.test(message)) return 'unauthenticated';
  if (status >= 500) return 'server';
  if (status === 400) return 'unauthenticated';
  return 'server';
}

function friendly(message) {
  if (/ADMIN_ONLY_OPERATION|OPERATION_NOT_ALLOWED/i.test(message)) {
    return 'Anonymous sign-in is not enabled on this Firebase project '
      + '(Authentication → Sign-in method → Anonymous).';
  }
  return message;
}

async function request(fetchImpl, url, options = {}) {
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
    throw new SyncError(kindFor(response.status, message), friendly(message), response.status);
  }
  return body;
}

// A malformed response must not surface as NaN — an explicit null says
// "unknown" instead of silently poisoning downstream arithmetic.
function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  }
  return payload;
}

const documentUrl = (projectId, path) => `${FIRESTORE}/projects/${projectId}/databases/(default)/documents/${path}`;

const patch = (idToken, fields) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ fields }),
});

export async function putVault({ projectId, idToken, ownerUid, payload, fetchImpl }) {
  await request(
    fetchImpl,
    documentUrl(projectId, `vaults/${ownerUid}`),
    patch(idToken, toFields(payload)),
  );
}

export async function getVault({ projectId, idToken, ownerUid, fetchImpl }) {
  try {
    const body = await request(fetchImpl, documentUrl(projectId, `vaults/${ownerUid}`), {
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
    documentUrl(projectId, `vaults/${ownerUid}/viewers/${viewerUid}`),
    patch(idToken, toFields({ label, grantedAt })),
  );
}

export async function revokeViewer({ projectId, idToken, ownerUid, viewerUid, fetchImpl }) {
  try {
    await request(fetchImpl, documentUrl(projectId, `vaults/${ownerUid}/viewers/${viewerUid}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch (error) {
    // Already gone is the state she asked for.
    if (error instanceof SyncError && error.status === 404) return;
    throw error;
  }
}

export async function listViewers({ projectId, idToken, ownerUid, fetchImpl }) {
  const body = await request(fetchImpl, documentUrl(projectId, `vaults/${ownerUid}/viewers`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return (body.documents ?? []).map(document => {
    const fields = fromFields(document.fields);
    return {
      uid: document.name.split('/').pop(),
      label: fields.label ?? '',
      grantedAt: fields.grantedAt ?? null,
    };
  });
}
