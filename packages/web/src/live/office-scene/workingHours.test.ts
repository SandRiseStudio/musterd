import { describe, expect, it } from 'vitest';
import { formatWorkingHours } from './workingHours';

const weekdays = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const,
  start: '11:00',
  end: '15:00',
};

describe('formatWorkingHours', () => {
  it('formats the revive schedule as a readable sign payload', () => {
    expect(formatWorkingHours(weekdays)).toEqual({
      days: 'MON–FRI',
      hours: '11:00 AM–3:00 PM',
      timezone: 'PACIFIC TIME',
    });
  });

  it('keeps split weekday groups explicit', () => {
    expect(
      formatWorkingHours({ ...weekdays, days: ['mon', 'wed', 'fri'] as const }),
    ).toMatchObject({ days: 'MON · WED · FRI' });
  });

  it('returns null when no schedule exists', () => {
    expect(formatWorkingHours(null)).toBeNull();
  });
});
