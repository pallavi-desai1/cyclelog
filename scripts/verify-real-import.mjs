#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { parseLegacyLog } from '../src/importers/legacy.js';
import { parseClueMeasurements } from '../src/importers/clue.js';
import { mergeSources } from '../src/merge.js';
import { buildCycles } from '../src/cycles.js';
import { cycleStats } from '../src/stats.js';

const [cluePath = 'private/measurements.json',
       legacyPath = 'private/legacy_periods.txt',
       expectationsPath = 'private/expectations.json'] = process.argv.slice(2);

if (!existsSync(expectationsPath)) {
  console.error(
    `Expectations file not found: ${expectationsPath}\n\n` +
    'These expectations encode real personal health data (dates and cycle\n' +
    'statistics derived from the owner\'s actual export), so they are kept\n' +
    'outside version control rather than hard-coded in this script. Create\n' +
    `${expectationsPath} yourself (it is gitignored) before running this check.`,
  );
  process.exit(1);
}

const expected = JSON.parse(readFileSync(expectationsPath, 'utf8'));

const legacy = parseLegacyLog(readFileSync(legacyPath, 'utf8'));
const clue = parseClueMeasurements(JSON.parse(readFileSync(cluePath, 'utf8')));
const { doc, conflicts } = mergeSources(legacy, clue);
const cycles = buildCycles(doc);
const stats = cycleStats(cycles);

const flowDays = Object.values(clue.days).filter(day => day.flow !== null).length;
const openEnded = legacy.spans.filter(span => span.end === null).length;

// Expected values are read from a gitignored expectations file, not hard-coded
// here, because they describe the real export. They were derived from the
// source export before these importers existed and must not be edited to make
// a failing run pass — a failure here means an importer is wrong, not that the
// expectation is wrong.
const checks = [
  ['legacy spans', legacy.spans.length, expected.legacySpans],
  ['legacy open-ended spans', openEnded, expected.legacyOpenEndedSpans],
  ['legacy gaps', legacy.gaps.length, expected.legacyGaps],
  ['legacy first start', legacy.spans[0]?.start, expected.legacyFirstStart],
  ['clue flow days', flowDays, expected.clueFlowDays],
  ['clue spans', clue.spans.length, expected.clueSpans],
  ['clue first span start', clue.spans[0]?.start, expected.clueFirstSpanStart],
  ['clue last span start', clue.spans.at(-1)?.start, expected.clueLastSpanStart],
  ['birth-control episodes', doc.birthControl.length, expected.birthControlEpisodes],
  ['implant start', doc.birthControl[0]?.startedOn, expected.firstEpisodeStart],
  ['merged spans', doc.spans.length, expected.mergedSpans],
  ['merge conflicts', conflicts.length, expected.mergeConflicts],
  ['total cycles', cycles.length, expected.totalCycles],
  ['excluded cycles', stats.excludedCount, expected.excludedCycles],
  ['valid cycles', stats.all.n, expected.validCycles],
  ['median cycle length', stats.all.median, expected.medianCycleLength],
  ['min cycle length', stats.all.min, expected.minCycleLength],
  ['max cycle length', stats.all.max, expected.maxCycleLength],
  ['last-12 median', stats.last12.median, expected.last12Median],
];

let failed = 0;
for (const [label, actual, exp] of checks) {
  const ok = actual === exp;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${exp})`}`);
}

const tolerance = expected.tolerance;
const meanOk = Math.abs(stats.all.mean - expected.meanCycleLength) < tolerance;
const sdOk = Math.abs(stats.all.sd - expected.sdCycleLength) < tolerance;
if (!meanOk) failed += 1;
if (!sdOk) failed += 1;
console.log(`${meanOk ? 'PASS' : 'FAIL'}  mean cycle length: ${stats.all.mean.toFixed(2)} (expected ~${expected.meanCycleLength})`);
console.log(`${sdOk ? 'PASS' : 'FAIL'}  sd cycle length: ${stats.all.sd.toFixed(2)} (expected ~${expected.sdCycleLength})`);

const excluded = cycles.filter(cycle => cycle.excluded).map(cycle => `${cycle.start} (${cycle.length}d)`);
console.log(`\nexcluded cycles: ${excluded.join(', ')}`);
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
