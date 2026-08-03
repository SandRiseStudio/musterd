import type { WorkingDay, WorkingHours } from '@musterd/protocol';

const DAY_LABELS: Record<WorkingDay, string> = {
  mon: 'MON',
  tue: 'TUE',
  wed: 'WED',
  thu: 'THU',
  fri: 'FRI',
  sat: 'SAT',
  sun: 'SUN',
};
const DAY_ORDER: WorkingDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

type WorkingHoursInput = Omit<WorkingHours, 'days'> & { days: readonly WorkingDay[] };

function formatDays(days: readonly WorkingDay[]): string {
  const selected = new Set(days);
  const groups: string[] = [];
  let start: number | null = null;
  for (let i = 0; i <= DAY_ORDER.length; i += 1) {
    const present = i < DAY_ORDER.length && selected.has(DAY_ORDER[i]!);
    if (present && start === null) start = i;
    if (!present && start !== null) {
      const end = i - 1;
      groups.push(
        end - start >= 2
          ? `${DAY_LABELS[DAY_ORDER[start]!]}–${DAY_LABELS[DAY_ORDER[end]!]}`
          : Array.from({ length: end - start + 1 }, (_, offset) => DAY_LABELS[DAY_ORDER[start! + offset]!]!).join(' · '),
      );
      start = null;
    }
  }
  return groups.join(' · ');
}

function formatTime(value: string): string {
  const [rawHours, rawMinutes] = value.split(':').map(Number);
  const hours = rawHours ?? 0;
  const minutes = rawMinutes ?? 0;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function formatTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longGeneric',
    }).formatToParts(new Date('2026-01-15T12:00:00Z'));
    const label = parts.find((part) => part.type === 'timeZoneName')?.value;
    if (label) return label.toUpperCase();
  } catch {
    /* The protocol rejects invalid zones; this keeps a defensive renderer total. */
  }
  return timezone.replaceAll('_', ' ').toUpperCase();
}

/**
 * `11a`, `3p`, `11:30a` — a wall sign is read at a glance from across a room, where `11:00 AM` is four
 * wasted glyphs. The minutes survive only when there are any; the o'clock case is the common one.
 */
function formatTimeShort(value: string): string {
  const [rawHours, rawMinutes] = value.split(':').map(Number);
  const hours = rawHours ?? 0;
  const minutes = rawMinutes ?? 0;
  const suffix = hours >= 12 ? 'p' : 'a';
  const hour = hours % 12 || 12;
  return minutes === 0 ? `${hour}${suffix}` : `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/** `PT`, not `PACIFIC TIME` — the same sign, the same reason. */
function formatTimezoneShort(timezone: string, long: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortGeneric',
    }).formatToParts(new Date('2026-01-15T12:00:00Z'));
    const label = parts.find((part) => part.type === 'timeZoneName')?.value;
    // `shortGeneric` is only short for zones that have an abbreviation — elsewhere it answers a GMT
    // offset or a spelt-out name ("India Time"). Initials beat both on a sign this size.
    if (label && label.length <= 5 && !/\s|GMT|UTC/i.test(label)) return label.toUpperCase();
  } catch {
    /* see formatTimezone */
  }
  const initials = long
    .split(/[\s/]+/)
    .map((word) => word[0])
    .join('');
  return initials.length > 1 ? initials : long;
}

export interface WorkingHoursCopy {
  days: string;
  hours: string;
  hoursShort: string;
  timezone: string;
  timezoneShort: string;
}

export function formatWorkingHours(hours: WorkingHoursInput | null | undefined): WorkingHoursCopy | null {
  if (!hours || hours.days.length === 0) return null;
  const timezone = formatTimezone(hours.timezone);
  return {
    days: formatDays(hours.days),
    hours: `${formatTime(hours.start)}–${formatTime(hours.end)}`,
    hoursShort: `${formatTimeShort(hours.start)}–${formatTimeShort(hours.end)}`,
    timezone,
    timezoneShort: formatTimezoneShort(hours.timezone, timezone),
  };
}
