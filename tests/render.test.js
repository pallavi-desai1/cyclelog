import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/summary.js';
import {
  escapeHtml, renderSummary, renderCalendar, renderDay, renderMonthPicker,
} from '../src/ui/render.js';
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
      baselineDates: overrides.baselineDates ?? ['2015-03-29'],
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
    const both = html({ adaptedDate: '2015-03-31', baselineDates: ['2015-03-31'] });
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

describe('the day panel', () => {
  const base = {
    date: '2015-03-10', label: '10 March 2015', isToday: false, isFuture: false,
    cycleStart: '2015-02-26', cycleDay: 13, isPeriod: false, periodDay: null,
    hasEntry: true,
    logged: [{ label: 'Flow', value: 'heavy' }, { label: 'Notes', value: 'rough day' }],
    source: 'clue', isApproximate: false,
    method: { method: 'pill', startedOn: '2015-02-01' },
    predicted: false, baseline: false,
  };
  const detail = (overrides = {}) => ({ ...base, ...overrides });

  it('heads the panel with the date', () => {
    expect(renderDay(detail())).toContain('10 March 2015');
  });

  it('says where the day sits in the cycle', () => {
    expect(renderDay(detail())).toMatch(/Day 13/);
  });

  it('says which day of the period it is', () => {
    expect(renderDay(detail({ isPeriod: true, periodDay: 2 }))).toMatch(/day 2 of your period/i);
  });

  it('lists what was logged', () => {
    const html = renderDay(detail());
    expect(html).toContain('Flow');
    expect(html).toContain('heavy');
    expect(html).toContain('rough day');
  });

  it('says plainly when nothing was logged', () => {
    const html = renderDay(detail({ hasEntry: false, logged: [] }));
    expect(html).toMatch(/Nothing logged/i);
  });

  it('marks an imported entry and an approximate date', () => {
    const html = renderDay(detail({ isApproximate: true }));
    expect(html).toMatch(/imported from clue/i);
    expect(html).toMatch(/approximate/i);
  });

  // Important 5 (final review): 'manual' (src/edit.js's EDIT_SOURCE) is not
  // an import — it is what every entry she has typed herself carries.
  // "imported from manual" is nonsense on a day she wrote herself.
  it('does not call her own entry an import', () => {
    const html = renderDay(detail({ source: 'manual' }));
    expect(html).not.toMatch(/imported/i);
  });

  it('says a period is expected on that day', () => {
    expect(renderDay(detail({ predicted: true }))).toMatch(/period expected/i);
  });

  it('says the counterfactual in the past tense, never as lateness', () => {
    const html = renderDay(detail({ baseline: true }));
    expect(html).toMatch(/without birth control/i);
    expect(html).not.toMatch(/late/i);
  });

  it('names the method in force that day', () => {
    expect(renderDay(detail())).toContain('pill');
  });

  it('says when a day is still ahead', () => {
    expect(renderDay(detail({ isFuture: true }))).toMatch(/still to come|upcoming/i);
  });

  it('has no cycle day before the first period logged', () => {
    const html = renderDay(detail({ cycleStart: null, cycleDay: null }));
    expect(html).not.toMatch(/Day null|Day undefined/);
  });

  it('escapes what was logged', () => {
    const html = renderDay(detail({ logged: [{ label: 'Notes', value: '<img src=x>' }] }));
    expect(html).not.toContain('<img');
  });

  it('prints no null, undefined or NaN', () => {
    const html = renderDay(detail({
      cycleStart: null, cycleDay: null, hasEntry: false, logged: [],
      source: null, method: null,
    }));
    expect(html).not.toMatch(/null|undefined|NaN/);
  });

  it('produces balanced markup', () => {
    const html = renderDay(detail());
    expect((html.match(/<(?!\/)[a-z]/g) ?? []).length).toBe((html.match(/<\//g) ?? []).length);
  });
});

describe('calendar colour coding', () => {
  const grid = (days, options = {}) => monthGrid(
    { version: 1, gaps: [], birthControl: [], spans: options.spans ?? [], days },
    { month: '2015-03', todayISO: '2015-03-10', ...options },
  );

  // The fill is the at-a-glance encoding; the dot inside repeats the
  // intensity as a size, which is what survives colour blindness.
  it('fills a bleeding day by intensity, and keeps the dot', () => {
    const html = renderCalendar(grid({
      '2015-03-02': { flow: 'light' },
      '2015-03-03': { flow: 'medium' },
      '2015-03-04': { flow: 'heavy' },
    }));
    for (const intensity of ['light', 'medium', 'heavy']) {
      expect(html).toContain(`cal-flow-${intensity}`);
      expect(html).toContain(`cal-dot flow-${intensity}`);
    }
  });

  it('gives a period day whose intensity was never recorded a plain dot', () => {
    const html = renderCalendar(grid({}, {
      spans: [{ start: '2015-03-02', end: '2015-03-04', source: 'test' }],
    }));
    expect(html).toContain('cal-dot flow-medium');
  });

  it('marks a positive test', () => {
    const html = renderCalendar(grid({
      '2015-03-05': { tests: { ovulation: 'positive', pregnancy: null } },
    }));
    expect(html).toContain('cal-test');
  });

  it('carries a legend naming every colour', () => {
    const html = renderCalendar(grid({}));
    for (const label of [
      'Light', 'Medium', 'Heavy', 'Spotting', 'PMS', 'Positive test',
      'Period expected', 'Would have been',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('gives each legend swatch the class of the cells it explains', () => {
    const legend = renderCalendar(grid({})).match(/<ul class="cal-legend">[\s\S]*<\/ul>/)[0];
    for (const className of [
      'cal-swatch-light', 'cal-swatch-medium', 'cal-swatch-heavy',
      'cal-spotting', 'cal-pms', 'cal-test', 'cal-predicted', 'cal-baseline',
    ]) {
      expect(legend, className).toContain(className);
    }
  });

  it('marks every counterfactual day of the month, not just one', () => {
    const html = renderCalendar(grid({}, { baselineDates: ['2015-03-05', '2015-03-26'] }));
    expect((html.match(/cal-baseline/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('still balances its markup with the legend attached', () => {
    const html = renderCalendar(grid({ '2015-03-02': { flow: 'heavy' } }));
    expect((html.match(/<(?!\/)[a-z]/g) ?? []).length).toBe((html.match(/<\//g) ?? []).length);
  });
});

describe('the month picker', () => {
  const range = { first: '2015-01', last: '2016-08' };
  const html = (month = '2015-07') => renderMonthPicker({ month, range });

  it('offers every month of the year', () => {
    for (const name of ['January', 'July', 'December']) expect(html()).toContain(name);
    expect((html().match(/<option value="\d{2}"/g) ?? [])).toHaveLength(12);
  });

  it('offers every year in the range', () => {
    expect(html()).toContain('>2015<');
    expect(html()).toContain('>2016<');
    expect((html().match(/<option value="\d{4}"/g) ?? [])).toHaveLength(2);
  });

  it('preselects the month and year on screen', () => {
    expect(html('2016-02')).toMatch(/<option value="02" selected/);
    expect(html('2016-02')).toMatch(/<option value="2016" selected/);
  });

  it('selects exactly one of each', () => {
    expect((html().match(/selected/g) ?? [])).toHaveLength(2);
  });

  it('carries the ids the app listens on', () => {
    expect(html()).toContain('id="cal-month"');
    expect(html()).toContain('id="cal-year"');
  });

  it('labels both selects for a screen reader', () => {
    expect(html()).toMatch(/aria-label="Month"/);
    expect(html()).toMatch(/aria-label="Year"/);
  });

  it('prints no null, undefined or NaN', () => {
    expect(html()).not.toMatch(/null|undefined|NaN/);
  });

  it('produces balanced markup', () => {
    const output = html();
    expect((output.match(/<(?!\/)[a-z]/g) ?? []).length).toBe((output.match(/<\//g) ?? []).length);
  });

  it('handles a one-year range', () => {
    const narrow = renderMonthPicker({ month: '2015-03', range: { first: '2015-01', last: '2015-12' } });
    expect((narrow.match(/<option value="\d{4}"/g) ?? [])).toHaveLength(1);
  });
});
