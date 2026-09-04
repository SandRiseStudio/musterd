import { z } from 'zod';
import { CLOCK_TIME, WORKING_DAYS, isIanaTimezone } from './working-hours.wire.js';

/** The zod face of {@link WorkingHours}; the day tuple and its rules live in `working-hours.wire.js`. */
export {
  CLOCK_TIME,
  WORKING_DAYS,
  isClockTime,
  isIanaTimezone,
  isWorkingDayList,
  type WorkingDay,
  type WorkingHours,
} from './working-hours.wire.js';

export const WorkingDaySchema = z.enum(WORKING_DAYS);

const ClockTimeSchema = z.string().regex(CLOCK_TIME, 'time must use HH:mm');

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
