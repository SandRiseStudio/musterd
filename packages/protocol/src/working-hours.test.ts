import { describe, expect, it } from 'vitest';
import { WorkingHoursSchema } from './working-hours.js';

const reviveHours = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '11:00',
  end: '15:00',
};

describe('WorkingHoursSchema', () => {
  it('accepts a recurring Pacific weekday window', () => {
    expect(WorkingHoursSchema.parse(reviveHours)).toEqual(reviveHours);
  });

  it('accepts every supported weekday key', () => {
    expect(
      WorkingHoursSchema.parse({
        ...reviveHours,
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      }).days,
    ).toHaveLength(7);
  });

  it.each([
    ['empty days', { days: [] }],
    ['duplicate days', { days: ['mon', 'mon'] }],
    ['invalid day', { days: ['monday'] }],
    ['invalid start', { start: '9:00' }],
    ['invalid end', { end: '15:60' }],
    ['end before start', { start: '15:00', end: '11:00' }],
    ['invalid timezone', { timezone: 'Pacific/Definitely_Not_A_Timezone' }],
  ])('rejects %s', (_label, override) => {
    expect(() => WorkingHoursSchema.parse({ ...reviveHours, ...override })).toThrow();
  });
});
