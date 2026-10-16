import { days } from '../summary.js';
import { WEEKDAYS as WEEKDAY_NAMES } from '../calendar.js';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, character => ENTITIES[character]);
}

const one = value => (Number.isFinite(value) ? value.toFixed(1) : '');
const signed = value => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}` : '');

// Every line is built only when its data exists, which is what keeps "null"
// and "NaN" off a screen she reads out at an appointment.
function line(label, value, className = '') {
  if (value === null || value === undefined || value === '') return '';
  const classes = className ? ` class="${className}"` : '';
  return `<p${classes}><span class="label">${escapeHtml(label)}</span> <span class="value">${value}</span></p>`;
}

export function renderSummary(summary) {
  const { lastPeriod, history, method, headline, adapted, baseline, divergence } = summary;

  const parts = [`<section class="card headline ${escapeHtml(headline.kind)}">`];
  parts.push(`<h2>${escapeHtml(headline.text)}</h2>`);

  if (headline.kind === 'no-period' && headline.daysLate !== null) {
    parts.push(`<p class="since">${escapeHtml(days(headline.daysLate))} since one was due</p>`);
  }

  if (lastPeriod === null) {
    parts.push('<p>No periods logged yet.</p>');
  } else {
    const span = lastPeriod.end
      ? `${escapeHtml(lastPeriod.start)} to ${escapeHtml(lastPeriod.end)} (${escapeHtml(days(lastPeriod.lengthDays))})`
      : escapeHtml(lastPeriod.start);
    parts.push(line('Last period', span));
    if (lastPeriod.dayOfCycle !== null) {
      parts.push(line('Cycle', `Day ${escapeHtml(lastPeriod.dayOfCycle)}`));
    }
  }

  if (history.median !== null) {
    parts.push(line(
      'Cycle length',
      `${escapeHtml(one(history.median))} days typical, ${escapeHtml(one(history.mean))} average over ${escapeHtml(history.usableCycles)} cycles`,
    ));
  }

  if (method !== null) {
    parts.push(line('Method', `${escapeHtml(method.method)} since ${escapeHtml(method.startedOn)}`));
  }
  parts.push('</section>');

  parts.push('<section class="card predictions">');
  if (adapted.available) {
    // The no-period state carries `confidence: null` from buildSummary, so
    // there is nothing here to print even if this template changed.
    const confidence = adapted.confidence === null
      ? '' : ` — ${escapeHtml(adapted.confidence)}% confident`;
    const label = adapted.status === 'not-expected' ? 'If one comes' : 'Next expected';
    parts.push(line(label, `${escapeHtml(adapted.date)}${confidence}`));
  } else {
    parts.push(line('Next expected', 'not enough data yet'));
  }

  if (baseline.available) {
    // Solid for the adapted prediction, dashed for the counterfactual — and
    // labelled in words too, so the distinction survives colour blindness and
    // a screen reader.
    if (baseline.wouldHaveStarted !== null) {
      parts.push(line(
        'Off birth control',
        `would have started ${escapeHtml(baseline.wouldHaveStarted)}, ${escapeHtml(days(baseline.daysAgo))} ago`,
        'counterfactual',
      ));
    } else {
      parts.push(line(
        'Off birth control',
        `would be due ${escapeHtml(baseline.date)}`,
        'counterfactual',
      ));
    }
  }

  if (divergence.meanShift !== null) {
    parts.push(line(
      'Shift',
      `${escapeHtml(signed(divergence.meanShift))} days compared with the natural cycle`,
    ));
  }
  parts.push('</section>');

  return parts.join('');
}

// The month grid. Every state is drawn as a shape — a filled dot scaled by
// flow, a ring for spotting, an underline for PMS, an outline for a predicted
// day — and named in the cell's aria-label, so nothing depends on colour
// alone (§10.3).
function cellLabel(cell) {
  const parts = [`${cell.day}`];
  if (cell.isToday) parts.push('today');
  if (cell.flow) parts.push(`${cell.flow} flow`);
  else if (cell.isPeriod) parts.push('period');
  if (cell.spotting) parts.push(`spotting: ${cell.spotting}`);
  if (cell.pms) parts.push('PMS');
  if (cell.predicted) parts.push('period expected');
  if (cell.baseline) parts.push('would have started without birth control');
  return parts.join(', ');
}

function cellClasses(cell) {
  const classes = ['cal-cell'];
  if (!cell.inMonth) classes.push('cal-out');
  if (cell.isToday) classes.push('cal-today');
  if (cell.isPeriod) classes.push('cal-period');
  if (cell.pms) classes.push('cal-pms');
  if (cell.spotting) classes.push('cal-spotting');
  if (cell.predicted) classes.push('cal-predicted');
  if (cell.baseline) classes.push('cal-baseline');
  return classes.join(' ');
}

// Flow arrives from imported data, so it is whitelisted into a class rather
// than interpolated: an unrecognised value gets no dot instead of a new
// selector built from whatever the file contained.
const FLOW_CLASS = { light: 'flow-light', medium: 'flow-medium', heavy: 'flow-heavy' };

function flowDot(cell) {
  const className = FLOW_CLASS[cell.flow];
  if (className) return `<span class="cal-dot ${className}"></span>`;
  // A period day with no recorded intensity still reads as bleeding.
  return cell.isPeriod ? '<span class="cal-dot flow-medium"></span>' : '';
}

export function renderCalendar(grid) {
  const head = WEEKDAY_NAMES
    .map(name => `<div class="cal-weekday">${escapeHtml(name)}</div>`)
    .join('');

  const cells = grid.weeks.flat().map(cell => (
    `<div class="${cellClasses(cell)}" aria-label="${escapeHtml(cellLabel(cell))}">`
    + `<span class="cal-day">${escapeHtml(cell.day)}</span>`
    + flowDot(cell)
    + '</div>'
  )).join('');

  return `<div class="cal-grid">${head}${cells}</div>`;
}
