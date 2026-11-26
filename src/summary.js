import { buildCycles, currentCycle, isNoMethod } from './cycles.js';
import { cycleStats } from './stats.js';
import { predict } from './predict.js';
import { currentEpisode, naturalCycles } from './episodes.js';
import { divergenceSeries, meanShift, meanShiftByEpisode } from './divergence.js';
import { diffDays } from './dates.js';
import { cycleWindows, phaseAt, nextStartForDoc } from './phase.js';

export const FIXED_CAVEAT = 'Fertile days are predicted from your own past cycle lengths. '
  + 'This is not contraception \u2014 a day without a mark is not a safe day.';

// Which caveat goes beside the fertile window is decided HERE, in the data, for
// the same reason `confidence` is withheld for 'not-expected' below: so no
// renderer can print the wrong thing by accident. Two strings, because they
// make different claims. Spread-driven names a number; sample-driven must not:
// identical cycle lengths give sigma exactly 0, and "\u00b1 0 days" on a sample
// of two would be a false claim of precision on the surface that exists to
// stay honest. Spread wins when both fire (it is the more specific claim).
// A third string outranks both: once a suppressing or regulating method ends,
// the model has no episode to learn from and falls back on her long
// pre-method history, so sigma and nEff look confident on the very day the
// cycle is least predictable. `settling` is decided in the data by
// `settlingAfterMethod` and passed in, so this stays testable with stub models.
// Exported so the thresholds can be tested at their exact boundaries.
export const SETTLING_CAVEAT = 'Your cycles are still settling after stopping a hormonal method, '
  + 'so these days could be off by a week or more.';
export const SETTLING_DAYS = 180;
export const SETTLING_CYCLES = 3;

export function uncertaintyCaveat(adapted, settling = false) {
  if (settling) return SETTLING_CAVEAT;
  if (adapted.available && adapted.sigma > 2) {
    return `Your recent cycles vary by about \u00b1 ${Math.round(adapted.sigma)} days, `
      + 'so these days could be off by that much or more.';
  }
  if (!adapted.available || adapted.nEff < 6) {
    return 'This prediction is based on only a few cycles, '
      + 'so these days could be off by several days or more.';
  }
  return null;
}

// True while she is recently off a hormonal method: the most recent episode
// expected to suppress or regulate ended within SETTLING_DAYS (inclusive), or
// fewer than SETTLING_CYCLES natural cycles have completed since it ended.
// Not true while any such episode still covers today (she is on one, or has
// switched straight to another), and "nothing" rows are no episode at all.
// Reads `expectedEffect` only, never the method name, so it holds on the
// partner's scope-stripped copy.
export function settlingAfterMethod(doc, cycles, todayISO) {
  const hormonal = (doc?.birthControl ?? []).filter(
    e => !isNoMethod(e) && (e.expectedEffect === 'suppress' || e.expectedEffect === 'regulate'),
  );
  const covers = e => e.startedOn <= todayISO && (e.endedOn == null || e.endedOn >= todayISO);
  if (hormonal.some(covers)) return false;
  const ended = hormonal.filter(e => e.endedOn != null && e.endedOn < todayISO)
    .map(e => e.endedOn).sort();
  if (ended.length === 0) return false;
  const last = ended[ended.length - 1];
  if (diffDays(last, todayISO) <= SETTLING_DAYS) return true;
  const since = naturalCycles(cycles, doc).filter(c => c.start > last);
  return since.length < SETTLING_CYCLES;
}

function phaseBlock(doc, adapted, current, todayISO, settling) {
  const nextStartFor = nextStartForDoc(doc, {
    anchor: adapted.available ? adapted.anchor : null,
    length: adapted.available ? adapted.length : null,
  });
  const windows = cycleWindows(doc, { nextStartFor, fromISO: '0000-01-01', toISO: '9999-12-31' });
  const name = phaseAt(doc, todayISO, windows);
  const w = windows.find(x => x.cycleStart === current?.start) ?? null;
  return {
    name,
    cycleDay: current ? current.dayOfCycle : null,
    window: w === null ? null : { from: w.from, descent: w.descent, to: w.to },
    fromTest: w === null ? false : w.fromTest,
    caveat: { fixed: FIXED_CAVEAT, uncertainty: uncertaintyCaveat(adapted, settling) },
  };
}

// "1 days late" reads as a bug in the app rather than a fact about her body.
export function days(n) {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

function lastSpan(doc) {
  const spans = doc.spans ?? [];
  if (spans.length === 0) return null;
  // mergeSources sorts by start; take the maximum rather than trusting order.
  return spans.reduce((latest, span) => (span.start > latest.start ? span : latest));
}

function headlineFor(adapted) {
  if (!adapted.available) {
    return { kind: 'unavailable', text: 'Not enough data yet', daysLate: null };
  }
  if (adapted.status === 'not-expected') {
    // Her words: name the reality instead of widening the uncertainty. The day
    // count stays, because "no period in 83 days" is the clinical fact.
    return { kind: 'no-period', text: 'No period expected', daysLate: adapted.daysLate };
  }
  if (adapted.status === 'late') {
    return { kind: 'late', text: `${days(adapted.daysLate)} late`, daysLate: adapted.daysLate };
  }
  return { kind: 'on-time', text: 'On time so far', daysLate: null };
}

export function buildSummary(doc, todayISO) {
  const cycles = buildCycles(doc);
  const stats = cycleStats(cycles);
  const { baseline, adapted } = predict(cycles, doc, todayISO);
  const episode = currentEpisode(doc, todayISO);
  const current = currentCycle(doc, todayISO);
  const span = lastSpan(doc);
  const series = divergenceSeries(doc, baseline);

  return {
    asOf: todayISO,

    lastPeriod: span === null ? null : {
      start: span.start,
      end: span.end ?? null,
      lengthDays: span.end ? diffDays(span.start, span.end) + 1 : null,
      dayOfCycle: current ? current.dayOfCycle : null,
    },

    history: {
      usableCycles: stats.all.n,
      excludedCount: stats.excludedCount,
      median: stats.all.median,
      mean: stats.all.mean,
      last12Median: stats.last12.median,
    },

    // A scope-narrowed projection (the `dates` share scope) carries an
    // episode with no `method` name at all — `episode.method === undefined`
    // — and that must produce no method object, not one with a missing
    // name that a renderer would print as an empty label.
    method: episode === null || episode.method === undefined ? null : {
      method: episode.method,
      startedOn: episode.startedOn,
      expectedEffect: episode.expectedEffect,
    },

    headline: headlineFor(adapted),

    phase: phaseBlock(doc, adapted, current, todayISO, settlingAfterMethod(doc, cycles, todayISO)),

    adapted: {
      available: adapted.available,
      date: adapted.available ? adapted.date : null,
      // Spec §6.2b: the no-period state asserts no percentage. Withheld HERE,
      // in the data, so no renderer can print it by accident.
      confidence: adapted.available && adapted.status !== 'not-expected'
        ? adapted.confidence : null,
      length: adapted.available ? adapted.length : null,
      sigma: adapted.available ? adapted.sigma : null,
      nEff: adapted.nEff,
      anchor: adapted.available ? adapted.anchor : null,
      fromTest: adapted.fromTest === true,
      weight: adapted.available ? adapted.weight : null,
      model: adapted.model,
      status: adapted.available ? adapted.status : null,
      reason: adapted.reason ?? null,
    },

    baseline: {
      available: baseline.available,
      date: baseline.available ? baseline.date : null,
      // The last pre-birth-control period start: the origin of the baseline
      // cadence, kept so the counterfactual stays reproducible from the
      // summary. The calendar no longer draws it.
      anchor: baseline.available ? baseline.anchor : null,
      confidence: baseline.available ? baseline.confidence : null,
      length: baseline.available ? baseline.length : null,
      sigma: baseline.available ? baseline.sigma : null,
      // The counterfactual is never overdue — it reports where the natural
      // rhythm would have put a period, in the past tense.
      wouldHaveStarted: baseline.status === 'passed' ? baseline.previousDate : null,
      daysAgo: baseline.status === 'passed' ? baseline.daysLate : null,
      reason: baseline.reason ?? null,
    },

    divergence: {
      points: series,
      meanShift: meanShift(series),
      byEpisode: meanShiftByEpisode(series),
    },
  };
}
