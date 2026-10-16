import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/summary.js';
import { escapeHtml, renderSummary, renderCalendar } from '../src/ui/render.js';
import { monthGrid } from '../src/calendar.js';

const spans = () => [
  { start: '2015-01-01', end: null, source: 'test' },
  { start: '2015-01-29', end: null, source: 'test' },
  { start: '2015-02-26', end: null, source: 'test' },
  { start: '2015-03-26', end: '2015-03-30', source: 'test' },
];
const doc = (birthControl = []) => ({ version: 1, days: {}, spans: spans(), gaps: [], birthControl });

const SUPPRESS = [{ startedOn: '2015-06-01', endedOn: null, method: 'implant', expectedEffect: 'suppress' }];
const REGULATE = [{ startedOn: '2015-06-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }];
const EARLY_PILL = [{ startedOn: '2015-04-01', endedOn: null, method: 'pill', expectedEffect: 'regulate' }];
const EMPTY = { version: 1, days: {}, spans: [], gaps: [], birthControl: [] };

const render = (d, today) => renderSummary(buildSummary(d, today));

describe('escapeHtml', () => {
  it('escapes the characters that would break out of a text node', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('stringifies non-strings', () => {
    expect(escapeHtml(28)).toBe('28');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('the summary card', () => {
  it('shows the last period date, which is the fact she needs at an appointment', () => {
    expect(render(doc(SUPPRESS), '2015-07-15')).toContain('2015-03-26');
  });

  it('shows the cycle day', () => {
    expect(render(doc(SUPPRESS), '2015-07-15')).toMatch(/Day 112/);
  });

  it('shows the median cycle length', () => {
    expect(render(doc(SUPPRESS), '2015-07-15')).toMatch(/28/);
  });

  it('shows the method and when it started', () => {
    const html = render(doc(SUPPRESS), '2015-07-15');
    expect(html).toContain('implant');
    expect(html).toContain('2015-06-01');
  });

  it('shows how many days late when a period is overdue', () => {
    expect(render(doc(REGULATE), '2015-07-15')).toContain('83 days late');
  });

  it('says "1 day late" on the first day overdue', () => {
    expect(render(doc(EARLY_PILL), '2015-04-24')).toContain('1 day late');
  });

  it('shows the confidence figure for a real prediction', () => {
    expect(render(doc(REGULATE), '2015-07-15')).toContain('27%');
  });

  // Spec §6.2b and her instruction, at the last place it could be violated.
  it('prints no percentage at all in the no-period state', () => {
    const html = render(doc(SUPPRESS), '2015-07-15');
    expect(html).toContain('No period expected');
    expect(html).not.toContain('%');
  });

  it('still shows how long it has been in the no-period state', () => {
    expect(render(doc(SUPPRESS), '2015-07-15')).toContain('83 days');
  });

  it('reports the counterfactual in the past tense, never as "late"', () => {
    const html = render(doc(SUPPRESS), '2015-07-15');
    expect(html).toContain('2015-06-18');
    expect(html).toMatch(/would have/i);
    expect(html).not.toMatch(/ghost/i);
  });

  it('omits the counterfactual-past line while it is still upcoming', () => {
    expect(render(doc(EARLY_PILL), '2015-04-20')).not.toMatch(/would have/i);
  });

  it('shows the mean shift once there is divergence to report', () => {
    const bled = doc(EARLY_PILL);
    bled.spans.push({ start: '2015-04-27', end: null, source: 'test' });
    expect(render(bled, '2015-05-10')).toMatch(/\+4\.0 days/);
  });

  it('omits the shift line when there is no divergence yet', () => {
    expect(render(doc(SUPPRESS), '2015-07-15')).not.toMatch(/compared with/i);
  });

  it('says so plainly when nothing has been logged', () => {
    const html = render(EMPTY, '2015-07-15');
    expect(html).toMatch(/No periods logged/i);
  });

  // The failure mode that would embarrass her in a doctor's office.
  it('never prints null, undefined or NaN, for any state', () => {
    const states = [
      render(doc(SUPPRESS), '2015-07-15'),
      render(doc(REGULATE), '2015-07-15'),
      render(doc(EARLY_PILL), '2015-04-20'),
      render(doc(), '2015-04-20'),
      render(EMPTY, '2015-07-15'),
    ];
    for (const html of states) {
      expect(html).not.toMatch(/null|undefined|NaN/);
    }
  });

  it('escapes a method name rather than injecting it', () => {
    const nasty = doc([{ startedOn: '2015-06-01', endedOn: null, method: '<img src=x>', expectedEffect: 'suppress' }]);
    const html = render(nasty, '2015-07-15');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('never prints the literal string NaN even if a NaN reaches the renderer directly', () => {
    // one() and signed() gated on `typeof value === 'number'`, which NaN
    // passes — unreachable today only because describeLengths/meanShift
    // return null instead, but the codebase rule is Number.isFinite.
    const summary = {
      lastPeriod: null,
      history: { median: NaN, mean: NaN, usableCycles: 5, excludedCount: 0, last12Median: null },
      method: null,
      headline: { kind: 'unavailable', text: 'Not enough data yet', daysLate: null },
      adapted: { available: false },
      baseline: { available: false },
      divergence: { meanShift: NaN },
    };
    expect(renderSummary(summary)).not.toContain('NaN');
  });

  it('produces balanced markup for every state', () => {
    for (const html of [render(doc(SUPPRESS), '2015-07-15'), render(EMPTY, '2015-07-15')]) {
      const opens = (html.match(/<(?!\/)[a-z]/g) ?? []).length;
      const closes = (html.match(/<\//g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe('the calendar', () => {
  const grid = (overrides = {}) => monthGrid(
    {
      version: 1, gaps: [], birthControl: [],
      spans: overrides.spans ?? [{ start: '2015-03-26', end: '2015-03-30', source: 'test' }],
      days: overrides.days ?? {
        '2015-03-26': { flow: 'heavy', spotting: null, pms: false },
        '2015-03-27': { flow: 'light', spotting: 'brown', pms: false },
        '2015-03-20': { flow: null, spotting: null, pms: true },
      },
    },
    {
      month: overrides.month ?? '2015-03',
      todayISO: overrides.todayISO ?? '2015-03-26',
      adaptedDate: overrides.adaptedDate ?? '2015-03-31',
      baselineDate: overrides.baselineDate ?? '2015-03-29',
    },
  );
  const html = (overrides = {}) => renderCalendar(grid(overrides));

  it('heads the grid with the days of the week', () => {
    for (const name of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(html()).toContain(name);
    }
  });

  it('renders one cell per day of the grid', () => {
    const cells = (html().match(/class="cal-cell/g) ?? []).length;
    expect(cells).toBe(grid().weeks.length * 7);
  });

  it('shows every day number of the month', () => {
    for (const day of [1, 15, 26, 31]) {
      expect(html()).toMatch(new RegExp(`>${day}<`));
    }
  });

  it('distinguishes days outside the month', () => {
    expect(html({ month: '2015-04', todayISO: '2015-04-01' })).toContain('cal-out');
  });

  it('marks today', () => {
    expect(html()).toContain('cal-today');
  });

  it('scales the flow dot by intensity', () => {
    expect(html()).toContain('flow-heavy');
    expect(html()).toContain('flow-light');
  });

  it('rings a spotting day instead of filling it', () => {
    expect(html()).toContain('cal-spotting');
  });

  it('underlines a PMS day', () => {
    expect(html()).toContain('cal-pms');
  });

  // §10.3: the adapted prediction is solid, the counterfactual dashed. They
  // must be separate classes, or the two become indistinguishable in CSS.
  it('marks the prediction and the counterfactual with different classes', () => {
    expect(html()).toContain('cal-predicted');
    expect(html()).toContain('cal-baseline');
  });

  it('can mark both on a single day', () => {
    const both = html({ adaptedDate: '2015-03-31', baselineDate: '2015-03-31' });
    expect(both).toMatch(/class="[^"]*cal-predicted[^"]*cal-baseline|class="[^"]*cal-baseline[^"]*cal-predicted/);
  });

  // Every state encoded by colour or shape is also encoded in words, so the
  // calendar survives colour blindness and a screen reader.
  it('names each state in the cell label', () => {
    const labels = html().match(/aria-label="[^"]*"/g).join(' ');
    expect(labels).toMatch(/heavy flow/);
    expect(labels).toMatch(/spotting/);
    expect(labels).toMatch(/PMS/);
    expect(labels).toMatch(/period expected/);
    expect(labels).toMatch(/without birth control/);
    expect(labels).toMatch(/today/);
  });

  it('escapes what was logged rather than injecting it', () => {
    const nasty = html({ days: { '2015-03-26': { flow: '<img src=x>', spotting: null, pms: false } } });
    expect(nasty).not.toContain('<img');
  });

  it('prints no null, undefined or NaN', () => {
    expect(html({ days: {}, spans: [] })).not.toMatch(/null|undefined|NaN/);
  });

  it('produces balanced markup', () => {
    const output = html();
    const opens = (output.match(/<(?!\/)[a-z]/g) ?? []).length;
    const closes = (output.match(/<\//g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
