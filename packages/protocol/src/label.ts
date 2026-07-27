/**
 * Seat session labels (ADR 160) — the shared grammar for marking a harness session as belonging
 * to a musterd seat, wherever a title can be written (an app sidebar, a terminal tab).
 *
 * Pure string functions only: this file is exported from the browser-safe barrel, so it must never
 * import node builtins (see build-stamp.ts for the incident that rule comes from).
 */

/**
 * The musterd chip as a title prefix. ADR 154 makes the brand mark a flat rounded mustard block
 * (`#E1AD01`); a warm diamond is the closest a plain-text title can get, and titles are plain text
 * everywhere we write them — app sidebars render no images, and a terminal tab is characters only.
 */
export const SEAT_CHIP = '\u{1F536}'; // 🔶 large orange diamond

/** Six days in milliseconds — the boundary between weekday-style and date-style timestamps. */
const WEEKDAY_WINDOW_MS = 6 * 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A session's start moment, compact enough for a sidebar row: `Fri 3p` while the weekday is still
 * unambiguous (within six days of `nowMs`), `Jul 18 3p` beyond that. Minutes are deliberately
 * dropped — the label answers "which of these sessions is which", not "when exactly".
 *
 * Local time by design: the label is read on the machine that wrote it.
 */
export function formatLabelWhen(createdMs: number, nowMs: number): string {
  const d = new Date(createdMs);
  const hour12 = d.getHours() % 12 || 12;
  const clock = `${hour12}${d.getHours() < 12 ? 'a' : 'p'}`;
  if (nowMs - createdMs < WEEKDAY_WINDOW_MS) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock}`;
}

/** Seat names live lowercase in bindings ("miley"); titles carry them capitalized ("Miley"). */
export function capitalizeSeat(seat: string): string {
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}

/**
 * The sidebar label: `🔶 Miley (Fri 3p) - Daemon refresh`. Write-once per session — the timestamp
 * is the session's start, fixed at creation, so a labeled title never needs re-dating.
 */
export function renderSeatLabel(
  seat: string,
  createdMs: number,
  subject: string,
  nowMs: number,
): string {
  const stem = `${SEAT_CHIP} ${capitalizeSeat(seat)} (${formatLabelWhen(createdMs, nowMs)})`;
  // A title that was nothing but the seat name leaves no subject to carry; a dangling " - " reads
  // as a truncated title, so drop the separator rather than render one.
  return subject.trim() ? `${stem} - ${subject}` : stem;
}

/**
 * The terminal-tab title: `🔶 stanley · agents-stanley`. No timestamp — a tab is live, not a
 * history row, and it is re-asserted on every CLI command rather than written once. The seat stays
 * lowercase here to match the CLI's own voice (prompts, roster) rather than the sidebar's.
 */
export function renderTerminalTitle(seat: string, subject?: string): string {
  return subject ? `${SEAT_CHIP} ${seat} · ${subject}` : `${SEAT_CHIP} ${seat}`;
}

export interface SeatLabelParse {
  /** Title starts with the chip. */
  chipped: boolean;
  /** Title (after any chip) opens with the seat's name — some sweep, or a human, has seated it. */
  seated: boolean;
  /**
   * A `seated` title that also carries a parenthesized stamp right after the seat
   * (`Miley (Fri 3p) - …`). Distinguishes a pre-chip *sweep* label, which must keep its original
   * timestamp, from a human's bare `Miley - …`, which has no timestamp to preserve and wants one.
   * False whenever `seated` is false.
   */
  dated: boolean;
  /** The title with any leading chip stripped — what a chip-prepending upgrade should keep. */
  bare: string;
  /**
   * For a `seated` title, the part after the seat (and any stamp and separator) — the human's own
   * words, which a re-label must carry through verbatim. Equals `bare` when not seated.
   */
  subject: string;
}

/** Escape a seat name for use inside a RegExp — seats are free-form strings from a binding. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The idempotency predicate for sweeps, distinguishing the states a title can be in:
 * fully labeled (`chipped && seated` — skip), labeled by a pre-chip sweep (`seated && dated` —
 * prepend the chip to `bare`, preserving the original timestamp rather than re-dating it), seated
 * by hand with no stamp (`seated && !dated` — re-render around `subject` so the row gains chip and
 * time while keeping the human's words), or untouched (label from scratch). Seat match is
 * case-insensitive because bindings are lowercase and labels are capitalized.
 *
 * `seated` requires a **boundary** after the seat name — end of string, whitespace, or a separator
 * — so seat `miley` does not claim the title "Mileystone planning". That precision matters beyond
 * tidiness: `seated` is what lets a sweep touch a human-typed title at all (ADR 160, narrowed), so
 * a loose match here would license overwriting words the sweep has no business touching.
 */
export function parseSeatLabel(title: string, seat: string): SeatLabelParse {
  const chipped = title.startsWith(SEAT_CHIP);
  const bare = chipped ? title.slice(SEAT_CHIP.length).replace(/^\s+/, '') : title;
  // seat, boundary, optional "(stamp)", optional "-"/"·"/":" separator, then the human's subject.
  const m = new RegExp(
    `^${escapeRe(seat)}(?=$|[\\s\\-–—(·:])\\s*(?:\\(([^)]*)\\)\\s*)?(?:[-–—·:]\\s*)?(.*)$`,
    'i',
  ).exec(bare);
  if (!m) return { chipped, seated: false, dated: false, bare, subject: bare };
  return {
    chipped,
    seated: true,
    dated: m[1] !== undefined,
    bare,
    subject: (m[2] ?? '').trim(),
  };
}
