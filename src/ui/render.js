import { days } from '../summary.js';

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
