#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseLegacyLog } from '../src/importers/legacy.js';
import { parseClueMeasurements } from '../src/importers/clue.js';
import { mergeSources } from '../src/merge.js';
import { buildCycles, currentCycle } from '../src/cycles.js';
import { cycleStats } from '../src/stats.js';
import { predict } from '../src/predict.js';
import { divergenceSeries, meanShift, meanShiftByEpisode } from '../src/divergence.js';
import { currentEpisode } from '../src/episodes.js';

const [cluePath = 'private/measurements.json',
       legacyPath = 'private/legacy_periods.txt',
       todayArg] = process.argv.slice(2);

// Local date parts, not toISOString(), which is UTC: an evening run in US
// Central would otherwise date the report tomorrow and report the cycle day
// one too high. This is a script, so local time is the right call here.
const defaultToday = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const today = todayArg ?? defaultToday();

const legacy = parseLegacyLog(readFileSync(legacyPath, 'utf8'));
const clue = parseClueMeasurements(JSON.parse(readFileSync(cluePath, 'utf8')));
const { doc } = mergeSources(legacy, clue);
const cycles = buildCycles(doc);
const stats = cycleStats(cycles);
const { baseline, adapted } = predict(cycles, doc, today);
const series = divergenceSeries(doc, baseline);
const shift = meanShift(series);
const shiftByEpisode = meanShiftByEpisode(series);
const episode = currentEpisode(doc, today);
const current = currentCycle(doc, today);

const show = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
// These strings are read aloud at a doctor's appointment; "1 days late" reads
// as a bug in the app rather than a fact about her body.
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

console.log(`as of ${today}`);
console.log('\nhistory');
show('usable cycles', `${stats.all.n} (${stats.excludedCount} excluded)`);
show('median / mean length', `${stats.all.median} / ${stats.all.mean?.toFixed(2)}`);
show('last 12 median', stats.last12.median);
show('current cycle day', current ? current.dayOfCycle : 'n/a');
show('method in force', episode ? `${episode.method} since ${episode.startedOn}` : 'none');

// "next date" below is simply the model's forward projection -- it does not
// distinguish an overdue cycle (today already past the projected date's
// window) from one still ahead. That distinction belongs to the app's UI
// layer, not this report script, and is deliberately deferred to the app
// plan rather than an oversight here.
console.log('\nbaseline (what the natural cycle would do)');
if (baseline.available) {
  show('length', baseline.length.toFixed(2));
  show('spread (sigma)', baseline.sigma.toFixed(2));
  show('effective sample', baseline.nEff.toFixed(1));
  // The ghost is never "late" — a cycle that was never going to happen cannot
  // be overdue. It reports where the natural rhythm would have put a period.
  if (baseline.status === 'passed') {
    show('would have started', `${baseline.previousDate} (${days(baseline.daysLate)} ago)`);
  }
  show('next date', `${baseline.date} - ${baseline.confidence}% confident`);
} else {
  show('unavailable', baseline.reason);
}

console.log('\nadapted (what it is actually doing)');
if (!adapted.available) {
  show('unavailable', adapted.reason);
} else if (adapted.status === 'not-expected') {
  // No confidence percentage here, deliberately (spec 6.2b). A date asserted at
  // low confidence is less useful than naming the expectation; printing both
  // would re-create the problem this state exists to solve.
  show('status', 'NO PERIOD EXPECTED');
  show('if one comes', `most likely around ${adapted.date}`);
  show('days since due', days(adapted.daysLate));
  show('spread (sigma)', adapted.sigma.toFixed(2));
} else {
  // An overdue period leads, because it is the more actionable fact. The report
  // does not yet distinguish how FAR past the grace window a non-suppressing
  // method is beyond the day count itself — deliberately deferred to the app
  // plan rather than overlooked.
  if (adapted.status === 'late') show('status', `${days(adapted.daysLate).toUpperCase()} LATE`);
  show('model', adapted.model);
  show('episode weight (w)', adapted.weight.toFixed(3));
  show('length', adapted.length.toFixed(2));
  show('spread (sigma)', adapted.sigma.toFixed(2));
  show('effective sample', adapted.nEff.toFixed(1));
  show('next date', `${adapted.date} - ${adapted.confidence}% confident`);
}

console.log('\ndivergence (actual minus baseline, per cycle on a method)');
if (series.length === 0) console.log('  none yet');
for (const point of series) {
  const sign = point.delta >= 0 ? '+' : '';
  console.log(`  ${point.index}. actual ${point.actual}  baseline ${point.baseline}  ${sign}${point.delta}d  (${point.method})`);
}
if (shift !== null) show('mean shift', `${shift >= 0 ? '+' : ''}${shift.toFixed(1)} days`);
// Spec 6.5: the mean shift broken out by episode, beneath the blended figure.
for (const g of shiftByEpisode) {
  const sign = g.meanShift >= 0 ? '+' : '';
  show(`  mean shift (${g.method})`, `${sign}${g.meanShift.toFixed(1)} days, n=${g.n}, since ${g.episodeStart}`);
}

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
  // Universal invariants: no figure of the owner's appears here. The baseline
  // and adapted models use different vocabularies on purpose.
  const allowed = name === 'baseline'
    ? ['upcoming', 'passed']
    : ['upcoming', 'late', 'not-expected'];
  if (!allowed.includes(model.status)) problems.push(`${name}: status ${model.status} not one of ${allowed.join('/')}`);
  if (model.status === 'late' && !(model.daysLate > 0)) problems.push(`${name}: late without a positive day count`);
  if (model.status === 'upcoming' && model.daysLate !== null) problems.push(`${name}: upcoming with a day count`);
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
