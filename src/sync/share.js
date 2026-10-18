import { sealPayload, importSyncKey } from './key.js';
import { projectDocument } from './scope.js';

export const SHARE_SCHEMA_VERSION = 1;

const DEFAULTS = { key: null, scope: 'dates', viewers: [], identity: null, lastPush: null };

// Sharing state lives in the document, so it is encrypted under her
// passphrase and comes back with a restore. Task 2's projection strips the
// whole section, which is what keeps the key out of the ciphertext.
export function shareState(doc) {
  const sharing = doc.sharing ?? {};
  return {
    key: sharing.key ?? DEFAULTS.key,
    scope: sharing.scope ?? DEFAULTS.scope,
    viewers: [...(sharing.viewers ?? DEFAULTS.viewers)],
    identity: sharing.identity ?? DEFAULTS.identity,
    lastPush: sharing.lastPush ?? DEFAULTS.lastPush,
  };
}

const withState = (doc, changes) => ({
  ...doc,
  sharing: { ...shareState(doc), ...changes },
});

export const withSharing = (doc, { key, scope }) => withState(doc, { key, scope });
export const withScope = (doc, scope) => withState(doc, { scope });
export const withIdentity = (doc, identity) => withState(doc, { identity });
export const withPushResult = (doc, lastPush) => withState(doc, { lastPush });

export function withViewer(doc, viewer) {
  const others = shareState(doc).viewers.filter(existing => existing.uid !== viewer.uid);
  return withState(doc, { viewers: [...others, { ...viewer }] });
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
