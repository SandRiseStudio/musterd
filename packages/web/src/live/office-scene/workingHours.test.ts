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
      hours: '11am–3pm',
    });
  });

  it('abbreviates for the sign without losing a half hour', () => {
    expect(formatWorkingHours({ ...weekdays, start: '09:30', end: '17:45' })).toMatchObject({
      hours: '9:30am–5:45pm',
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
