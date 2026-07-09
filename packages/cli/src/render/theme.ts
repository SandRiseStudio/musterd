import type { Act, MemberKind, PresenceStatus } from '@musterd/protocol';
import { createColors } from 'picocolors';

/**
 * The active color instance. `createColors()` with no argument auto-detects support, so it already
 * honors `NO_COLOR` and a non-TTY stdout — identical to picocolors' default export.
 * `setColorEnabled(false)` swaps in a no-op instance so `--no-color` works too. Every `theme` role
 * closes over this binding, so a toggle before first render is picked up at call time.
 */
let colors = createColors();

/**
 * Force color off (the `--no-color` flag, wired once in `bin.ts`). Only ever called with `false`:
 * forcing color *on* (`createColors(true)`) would push ANSI into pipes and break `--json`/piped use,
 * so enabling is left entirely to picocolors' auto-detection.
 */
export function setColorEnabled(enabled: boolean): void {
  if (!enabled) colors = createColors(false);
}

type Colors = ReturnType<typeof createColors>;

/**
 * A live view of the active color instance, for the few call sites that need colors beyond the theme
 * roles (the `init` wizard's `bgYellow`/`black`, etc.). It always delegates to the *current* instance,
 * so `--no-color` is honored even though the import is captured once — unlike importing `picocolors`
 * directly, which pins the default instance and escapes the toggle. Prefer the `theme` roles / `ui`
 * helpers where they fit; reach for this only for one-off colors they don't cover.
 */
export const paint: Colors = new Proxy({} as Colors, {
  get: (_t, prop: string) => (colors as unknown as Record<string, unknown>)[prop],
});

/** ANSI color roles, mapped per brand.md §2. Honors NO_COLOR / non-TTY / --no-color. */
export const theme = {
  accent: (s: string) => colors.bold(colors.yellow(s)),
  memberName: (name: string, kind: MemberKind) =>
    kind === 'agent' ? colors.cyan(name) : colors.magenta(name),
  meta: (s: string) => colors.gray(s),
  ok: (s: string) => colors.green(s),
  warn: (s: string) => colors.yellow(s),
  err: (s: string) => colors.red(s),
  dim: (s: string) => colors.dim(s),
  bold: (s: string) => colors.bold(s),
  /** A day-group section header in the inbox (`Today`, `Yesterday`, `Monday · Jul 7`) — quiet-bold. */
  dayHeader: (s: string) => colors.bold(colors.gray(s)),
  /** The brand chip: text reversed out of a solid mustard block — the CLI wordmark lockup (ADR 114). */
  brandmark: (s: string) => colors.bold(colors.inverse(colors.yellow(s))),

  /**
   * A high-salience, sticky banner for an act that needs the human *now* — `request_help` or an
   * act addressed to them. Inverse-yellow so it survives a stream of team `status_update`s in the
   * watch pane (the supervising-human turn-taking failure Co-Gym's notification ablation measured;
   * see ADR 024). Outranks `accent` (plain bold-yellow) on purpose.
   */
  actionNeeded: (label = '⚑ ACTION NEEDED') =>
    colors.bold(colors.inverse(colors.yellow(` ${label} `))),

  presenceDot(status: PresenceStatus): string {
    if (status === 'online') return colors.green('●');
    if (status === 'away') return colors.yellow('●');
    return colors.gray('○');
  },

  actBadge(act: Act): string {
    const label = `[${act}]`;
    if (act === 'request_help') return colors.bold(colors.yellow(label));
    if (act === 'decline') return colors.red(label);
    if (act === 'resolve') return colors.bold(colors.green(label)); // terminal/done — reads as completion
    return colors.dim(colors.white(label));
  },
};

/** A short HH:MM timestamp in the meta color. */
export function clock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Midnight (local) of the day `d` falls in, as ms — the unit day-distance is measured in. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * A human day label for grouping the inbox by calendar day (local time): `Today` / `Yesterday` /
 * `Monday · Jul 7` within the last week / `Jul 1` earlier this year / `7/1/26` in a prior year. Fixed
 * month/weekday names (not `toLocaleDateString`) keep the output deterministic across locale + CI TZ.
 * `now` is injectable so callers and tests aren't at the mercy of the wall clock.
 */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const diffDays = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7)
    return `${WEEKDAYS[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() === new Date(now).getFullYear())
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}
