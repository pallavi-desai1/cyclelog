const EMPTY = { n: 0, mean: null, median: null, min: null, max: null, sd: null };

export function describeLengths(lengths) {
  const values = lengths.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return { ...EMPTY };

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((total, value) => total + value, 0) / n;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];

  let sd = null;
  if (n >= 2) {
    const sumSquares = sorted.reduce((total, value) => total + (value - mean) ** 2, 0);
    sd = Math.sqrt(sumSquares / (n - 1));
  }

  return { n, mean, median, min: sorted[0], max: sorted[n - 1], sd };
}

export function cycleStats(cycles) {
  // A cycle length of zero or less is not data, it is a symptom of
  // duplication (see merge.js's span dedup) and must never reach a mean a
  // clinician reads. This is defence in depth: the merge-level dedup should
  // prevent such cycles existing at all.
  const included = cycles.filter(cycle => !cycle.excluded && typeof cycle.length === 'number' && cycle.length > 0);
  const lengths = included.map(cycle => cycle.length);

  return {
    all: describeLengths(lengths),
    last12: describeLengths(lengths.slice(-12)),
    excludedCount: cycles.filter(cycle => cycle.excluded).length,
  };
}
