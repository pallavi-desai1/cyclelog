import { parseLegacyLog } from './importers/legacy.js';
import { parseClueMeasurements } from './importers/clue.js';
import { mergeSources } from './merge.js';

export const DOCUMENT_VERSION = 1;

const SECTIONS = ['days', 'spans', 'gaps', 'birthControl'];

export function emptyDocument() {
  return { version: DOCUMENT_VERSION, days: {}, spans: [], gaps: [], birthControl: [] };
}

export function documentFromSources({ clueJson = null, legacyText = null } = {}) {
  const sources = [];
  const warnings = [];

  // Legacy first, always: mergeSources resolves duplicate spans by source
  // rank, and a stable order makes the merge independent of which file she
  // happened to pick first.
  if (legacyText) {
    const parsed = parseLegacyLog(legacyText);
    sources.push(parsed);
    warnings.push(...(parsed.warnings ?? []));
  }
  if (clueJson) {
    const parsed = parseClueMeasurements(clueJson);
    sources.push(parsed);
    warnings.push(...(parsed.warnings ?? []));
  }
  if (sources.length === 0) throw new Error('no sources to import');

  const { doc, conflicts } = mergeSources(...sources);
  return { doc: { ...doc, version: DOCUMENT_VERSION }, warnings, conflicts };
}

export function serializeDocument(doc) {
  return JSON.stringify(doc);
}

export function parseDocument(text) {
  const doc = JSON.parse(text);
  // A document from the future would be read with the wrong meaning. Refuse
  // loudly: nine years of history is not something to guess at.
  if (doc.version !== DOCUMENT_VERSION) {
    throw new Error(`unsupported document version ${doc.version}`);
  }
  for (const section of SECTIONS) {
    if (!(section in doc)) throw new Error(`document is missing ${section}`);
  }
  return doc;
}
