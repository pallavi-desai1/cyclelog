#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseLegacyLog } from '../src/importers/legacy.js';
import { parseClueMeasurements } from '../src/importers/clue.js';
import { mergeSources } from '../src/merge.js';
import { buildCycles, currentCycle } from '../src/cycles.js';
import { cycleStats } from '../src/stats.js';
import { predict } from '../src/predict.js';
import { divergenceSeries, meanShift } from '../src/divergence.js';
import { currentEpisode } from '../src/episodes.js';

const [cluePath = 'private/measurements.json',
       legacyPath = 'private/legacy_periods.txt',
       todayArg] = process.argv.slice(2);

const today = todayArg ?? new Date().toISOString().slice(0, 10);

const legacy = parseLegacyLog(readFileSync(legacyPath, 'utf8'));
const clue = parseClueMeasurements(JSON.parse(readFileSync(cluePath, 'utf8')));
const { doc } = mergeSources(legacy, clue);
const cycles = buildCycles(doc);
const stats = cycleStats(cycles);
const { baseline, adapted } = predict(cycles, doc, today);
const series = divergenceSeries(doc, baseline);
const shift = meanShift(series);
const episode = currentEpisode(doc, today);
const current = currentCycle(doc, today);

const show = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);

console.log(`as of ${today}`);
console.log('\nhistory');
show('usable cycles', `${stats.all.n} (${stats.excludedCount} excluded)`);
show('median / mean length', `${stats.all.median} / ${stats.all.mean?.toFixed(2)}`);
show('last 12 median', stats.last12.median);
show('current cycle day', current ? current.dayOfCycle : 'n/a');
show('method in force', episode ? `${episode.method} since ${episode.startedOn}` : 'none');

console.log('\nbaseline (what the natural cycle would do)');
if (baseline.available) {
  show('length', baseline.length.toFixed(2));
  show('spread (sigma)', baseline.sigma.toFixed(2));
  show('effective sample', baseline.nEff.toFixed(1));
  show('next date', `${baseline.date} - ${baseline.confidence}% confident`);
} else {
  show('unavailable', baseline.reason);
}

console.log('\nadapted (what it is actually doing)');
if (adapted.available) {
  show('model', adapted.model);
  show('episode weight (w)', adapted.weight.toFixed(3));
  show('length', adapted.length.toFixed(2));
  show('spread (sigma)', adapted.sigma.toFixed(2));
  show('effective sample', adapted.nEff.toFixed(1));
  show('next date', `${adapted.date} - ${adapted.confidence}% confident`);
} else {
  show('unavailable', adapted.reason);
}

console.log('\ndivergence (actual minus baseline, per cycle on a method)');
if (series.length === 0) console.log('  none yet');
for (const point of series) {
  const sign = point.delta >= 0 ? '+' : '';
  console.log(`  ${point.index}. actual ${point.actual}  baseline ${point.baseline}  ${sign}${point.delta}d  (${point.method})`);
}
if (shift !== null) show('mean shift', `${shift >= 0 ? '+' : ''}${shift.toFixed(1)} days`);

// Universal invariants only — nothing here encodes the owner's figures, so
// this script is safe to commit to a public repository.
const problems = [];
const checkModel = (name, model) => {
  if (!model.available) return;
  if (!Number.isFinite(model.length) || model.length <= 0) problems.push(`${name}: length is not a positive number`);
  if (!Number.isFinite(model.sigma) || model.sigma < 0) problems.push(`${name}: sigma is not a non-negative number`);
  if (!Number.isInteger(model.confidence) || model.confidence < 0 || model.confidence > 100) problems.push(`${name}: confidence outside 0-100`);
  if (!model.date || model.date < today) problems.push(`${name}: predicted date is in the past`);
  for (const [key, value] of Object.entries(model)) {
    if (Number.isNaN(value)) problems.push(`${name}: ${key} is NaN`);
  }
};
checkModel('baseline', baseline);
checkModel('adapted', adapted);
for (const point of series) {
  if (!Number.isFinite(point.delta)) problems.push(`divergence ${point.index}: delta is not finite`);
}
if (shift !== null && !Number.isFinite(shift)) problems.push('mean shift is not finite');

console.log('');
if (problems.length === 0) {
  console.log('All invariants hold.');
  process.exit(0);
}
for (const problem of problems) console.log(`INVARIANT FAILED  ${problem}`);
process.exit(1);
