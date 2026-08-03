import { z } from 'zod';

export const WorkingDaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type WorkingDay = z.infer<typeof WorkingDaySchema>;

const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must use HH:mm');

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const WorkingHoursSchema = z
  .object({
    timezone: z.string().min(1).refine(isIanaTimezone, 'timezone must be a valid IANA timezone'),
    days: z
      .array(WorkingDaySchema)
      .min(1)
      .refine((days) => new Set(days).size === days.length, {
        message: 'days must not contain duplicates',
      }),
    start: ClockTimeSchema,
    end: ClockTimeSchema,
  })
  .refine((value) => value.start < value.end, {
    message: 'end must be later than start',
    path: ['end'],
  });

export type WorkingHours = z.infer<typeof WorkingHoursSchema>;
