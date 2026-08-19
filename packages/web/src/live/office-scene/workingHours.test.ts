import { describe, expect, it } from 'vitest';
import { formatWorkingHours, isWithinWorkingHours } from './workingHours';

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

/** The lighting's shift clock: resolves "is the team on shift right now?" in the schedule's own
 * timezone. Dates below are UTC instants chosen so the schedule-local weekday/hour differ from UTC. */
describe('isWithinWorkingHours', () => {
  it('is true inside the hours on a working day', () => {
    // 2026-08-19 is a Wednesday; 19:00 UTC = 12:00 PDT — inside 11:00–15:00.
    expect(isWithinWorkingHours(weekdays, new Date('2026-08-19T19:00:00Z'))).toBe(true);
  });

  it('is false outside the hours on a working day', () => {
    // 05:00 UTC = 22:00 PDT the previous evening (Tue) — still a workday, but off hours.
    expect(isWithinWorkingHours(weekdays, new Date('2026-08-19T23:00:00Z'))).toBe(false); // 16:00 PDT
  });

  it('is false on a day the schedule does not include', () => {
    // 2026-08-22 19:00 UTC = Saturday 12:00 PDT — right hours, wrong day.
    expect(isWithinWorkingHours(weekdays, new Date('2026-08-22T19:00:00Z'))).toBe(false);
  });

  it('resolves the weekday in the schedule timezone, not UTC', () => {
    // 2026-08-22T02:00Z is Saturday in UTC but Friday 19:00 in America/Los_Angeles —
    // a Fri 18:00–20:00 schedule is on shift at that instant.
    const lateFriday = { ...weekdays, days: ['fri'] as const, start: '18:00', end: '20:00' };
    expect(isWithinWorkingHours(lateFriday, new Date('2026-08-22T02:00:00Z'))).toBe(true);
  });

  it('starts inclusive, ends exclusive', () => {
    // 18:00 UTC = 11:00 PDT sharp; 22:00 UTC = 15:00 PDT sharp.
    expect(isWithinWorkingHours(weekdays, new Date('2026-08-19T18:00:00Z'))).toBe(true);
    expect(isWithinWorkingHours(weekdays, new Date('2026-08-19T22:00:00Z'))).toBe(false);
  });

  it('honors an hour override (the ?light dev preview) while keeping the real weekday', () => {
    // Wednesday, override the clock to 23:00 — off shift; to 12:00 — on shift.
    const wed = new Date('2026-08-19T19:00:00Z');
    expect(isWithinWorkingHours(weekdays, wed, 23)).toBe(false);
    expect(isWithinWorkingHours(weekdays, wed, 12)).toBe(true);
  });
});
