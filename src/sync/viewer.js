import { importSyncKey, openPayload } from './key.js';
import { SyncError, getVault } from './firestore.js';
import { SHARE_SCHEMA_VERSION } from './share.js';
import { parseDocument } from '../import.js';

const KIND = 'cyclelog-viewer';

// What his vault holds instead of a document: whose data to fetch, the key to
// read it with, and his own anonymous identity. Sealed under his passphrase by
// the same vault code hers uses.
export function viewerRecord({ ownerUid, key, identity }) {
  return JSON.stringify({ kind: KIND, version: 1, ownerUid, key, identity });
}

export function isViewerRecord(text) {
  try {
    return JSON.parse(text).kind === KIND;
  } catch {
    return false;
  }
}

export function parseViewerRecord(text) {
  const parsed = JSON.parse(text);
  if (parsed.kind !== KIND) throw new Error('that is not a viewer record');
  for (const field of ['ownerUid', 'key', 'identity']) {
    if (!parsed[field]) throw new Error(`the viewer record has no ${field}`);
  }
  return { ownerUid: parsed.ownerUid, key: parsed.key, identity: parsed.identity };
}

// Fetch, decrypt, parse. A decryption failure is thrown, never flattened into
// an empty document: an empty calendar would read as "she has logged nothing",
// which is a lie about her body.
export async function fetchShared({ record, idToken, fetchImpl, projectId }) {
  const payload = await getVault({
    projectId, idToken, ownerUid: record.ownerUid, fetchImpl,
  });
  if (payload === null) return null;
  if (payload.schemaVersion !== SHARE_SCHEMA_VERSION) {
    throw new SyncError('server', `unsupported shared version ${payload.schemaVersion}`);
  }
  const plaintext = await openPayload(await importSyncKey(record.key), payload);
  // Important 7: scope and updatedAt are read from the sealed copy, never
  // from the outer Firestore fields — the host controls those, and could
  // relabel the scope or replay an older updatedAt without the key. Only
  // what the AEAD actually authenticated is trusted here.
  const sealed = JSON.parse(plaintext);
  return {
    doc: parseDocument(JSON.stringify(sealed.document)),
    scope: sealed.scope,
    updatedAt: sealed.updatedAt,
  };
}
