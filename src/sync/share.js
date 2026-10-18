import { sealPayload, importSyncKey } from './key.js';
import { projectDocument } from './scope.js';

export const SHARE_SCHEMA_VERSION = 1;

const DEFAULTS = { key: null, scope: 'dates', viewers: [], identity: null, lastPush: null };

// This is the third time in this plan that a top level got copied and a
// nested value did not (after `medicine` in the scope projection, and the
// two call sites this fixes below): arrays mapped, plain objects rebuilt,
// scalars returned as-is, so a nested field added later is copied by
// construction rather than by someone remembering to.
const deepCopy = (value) => {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [field, nested] of Object.entries(value)) out[field] = deepCopy(nested);
    return out;
  }
  return value;
};

// Sharing state lives in the document, so it is encrypted under her
// passphrase and comes back with a restore. Task 2's projection strips the
// whole section, which is what keeps the key out of the ciphertext. Deep
// copied on the way out: this is the only way anything reads the section,
// so a caller mutating e.g. `viewers[0]` must not reach the document.
export function shareState(doc) {
  const sharing = doc.sharing ?? {};
  return {
    key: sharing.key ?? DEFAULTS.key,
    scope: sharing.scope ?? DEFAULTS.scope,
    viewers: deepCopy(sharing.viewers ?? DEFAULTS.viewers),
    identity: deepCopy(sharing.identity ?? DEFAULTS.identity),
    lastPush: deepCopy(sharing.lastPush ?? DEFAULTS.lastPush),
  };
}

// Every with* helper funnels through here, so the deep copy belongs on this
// side of the merge: whatever the caller handed in `changes` (an identity
// object, a push-result object, a freshly-built viewer list) is copied
// before it is stored, so a caller that later mutates its own object in
// place cannot rewrite a value already saved in a document handed elsewhere.
const withState = (doc, changes) => ({
  ...doc,
  sharing: deepCopy({ ...shareState(doc), ...changes }),
});

export const withSharing = (doc, { key, scope }) => withState(doc, { key, scope });
export const withScope = (doc, scope) => withState(doc, { scope });
export const withIdentity = (doc, identity) => withState(doc, { identity });
export const withPushResult = (doc, lastPush) => withState(doc, { lastPush });

// The `{ ...viewer }` this line used to add is redundant now: withState
// deep-copies everything it stores, including this array and the viewer
// inside it.
export function withViewer(doc, viewer) {
  const others = shareState(doc).viewers.filter(existing => existing.uid !== viewer.uid);
  return withState(doc, { viewers: [...others, viewer] });
}

export function withoutViewer(doc, uid) {
  return withState(doc, { viewers: shareState(doc).viewers.filter(v => v.uid !== uid) });
}

// Stops sharing entirely. The section goes, key and all: a key kept after
// she said stop is a key that can still decrypt whatever he cached.
export function withoutSharing(doc) {
  const next = { ...doc };
  delete next.sharing;
  return next;
}

export function describePush(lastPush) {
  if (lastPush === null) return 'Nothing has been shared yet.';
  if (lastPush.status === 'ok') return `Shared with him on ${lastPush.at}.`;
  if (lastPush.status === 'offline') {
    return `Not sent yet — last tried ${lastPush.at}. It will go when you are back online.`;
  }
  if (lastPush.status === 'denied') {
    return `Refused on ${lastPush.at}: permission was denied. Check the viewer is still granted.`;
  }
  return `Not sent on ${lastPush.at} — something went wrong. Try again.`;
}

export async function buildPayload(doc, { key, scope, updatedAt }) {
  if (!key) throw new Error('cannot build a share payload without a sync key');
  // projectDocument throws on an unknown scope, which is the behaviour we
  // want: an unrecognised scope must never fall back to sending everything.
  const projected = projectDocument(doc, scope);
  const sealed = await sealPayload(await importSyncKey(key), JSON.stringify(projected));
  return {
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    scope,
    updatedAt,
    schemaVersion: SHARE_SCHEMA_VERSION,
  };
}
