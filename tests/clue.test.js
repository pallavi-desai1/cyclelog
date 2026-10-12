import { describe, it, expect } from 'vitest';
import { parseClueMeasurements, blankDay, buildSpansFromFlow } from '../src/importers/clue.js';

const rec = (type, date, value, id = `${type}-${date}`) => ({ type, date, value, id });

describe('parseClueMeasurements', () => {
  it('maps a bare-object period value to flow', () => {
    const { days } = parseClueMeasurements([rec('period', '2016-01-02', { option: 'medium' })]);
    expect(days['2016-01-02'].flow).toBe('medium');
  });

  it('maps an array-wrapped value to its field', () => {
    const { days } = parseClueMeasurements([rec('discharge', '2016-01-02', [{ option: 'creamy' }])]);
    expect(days['2016-01-02'].discharge).toBe('creamy');
  });

  it('maps period_cramps to unknown intensity', () => {
    const { days } = parseClueMeasurements([rec('pain', '2016-01-02', [{ option: 'period_cramps' }])]);
    expect(days['2016-01-02'].cramps).toBe('unknown');
  });

  it('maps pain_free to no cramps', () => {
    const { days } = parseClueMeasurements([rec('pain', '2016-01-03', [{ option: 'pain_free' }])]);
    expect(days['2016-01-03'].cramps).toBe('none');
  });

  it('collects other pain options into pain[]', () => {
    const { days } = parseClueMeasurements([
      rec('pain', '2016-01-04', [{ option: 'headache' }, { option: 'ovulation' }]),
    ]);
    expect(days['2016-01-04'].pain).toEqual(['headache', 'ovulation']);
    expect(days['2016-01-04'].cramps).toBeNull();
  });

  it('maps pms yes to a boolean', () => {
    const { days } = parseClueMeasurements([rec('pms', '2016-01-05', { option: 'yes' })]);
    expect(days['2016-01-05'].pms).toBe(true);
  });

  it('folds feelings, mind and social_life into mood', () => {
    const { days } = parseClueMeasurements([
      rec('feelings', '2016-01-06', [{ option: 'sensitive' }]),
      rec('mind', '2016-01-06', [{ option: 'stressed' }]),
      rec('social_life', '2016-01-06', [{ option: 'withdrawn' }]),
    ]);
    expect(days['2016-01-06'].mood.sort()).toEqual(['sensitive', 'stressed', 'withdrawn']);
  });

  it('splits test results into ovulation and pregnancy', () => {
    const { days } = parseClueMeasurements([
      rec('tests', '2016-01-07', [{ option: 'pregnancy_negative' }]),
      rec('tests', '2016-01-08', [{ option: 'ovulation_positive' }]),
    ]);
    expect(days['2016-01-07'].tests.pregnancy).toBe('negative');
    expect(days['2016-01-08'].tests.ovulation).toBe('positive');
  });

  it('turns an inserted implant record into a birth-control episode', () => {
    const { birthControl, days } = parseClueMeasurements([
      rec('birth_control_implant', '2016-02-01', { option: 'inserted' }),
    ]);
    expect(birthControl).toEqual([{
      method: 'implant', startedOn: '2016-02-01', endedOn: null, expectedEffect: 'suppress',
    }]);
    expect(days['2016-02-01']).toBeUndefined();
  });

  it('drops excluded categories entirely, creating no day entry', () => {
    const { days, dropped } = parseClueMeasurements([
      rec('sleep_duration', '2016-03-01', { minutes: 450 }),
      rec('energy', '2016-03-01', [{ option: 'tired' }]),
      rec('sex_life', '2016-03-01', [{ option: 'orgasm' }]),
      rec('collection_method', '2016-03-01', [{ option: 'pad' }]),
    ]);
    expect(days['2016-03-01']).toBeUndefined();
    expect(dropped).toEqual({ sleep_duration: 1, energy: 1, sex_life: 1, collection_method: 1 });
  });

  it('warns about an unmapped type without creating a day', () => {
    const { days, warnings } = parseClueMeasurements([rec('weather', '2016-03-02', [{ option: 'rain' }])]);
    expect(days['2016-03-02']).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/unmapped type: weather/);
  });

  // Review Focus 2: the real export is not date-ordered.
  it('reconstructs spans correctly from shuffled input', () => {
    const ordered = ['2016-04-01', '2016-04-02', '2016-04-03'].map(d => rec('period', d, { option: 'light' }));
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    const { spans } = parseClueMeasurements(shuffled);
    expect(spans).toEqual([{
      start: '2016-04-01', end: '2016-04-03',
      precision: 'exact', endPrecision: 'exact', source: 'clue',
    }]);
  });

  // Review Focus 3: duplicates must resolve the same way every run.
  it('resolves duplicate records for one date and type deterministically', () => {
    const a = rec('period', '2016-05-01', { option: 'light' }, 'id-a');
    const b = rec('period', '2016-05-01', { option: 'heavy' }, 'id-b');
    const first = parseClueMeasurements([a, b]).days['2016-05-01'].flow;
    const second = parseClueMeasurements([b, a]).days['2016-05-01'].flow;
    expect(first).toBe(second);
    expect(first).toBe('heavy');
  });

  it('ignores a record whose value carries no option', () => {
    const { days } = parseClueMeasurements([rec('period', '2016-05-02', [])]);
    expect(days['2016-05-02']).toBeUndefined();
  });

  it('warns about an unknown test option without creating a day', () => {
    const { days, warnings } = parseClueMeasurements([
      rec('tests', '2016-05-03', [{ option: 'strep_negative' }]),
    ]);
    expect(days['2016-05-03']).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/unknown test option: strep_negative/);
  });

  it('records a recognised test option even when another is unknown', () => {
    const { days, warnings } = parseClueMeasurements([
      rec('tests', '2016-05-04', [{ option: 'strep_negative' }, { option: 'pregnancy_positive' }]),
    ]);
    expect(days['2016-05-04'].tests.pregnancy).toBe('positive');
    expect(warnings.join(' ')).toMatch(/unknown test option/);
  });
});

describe('buildSpansFromFlow', () => {
  const flowDays = (dates) => Object.fromEntries(
    dates.map(d => [d, { ...blankDay('clue'), flow: 'light' }]),
  );

  it('groups consecutive days into one span', () => {
    expect(buildSpansFromFlow(flowDays(['2016-06-01', '2016-06-02', '2016-06-03'])))
      .toMatchObject([{ start: '2016-06-01', end: '2016-06-03' }]);
  });

  it('keeps a two-day gap inside the same span', () => {
    expect(buildSpansFromFlow(flowDays(['2016-06-01', '2016-06-03'])))
      .toMatchObject([{ start: '2016-06-01', end: '2016-06-03' }]);
  });

  it('starts a new span after a three-day gap', () => {
    expect(buildSpansFromFlow(flowDays(['2016-06-01', '2016-06-04'])))
      .toMatchObject([{ start: '2016-06-01', end: '2016-06-01' }, { start: '2016-06-04', end: '2016-06-04' }]);
  });

  it('preserves a single-day span', () => {
    expect(buildSpansFromFlow(flowDays(['2016-07-10'])))
      .toMatchObject([{ start: '2016-07-10', end: '2016-07-10' }]);
  });

  it('spans a year boundary', () => {
    expect(buildSpansFromFlow(flowDays(['2016-12-31', '2017-01-01'])))
      .toMatchObject([{ start: '2016-12-31', end: '2017-01-01' }]);
  });

  it('ignores days with no flow', () => {
    const days = { '2016-08-01': { ...blankDay('clue'), pms: true } };
    expect(buildSpansFromFlow(days)).toEqual([]);
  });

  it('returns no spans for no days', () => {
    expect(buildSpansFromFlow({})).toEqual([]);
  });
});
