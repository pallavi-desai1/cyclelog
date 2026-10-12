import { lastDayOfMonth, pad2 } from '../dates.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const APPROX = /approx|\(est\.?\)|midnight/i;
const GAP_LINE = /not logged|no dates logged/i;
const END_LINE = /stooped|stopped/i;
const START_LINE = /started/i;
const DAY_LINE = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*\/\s*(\d{1,2})(?:st|nd|rd|th)?)?/;
const EXPLICIT_YEAR = /,\s*((?:19|20)\d{2})/;

function monthNumber(line) {
  for (let i = 0; i < MONTHS.length; i += 1) {
    if (new RegExp(`\\b${MONTHS[i]}\\b`, 'i').test(line)) return i + 1;
  }
  return null;
}

export function parseLegacyLog(text) {
  const spans = [];
  const gaps = [];
  const warnings = [];
  const events = [];

  let sectionYear = null;
  let lastYear = null;
  let lastISO = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^(19|20)\d{2}$/.test(line)) {
      sectionYear = Number(line);
      continue;
    }

    if (GAP_LINE.test(line)) {
      const month = monthNumber(line);
      if (month === null) {
        warnings.push(`could not place gap line: ${line}`);
        continue;
      }

      // Same resolution rule as a date line: once a date line has rolled
      // lastYear past sectionYear (Review Focus / Finding 7), a gap line
      // using sectionYear alone would land a year early, silently excusing
      // the wrong cycle from the average.
      const year = Math.max(sectionYear ?? 0, lastYear ?? 0);
      if (year === 0) {
        warnings.push(`no year available for: ${line}`);
        continue;
      }

      // The two candidates disagreeing means the placement is a guess, not a
      // certainty, even though Math.max gives a deterministic answer — so an
      // ambiguous placement is announced rather than silently resolved.
      if (sectionYear !== null && lastYear !== null && sectionYear !== lastYear) {
        warnings.push(`ambiguous year for gap line (section ${sectionYear}, rolled-forward ${lastYear}): ${line}`);
      }

      gaps.push({
        from: `${year}-${pad2(month)}-01`,
        to: lastDayOfMonth(year, month),
        reason: 'not logged',
      });
      continue;
    }

    if (/unknown stop date/i.test(line)) {
      warnings.push(`unknown stop date after ${lastISO ?? 'an unknown start'}`);
      continue;
    }

    const kind = START_LINE.test(line) ? 'start' : (END_LINE.test(line) ? 'end' : null);
    if (kind === null) continue;

    const parts = DAY_LINE.exec(line);
    const month = parts ? monthNumber(parts[1]) : null;
    if (!parts || month === null) {
      warnings.push(`could not parse a date from: ${line}`);
      continue;
    }

    const day = Number(parts[3] ?? parts[2]);
    const explicit = EXPLICIT_YEAR.exec(line);
    let year = explicit
      ? Number(explicit[1])
      : Math.max(sectionYear ?? 0, lastYear ?? 0);

    if (year === 0) {
      warnings.push(`no year available for: ${line}`);
      continue;
    }

    let iso = `${year}-${pad2(month)}-${pad2(day)}`;
    while (lastISO !== null && iso < lastISO) {
      year += 1;
      iso = `${year}-${pad2(month)}-${pad2(day)}`;
    }

    events.push({
      iso,
      kind,
      precision: APPROX.test(line) ? 'approx' : 'exact',
      line,
    });
    lastISO = iso;
    lastYear = year;
  }

  let open = null;
  const openToSpan = (ev, end) => ({
    start: ev.iso,
    end: end ? end.iso : null,
    precision: ev.precision,
    endPrecision: end ? end.precision : null,
    source: 'legacy',
  });

  for (const ev of events) {
    if (ev.kind === 'start') {
      if (open) spans.push(openToSpan(open, null));
      open = ev;
    } else if (open) {
      spans.push(openToSpan(open, ev));
      open = null;
    } else {
      warnings.push(`end date without a start: ${ev.line}`);
    }
  }
  if (open) spans.push(openToSpan(open, null));

  return { spans, gaps, warnings };
}
