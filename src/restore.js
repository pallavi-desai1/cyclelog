import { EXPORT_VERSION } from './export.js';
import { readMeta, writeMeta, VAULT_KEY } from './store.js';

export const BACKUP_KIND = 'cyclelog-backup';

// Which of her own files this is. The Clue export and the hand-written log
// have their own picker; this one takes what CycleLog itself wrote.
export function classifyRestoreFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  if (parsed.kind === BACKUP_KIND) return 'backup';
  // A plaintext export is the document itself: versioned, with its sections.
  if (parsed.days && parsed.spans && parsed.birthControl) return 'document';
  return 'unknown';
}

export function parseBackupBundle(text) {
  const parsed = JSON.parse(text);
  if (parsed.kind !== BACKUP_KIND) {
    throw new Error(`this file is not a CycleLog backup (kind: ${parsed.kind ?? 'none'})`);
  }
  if (parsed.version !== EXPORT_VERSION) {
    throw new Error(`unsupported backup version ${parsed.version}`);
  }
  if (!parsed.meta) throw new Error('the backup has no key material in it');
  if (!parsed.vault) throw new Error('the backup has no sealed vault in it');
  for (const field of ['salt', 'iterations', 'wrapped']) {
    if (parsed.meta[field] === undefined) {
      throw new Error(`the backup's key material has no ${field}`);
    }
  }
  return { meta: parsed.meta, vault: parsed.vault };
}

// Puts a backup onto this device. The passphrase is not needed here and is
// never seen: the sealed blob and the wrapped key go back exactly as they
// were, and the ordinary unlock path opens them.
export async function restoreBackup(backend, { meta, vault }) {
  // Vault first, meta second. A failure between them leaves the device
  // reporting 'empty' rather than 'locked', which setup can recover from —
  // the reverse would offer a lock screen for a vault that is not there.
  await backend.set(VAULT_KEY, vault);
  await writeMeta(backend, meta);
}

// When she last took a backup. It lives beside the salt in the unencrypted
// meta rather than inside the document, so recording it needs no re-seal and
// cannot touch her history.
export async function markBackup(backend, dateISO) {
  const meta = await readMeta(backend);
  if (meta === null) return;
  await writeMeta(backend, { ...meta, lastBackupAt: dateISO });
}

export async function readLastBackup(backend) {
  const meta = await readMeta(backend);
  return (meta && meta.lastBackupAt) || null;
}

// Without this, the browser is free to treat the vault as cache and evict it.
// Safari has shipped without the API entirely, so every failure here is
// reported rather than thrown: persistence is a request, not a requirement.
export async function requestPersistentStorage(navigatorLike = globalThis.navigator) {
  try {
    const storage = navigatorLike && navigatorLike.storage;
    if (!storage || !storage.persist || !storage.persisted) return false;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
