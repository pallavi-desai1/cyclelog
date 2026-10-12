#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseLegacyLog } from '../src/importers/legacy.js';
import { parseClueMeasurements } from '../src/importers/clue.js';
import { mergeSources } from '../src/merge.js';
import { buildCycles } from '../src/cycles.js';
import { cycleStats } from '../src/stats.js';

const [cluePath = 'private/measurements.json',
       legacyPath = 'private/legacy_periods.txt',
       outPath = 'seed.json'] = process.argv.slice(2);

const legacy = parseLegacyLog(readFileSync(legacyPath, 'utf8'));
const clue = parseClueMeasurements(JSON.parse(readFileSync(cluePath, 'utf8')));
const { doc, conflicts } = mergeSources(legacy, clue);

const cycles = buildCycles(doc);
const stats = cycleStats(cycles);

writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);

console.log(`wrote ${outPath}`);
console.log(`  days          ${Object.keys(doc.days).length}`);
console.log(`  spans         ${doc.spans.length}`);
console.log(`  gaps          ${doc.gaps.length}`);
console.log(`  episodes      ${doc.birthControl.length}`);
console.log(`  cycles        ${cycles.length} (${stats.excludedCount} excluded)`);
console.log(`  median length ${stats.all.median}`);
console.log(`  conflicts     ${conflicts.length}`);
for (const warning of [...legacy.warnings, ...clue.warnings]) console.log(`  warning: ${warning}`);
for (const [type, count] of Object.entries(clue.dropped)) console.log(`  dropped ${type}: ${count}`);
