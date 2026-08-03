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

export interface WorkingHoursCopy {
  days: string;
  hours: string;
  timezone: string;
}

export function formatWorkingHours(hours: WorkingHoursInput | null | undefined): WorkingHoursCopy | null {
  if (!hours || hours.days.length === 0) return null;
  return {
    days: formatDays(hours.days),
    hours: `${formatTime(hours.start)}–${formatTime(hours.end)}`,
    timezone: formatTimezone(hours.timezone),
  };
}
