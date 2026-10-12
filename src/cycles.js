import { diffDays } from './dates.js';

const FLOW_RANK = { light: 1, medium: 2, heavy: 3 };

// Returns the first episode containing `iso`, which is correct only while
// episodes do not overlap. Nothing enforces that here; the screen that lets a
// user add and end episodes is where overlap must be prevented.
export function episodeAt(doc, iso) {
  for (const episode of doc.birthControl ?? []) {
    const started = episode.startedOn <= iso;
    const ended = episode.endedOn !== null && episode.endedOn !== undefined && episode.endedOn < iso;
    if (started && !ended) return episode;
  }
  return null;
}

// Inclusive on both ends, deliberately. A stricter open-interval rule
// (gap.from < nextStart && gap.to > start) would ask only whether an unlogged
// day falls strictly between two period starts, and gives identical results on
// the real data — both real gaps sit well inside their intervals. The inclusive
// form errs toward distrusting a borderline cycle, which is the right direction
// here: dropping one borderline cycle costs one data point, while admitting a
// bogus 63-day cycle skews the mean and the variability estimate behind every
// prediction.
function overlappingGap(doc, start, nextStart) {
  return (doc.gaps ?? []).find(gap => gap.from <= nextStart && gap.to >= start) ?? null;
}

function summarise(doc, start, nextStart) {
  let peakFlow = null;
  let crampDays = 0;
  let pmsDays = 0;
  let spottingDays = 0;

  for (const [date, day] of Object.entries(doc.days ?? {})) {
    if (date < start || date >= nextStart) continue;
    if (day.flow && (peakFlow === null || (FLOW_RANK[day.flow] ?? 0) > (FLOW_RANK[peakFlow] ?? 0))) peakFlow = day.flow;
    if (day.cramps && day.cramps !== 'none') crampDays += 1;
    if (day.pms) pmsDays += 1;
    if (day.spotting) spottingDays += 1;
  }

  return { peakFlow, crampDays, pmsDays, spottingDays };
}

const sortedSpans = (doc) => [...(doc.spans ?? [])].sort((a, b) => a.start.localeCompare(b.start));

export function buildCycles(doc) {
  const spans = sortedSpans(doc);
  const cycles = [];

  for (let i = 0; i < spans.length - 1; i += 1) {
    const span = spans[i];
    const next = spans[i + 1];
    const gap = overlappingGap(doc, span.start, next.start);
    const episode = episodeAt(doc, span.start);

    cycles.push({
      start: span.start,
      nextStart: next.start,
      periodEnd: span.end ?? null,
      periodLength: span.end ? diffDays(span.start, span.end) + 1 : null,
      periodEndPrecision: span.endPrecision ?? null,
      length: diffDays(span.start, next.start),
      precision: span.precision === 'approx' || next.precision === 'approx' ? 'approx' : 'exact',
      source: span.source,
      excluded: gap !== null,
      excludedReason: gap ? `overlaps a gap (${gap.from} to ${gap.to}: ${gap.reason})` : null,
      episodeMethod: episode ? episode.method : null,
      ...summarise(doc, span.start, next.start),
    });
  }

  return cycles;
}

export function currentCycle(doc, todayISO) {
  const spans = sortedSpans(doc);
  if (spans.length === 0) return null;

  const span = spans[spans.length - 1];
  const episode = episodeAt(doc, todayISO);

  return {
    start: span.start,
    periodEnd: span.end ?? null,
    periodLength: span.end ? diffDays(span.start, span.end) + 1 : null,
    periodEndPrecision: span.endPrecision ?? null,
    dayOfCycle: diffDays(span.start, todayISO) + 1,
    episodeMethod: episode ? episode.method : null,
  };
}
