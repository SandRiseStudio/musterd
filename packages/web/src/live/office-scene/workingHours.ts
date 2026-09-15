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

/**
 * `11am`, `3pm`, `9:30am` — a wall sign is read at a glance from across a room, where `11:00 AM` spends
 * four glyphs saying nothing. The minutes survive only when there are any; o'clock is the common case.
 */
function formatTime(value: string): string {
  const [rawHours, rawMinutes] = value.split(':').map(Number);
  const hours = rawHours ?? 0;
  const minutes = rawMinutes ?? 0;
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour = hours % 12 || 12;
  return minutes === 0 ? `${hour}${suffix}` : `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/**
 * What the sign says, and nothing else: the days and the hours. No caption (the card's own shape is the
 * caption) and no timezone — the fixture is ~60px of wall in the room, and a third line is a smudge.
 * The Team's timezone still lives in the schedule data; it just isn't wall copy.
 */
export interface WorkingHoursCopy {
  days: string;
  hours: string;
}

export function formatWorkingHours(hours: WorkingHoursInput | null | undefined): WorkingHoursCopy | null {
  if (!hours || hours.days.length === 0) return null;
  return {
    days: formatDays(hours.days),
    hours: `${formatTime(hours.start)}–${formatTime(hours.end)}`,
  };
}

/** `"11:00"` → 11, `"09:30"` → 9.5 — schedule clock times as fractional hours. */
function clockToHours(value: string): number {
  const [hh, mm] = value.split(':').map(Number);
  return (hh ?? 0) + (mm ?? 0) / 60;
}

/**
 * Is `at` inside the schedule — right day AND right hours, both resolved in the schedule's own
 * timezone (never the viewer's or UTC)? Start is inclusive, end exclusive. `hourOverride` swaps
 * only the clock while keeping the real weekday — the `?light=HH` dev preview rides it, so
 * previewing 11pm on a workday shows the after-hours office.
 */
export function isWithinWorkingHours(
  hours: WorkingHoursInput,
  at: Date = new Date(),
  hourOverride?: number,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const read = (type: string) => parts.find((p) => p.type === type)?.value;
  const day = read('weekday')?.toLowerCase() as WorkingDay | undefined;
  if (!day || !hours.days.includes(day)) return false;
  const clock =
    hourOverride ?? (Number(read('hour') ?? '12') % 24) + Number(read('minute') ?? '0') / 60;
  return clock >= clockToHours(hours.start) && clock < clockToHours(hours.end);
}
