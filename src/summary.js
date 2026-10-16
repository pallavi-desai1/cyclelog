import { buildCycles, currentCycle } from './cycles.js';
import { cycleStats } from './stats.js';
import { predict } from './predict.js';
import { currentEpisode } from './episodes.js';
import { divergenceSeries, meanShift, meanShiftByEpisode } from './divergence.js';
import { diffDays } from './dates.js';

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

    method: episode === null ? null : {
      method: episode.method,
      startedOn: episode.startedOn,
      expectedEffect: episode.expectedEffect,
    },

    headline: headlineFor(adapted),

    adapted: {
      available: adapted.available,
      date: adapted.available ? adapted.date : null,
      // Spec §6.2b: the no-period state asserts no percentage. Withheld HERE,
      // in the data, so no renderer can print it by accident.
      confidence: adapted.available && adapted.status !== 'not-expected'
        ? adapted.confidence : null,
      length: adapted.available ? adapted.length : null,
      sigma: adapted.available ? adapted.sigma : null,
      weight: adapted.available ? adapted.weight : null,
      model: adapted.model,
      status: adapted.available ? adapted.status : null,
      reason: adapted.reason ?? null,
    },

    baseline: {
      available: baseline.available,
      date: baseline.available ? baseline.date : null,
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
