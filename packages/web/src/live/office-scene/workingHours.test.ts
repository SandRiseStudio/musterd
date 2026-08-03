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
      hoursShort: '11a–3p',
      timezone: 'PACIFIC TIME',
      timezoneShort: 'PT',
    });
  });

  it('abbreviates for the sign without losing a half hour', () => {
    expect(formatWorkingHours({ ...weekdays, start: '09:30', end: '17:45' })).toMatchObject({
      hoursShort: '9:30a–5:45p',
    });
  });

  it('falls back to initials for a zone with no abbreviation', () => {
    // Intl's short form for Kolkata is the spelt-out "India Time" — too long for the card, so initials win.
    expect(formatWorkingHours({ ...weekdays, timezone: 'Asia/Kolkata' })).toMatchObject({
      timezoneShort: 'IST',
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
