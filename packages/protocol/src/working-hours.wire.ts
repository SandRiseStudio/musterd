/**
 * Working hours (ADR 206) as plain TypeScript — no zod. `working-hours.ts` builds the schema from
 * these, so the day vocabulary and the clock/order rules have one home and the browser can read a
 * schedule without pulling a validator into its bundle (`guards.ts`).
 */

export const WORKING_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WorkingDay = (typeof WORKING_DAYS)[number];

/** A recurring schedule. `start`/`end` are `HH:mm` in `timezone`; `end` is later than `start`. */
export interface WorkingHours {
  timezone: string;
  days: WorkingDay[];
  start: string;
  end: string;
}

/** `HH:mm`, 24-hour. The single spelling of the clock format both readers check. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && CLOCK_TIME.test(value);
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Days must be non-empty and duplicate-free — the rule both readers apply. */
export function isWorkingDayList(days: unknown): days is WorkingDay[] {
  if (!Array.isArray(days) || days.length === 0) return false;
  if (!days.every((d): d is WorkingDay => WORKING_DAYS.includes(d as WorkingDay))) return false;
  return new Set(days).size === days.length;
}
