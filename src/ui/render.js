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
// Flow arrives from imported data, so it is whitelisted into a class rather
// than interpolated: an unrecognised value gets the plain period dot instead
// of a new selector built from whatever the file contained.
const FLOW_CLASS = { light: 'flow-light', medium: 'flow-medium', heavy: 'flow-heavy' };

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

const FILL_CLASS = {
  light: 'cal-flow-light', medium: 'cal-flow-medium', heavy: 'cal-flow-heavy',
};

function cellClasses(cell) {
  const classes = ['cal-cell'];
  if (!cell.inMonth) classes.push('cal-out');
  if (cell.isToday) classes.push('cal-today');
  // A filled day is what makes a month readable at a glance; the date number
  // on top switches to an ink dark enough to stay legible on every fill.
  if (cell.isPeriod || FLOW_CLASS[cell.flow]) {
    classes.push('cal-period', FILL_CLASS[cell.flow] ?? 'cal-flow-medium');
  }
  if (cell.pms) classes.push('cal-pms');
  if (cell.spotting) classes.push('cal-spotting');
  if (cell.testPositive) classes.push('cal-test');
  if (cell.predicted) classes.push('cal-predicted');
  if (cell.baseline) classes.push('cal-baseline');
  return classes.join(' ');
}

// Shown under the grid, because a colour nobody can name is a colour that
// means nothing. Each swatch carries the same class as the cells it explains,
// so the legend cannot drift away from the calendar.
const LEGEND = [
  ['cal-swatch-light', 'Light'],
  ['cal-swatch-medium', 'Medium'],
  ['cal-swatch-heavy', 'Heavy'],
  ['cal-spotting', 'Spotting'],
  ['cal-pms', 'PMS'],
  ['cal-test', 'Positive test'],
  ['cal-predicted', 'Period expected'],
  ['cal-baseline', 'Would have been, without birth control'],
];

function renderLegend() {
  const items = LEGEND.map(([className, label]) => (
    `<li><span class="cal-swatch ${className}"></span>${escapeHtml(label)}</li>`
  )).join('');
  return `<ul class="cal-legend">${items}</ul>`;
}


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

  // Buttons, not divs: every day is tappable, reachable by keyboard, and
  // announced with its own label. The date rides on the element so the click
  // handler never has to recompute which cell was pressed.
  const cells = grid.weeks.flat().map(cell => (
    `<button type="button" class="${cellClasses(cell)}" data-date="${escapeHtml(cell.date)}"`
    + ` aria-label="${escapeHtml(cellLabel(cell))}">`
    + `<span class="cal-day">${escapeHtml(cell.day)}</span>`
    + flowDot(cell)
    + '</button>'
  )).join('');

  return `<div class="cal-grid">${head}${cells}</div>${renderLegend()}`;
}

// The panel under the calendar: what this day was, where it sits in the
// cycle, and only what was actually recorded on it.
export function renderDay(detail) {
  const parts = [`<section class="card day${detail.isToday ? ' day-today' : ''}">`];
  parts.push(`<h3>${escapeHtml(detail.label)}${detail.isToday ? ' — today' : ''}</h3>`);

  if (detail.cycleDay !== null) {
    const cycle = detail.isPeriod && detail.periodDay !== null
      ? `Day ${escapeHtml(detail.cycleDay)} of this cycle — day ${escapeHtml(detail.periodDay)} of your period`
      : `Day ${escapeHtml(detail.cycleDay)} of this cycle`;
    parts.push(line('Cycle', cycle));
  }

  if (detail.isFuture) parts.push(line('', 'Still to come'));
  if (detail.predicted) parts.push(line('', 'Period expected on this day'));
  if (detail.baseline) {
    parts.push(line('', 'Where a period would have fallen without birth control'));
  }
  if (detail.method !== null) {
    parts.push(line('Method', `${escapeHtml(detail.method.method)} since ${escapeHtml(detail.method.startedOn)}`));
  }

  if (detail.logged.length === 0) {
    parts.push('<p class="day-empty">Nothing logged on this day.</p>');
  } else {
    for (const item of detail.logged) {
      parts.push(line(item.label, escapeHtml(item.value)));
    }
  }

  // Spec §10.1: imported entries are marked, and approximate dates say so —
  // a date she is unsure of should not read as a measurement. Her own
  // entries (source 'manual') are not an import and must not read as one —
  // "imported from manual" is nonsense on a day she typed herself.
  const provenance = [];
  if (detail.source && detail.source !== 'manual') {
    provenance.push(`imported from ${escapeHtml(detail.source)}`);
  }
  if (detail.isApproximate) provenance.push('date is approximate');
  if (provenance.length > 0) {
    parts.push(`<p class="day-source">${provenance.join(', ')}</p>`);
  }

  parts.push('<button id="edit-day" type="button">Edit this day</button>');
  parts.push('</section>');
  return parts.join('');
}
