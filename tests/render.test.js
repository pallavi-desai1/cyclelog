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

  // Critical 4: a scope-narrowed shared document carries an episode whose
  // name was stripped. buildSummary already turns that into method: null
  // (tested in summary.test.js); this pins the renderer's half — it must
  // not print a "Method:" line with an empty or undefined value.
  it('omits the Method line entirely when the episode has no method name', () => {
    const noName = [{ startedOn: '2015-06-01', endedOn: null, expectedEffect: 'suppress' }];
    const html = render(doc(noName), '2015-07-15');
    expect(html).not.toMatch(/Method/);
  });

  it('shows how many days late when a period is overdue', () => {
    expect(render(doc(REGULATE), '2015-07-15')).toContain('83 days late');
  });

  it('says "1 day late" on the first day overdue', () => {
    expect(render(doc(EARLY_PILL), '2015-04-24')).toContain('1 day late');
  });

  it('shows the confidence figure for a real prediction', () => {
    expect(render(doc(REGULATE), '2015-07-15')).toContain('25%');
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

  it('drops the line comparing her to a cycle without birth control', () => {
    for (const html of [render(doc(SUPPRESS), '2015-07-15'), render(doc(EARLY_PILL), '2015-04-20')]) {
      expect(html).not.toContain('Off birth control');
      expect(html).not.toMatch(/would have/i);
      expect(html).not.toMatch(/ghost/i);
    }
  });

  // buildSummary still computes the shift, for the Insights screen.
  it('no longer prints the shift against the natural cycle', () => {
    const bled = doc(EARLY_PILL);
    bled.spans.push({ start: '2015-04-27', end: null, source: 'test' });
    expect(buildSummary(bled, '2015-05-10').divergence.meanShift).not.toBeNull();
    expect(render(bled, '2015-05-10')).not.toMatch(/compared with/i);
  });

  describe('the phase line', () => {
    const caveat = { fixed: 'FIXED COPY', uncertainty: 'UNCERTAIN COPY' };
    const withPhase = phase => renderSummary({ ...buildSummary(doc(), '2015-04-20'), phase });

    it('names the phase she is in', () => {
      const html = withPhase({ name: 'luteal', cycleDay: 19, window: null, fromTest: false, caveat });
      expect(html).toMatch(/Luteal/);
      expect(html).toContain('Day 19');
    });

    it('prints no phase line when the phase is unknown', () => {
      const html = withPhase({ name: 'unknown', cycleDay: null, window: null, fromTest: false, caveat });
      expect(html).not.toMatch(/Unknown/i);
      expect(html).not.toContain('class="phase"');
    });

    it('prints no Day undefined or Day NaN when the cycle day is not a number', () => {
      for (const cycleDay of [undefined, NaN, null]) {
        const html = withPhase({ name: 'luteal', cycleDay, window: null, fromTest: false, caveat });
        expect(html).toMatch(/Luteal/);
        expect(html).not.toMatch(/Day (undefined|NaN|null)/);
      }
    });

    it('prints the caveat beside a fertile phase, and not beside a luteal one', () => {
      const fertile = withPhase({ name: 'fertile', cycleDay: 12, window: null, fromTest: false, caveat });
      expect(fertile).toContain('FIXED COPY');
      expect(fertile).toContain('UNCERTAIN COPY');
      expect(fertile).toMatch(/predicted/i);
      const luteal = withPhase({ name: 'luteal', cycleDay: 19, window: null, fromTest: false, caveat });
      expect(luteal).not.toContain('FIXED COPY');
    });
  });

  describe('a next date moved by a positive test', () => {
    const withAdapted = adapted => renderSummary({ ...buildSummary(doc(), '2015-04-20'), adapted });

    it('says where the date came from instead of printing a percentage', () => {
      const html = withAdapted({ available: true, date: '2015-04-05', fromTest: true, confidence: null });
      expect(html).toContain('from your positive ovulation test');
      expect(html).not.toMatch(/% confident/);
    });

    it('prints no percentage even if one is handed over with a test-moved date', () => {
      const html = withAdapted({ available: true, date: '2015-04-05', fromTest: true, confidence: 70 });
      expect(html).not.toMatch(/% confident|70%/);
    });

    it('still prints the confidence on a date from the model', () => {
      const html = withAdapted({ available: true, date: '2015-04-05', fromTest: false, confidence: 70 });
      expect(html).toContain('70% confident');
      expect(html).not.toContain('positive ovulation test');
    });
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
      phase: { name: 'unknown', cycleDay: NaN, window: null, fromTest: false, caveat: null },
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
      // The projection must fall after the next period, or monthGrid clips it.
      adaptedDate: overrides.adaptedDate ?? '2015-03-28',
      upcomingDates: overrides.upcomingDates ?? ['2015-03-30'],
      windows: overrides.windows ?? [],
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

  // §10.3: the adapted prediction is solid, a later projection dashed. They
  // must be separate classes, or the two become indistinguishable in CSS.
  it('marks the prediction and the upcoming projection with different classes', () => {
    expect(html()).toContain('cal-predicted');
    expect(html()).toContain('cal-upcoming');
  });

  it('gives the next period the solid mark alone, never both', () => {
    const both = html({ adaptedDate: '2015-03-31', upcomingDates: ['2015-03-31'] });
    // The legend always carries the swatch classes; only cells are in question.
    const cellsOnly = both.slice(0, both.indexOf('<ul class="cal-legend">'));
    expect(cellsOnly).toContain('cal-predicted');
    expect(cellsOnly).not.toContain('cal-upcoming');
  });

  // Every state encoded by colour or shape is also encoded in words, so the
  // calendar survives colour blindness and a screen reader.
  it('names each state in the cell label', () => {
    const labels = html().match(/aria-label="[^"]*"/g).join(' ');
    expect(labels).toMatch(/heavy flow/);
    expect(labels).toMatch(/spotting/);
    expect(labels).toMatch(/PMS/);
    expect(labels).toMatch(/period expected(?! later)/);
    expect(labels).toMatch(/period expected later/);
    expect(labels).not.toMatch(/birth control/);
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
    predicted: false, upcoming: false,
    isFertile: false, isDescent: false, fromTest: false, caveat: null,
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
    expect(renderDay(detail({ predicted: true }))).toMatch(/period expected(?! later)/i);
  });

  it('says a period is expected later, never as lateness', () => {
    const html = renderDay(detail({ upcoming: true }));
    expect(html).toContain('Period expected later');
    expect(html).not.toMatch(/birth control|late\b/i);
  });

  const fertileCaveat = { fixed: 'FIXED', uncertainty: null };

  it('says what a fertile day is, and carries the caveat', () => {
    const html = renderDay({ ...detail(), isFertile: true, caveat: fertileCaveat });
    expect(html).toContain('Fertile window — predicted');
    expect(html).toContain('FIXED');
  });

  it('prints the uncertainty line when it is given', () => {
    const html = renderDay({ ...detail(), isFertile: true, caveat: { fixed: 'FIXED', uncertainty: 'UNSURE' } });
    expect(html).toContain('UNSURE');
  });

  it('prints no caveat and no fertile line on a day that is not fertile', () => {
    const html = renderDay({ ...detail(), caveat: fertileCaveat });
    expect(html).not.toContain('FIXED');
    expect(html).not.toContain('Fertile window');
  });

  it('names both facts on a day that is bleeding and predicted fertile', () => {
    const html = renderDay({ ...detail(), isPeriod: true, periodDay: 4, cycleDay: 4, isFertile: true, caveat: fertileCaveat });
    expect(html).toMatch(/day 4 of your period/);
    expect(html).toContain('Fertile window — predicted');
  });

  it('says the egg is expected to descend', () => {
    expect(renderDay({ ...detail(), isFertile: true, isDescent: true, caveat: fertileCaveat }))
      .toContain('Egg expected to descend on this day');
  });

  it('says when the window was moved by a positive test', () => {
    expect(renderDay({ ...detail(), isFertile: true, fromTest: true, caveat: fertileCaveat }))
      .toContain('Moved here by a positive ovulation test');
  });

  it('never suggests the days around a fertile day are safe', () => {
    const html = renderDay({ ...detail(), isFertile: true, isDescent: true, caveat: fertileCaveat });
    expect(html).not.toMatch(/safe day|not fertile|infertile/i);
  });

  it('is identical in read-only mode but for the edit button', () => {
    const open = { ...detail(), isFertile: true, isDescent: true, caveat: fertileCaveat };
    expect(renderDay(open, { canEdit: false })).toBe(renderDay(open).replace(/<button id="edit-day"[^<]*<\/button>/, ''));
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
      'Period expected', 'Period expected later',
      'Fertile window (predicted)', 'Egg expected to descend',
    ]) {
      // Whole legend entry, so 'Period expected' is not satisfied by 'Period expected later'.
      expect(html).toContain(`</span>${label}</li>`);
    }
  });

  it('gives each legend swatch the class of the cells it explains', () => {
    const legend = renderCalendar(grid({})).match(/<ul class="cal-legend">[\s\S]*<\/ul>/)[0];
    for (const className of [
      'cal-swatch-light', 'cal-swatch-medium', 'cal-swatch-heavy',
      'cal-spotting', 'cal-pms', 'cal-test', 'cal-predicted', 'cal-upcoming',
      'cal-fertile', 'cal-descent',
    ]) {
      expect(legend, className).toContain(className);
    }
  });

  it('marks every upcoming day of the month, not just one', () => {
    const html = renderCalendar(grid({}, { upcomingDates: ['2015-03-05', '2015-03-26'] }));
    expect((html.match(/cal-upcoming/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  describe('fertile marks', () => {
    const windows = [{ from: '2015-03-11', descent: '2015-03-15', to: '2015-03-16', cycleStart: '2015-03-01', fromTest: false }];
    const caveat = { fixed: 'FIXED COPY', uncertainty: 'UNCERTAIN COPY' };
    const count = (html, re) => (html.match(re) ?? []).length;

    it('puts the fertile and descent classes on the right cells', () => {
      const html = renderCalendar(grid({}, { windows }));
      // Six cells plus the legend swatches.
      expect(count(html, /cal-fertile/g)).toBe(6 + 2);
      expect(count(html, /cal-descent/g)).toBe(1 + 1);
      expect(html).toMatch(/class="[^"]*cal-fertile[^"]*cal-descent[^"]*" data-date="2015-03-15"|class="[^"]*cal-descent[^"]*" data-date="2015-03-15"/);
    });

    it('never puts the descent class on a cell that is not fertile', () => {
      const html = renderCalendar(grid({}, { windows }));
      for (const [, classes] of html.matchAll(/<button type="button" class="([^"]*)"/g)) {
        if (classes.includes('cal-descent')) expect(classes).toContain('cal-fertile');
      }
    });

    it('names every new mark in the cell’s aria-label', () => {
      const html = renderCalendar(grid({}, { windows }));
      expect(html).toContain('fertile window, predicted');
      expect(html).toContain('egg expected to descend');
    });

    it('says when a window was moved by a test', () => {
      const moved = [{ ...windows[0], fromTest: true }];
      expect(renderCalendar(grid({}, { windows: moved })))
        .toContain('moved here by a positive ovulation test');
      expect(renderCalendar(grid({}, { windows }))).not.toContain('moved here');
    });

    it('relabels the dashed mark as a period expected later', () => {
      const html = renderCalendar(grid({}, { upcomingDates: ['2015-03-26'] }));
      expect(html).toContain('Period expected later');
      expect(html).not.toContain('without birth control');
    });

    it('prints the caveat under the legend whenever a fertile mark is showing', () => {
      const html = renderCalendar(grid({}, { windows }), { caveat });
      expect(html).toContain('FIXED COPY');
      expect(html).toContain('UNCERTAIN COPY');
      expect(html.indexOf('cal-legend')).toBeLessThan(html.indexOf('FIXED COPY'));
    });

    it('omits the caveat when no fertile mark is on screen', () => {
      const html = renderCalendar(grid({}, { windows: [] }), { caveat: { fixed: 'FIXED COPY', uncertainty: null } });
      expect(html).not.toContain('FIXED COPY');
    });

    it('prints the caveat exactly as given, not recomputed', () => {
      const html = renderCalendar(grid({}, { windows }), { caveat: { fixed: 'ONLY THIS', uncertainty: null } });
      expect(html).toContain('ONLY THIS');
      expect(html).not.toContain('UNCERTAIN COPY');
    });

    it('never renders anything suggesting the unmarked days are safe', () => {
      const html = renderCalendar(grid({}, { windows }), { caveat: { fixed: 'f', uncertainty: null } });
      expect(html).not.toMatch(/safe day|not fertile|infertile/i);
    });
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
describe('renderDay on a read-only screen', () => {
  const detail = {
    label: '21 March 2015', isToday: false, isFuture: false,
    cycleDay: 2, periodDay: 2, isPeriod: true,
    hasEntry: true, logged: [{ label: 'Flow', value: 'heavy' }],
    source: 'manual', isApproximate: false, method: null,
    predicted: false, upcoming: false,
    isFertile: false, isDescent: false, fromTest: false, caveat: null,
  };

  // Review Focus 5 again, one layer lower: drawViewerDay never touches the
  // editor, but renderDay emitted the Edit button itself — so the partner's
  // pane showed a control whose handler requires `selectedDate`, state his
  // device never sets. It did nothing when tapped, which is worse than
  // absent: a read-only screen must not offer an action at all.
  it('offers no edit button when editing is not allowed', () => {
    const html = renderDay(detail, { canEdit: false });
    expect(html).not.toContain('edit-day');
    expect(html).not.toMatch(/Edit this day/i);
  });

  it('still shows the day itself', () => {
    const html = renderDay(detail, { canEdit: false });
    expect(html).toContain('21 March 2015');
    expect(html).toContain('heavy');
  });

  it('keeps the button by default, so her own screen is unchanged', () => {
    expect(renderDay(detail)).toContain('id="edit-day"');
  });
});
