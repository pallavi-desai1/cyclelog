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

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

// What setup shows after an import: counts and a date range, derived from the
// document that was actually built, never hardcoded. The counts are the
// owner's, which is why nothing here is a fixed string or a stored number.
export function describeImport({ doc, warnings }) {
  const allDates = [
    ...doc.spans.flatMap(span => [span.start, span.end].filter(Boolean)),
    ...Object.keys(doc.days),
  ].sort();
  const range = allDates.length > 0 ? `, ${allDates[0]} to ${allDates[allDates.length - 1]}` : '';
  const warningText = warnings.length > 0
    ? ` ${plural(warnings.length, 'line')} could not be read.`
    : '';
  return `Imported ${plural(doc.spans.length, 'period')} and `
    + `${plural(Object.keys(doc.days).length, 'logged day')}${range}.${warningText}`;
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
