import type {
  Activity,
  Envelope,
  MemberKind,
  MemberSummary,
  PresenceStatus,
} from '@musterd/protocol';
import { clock, dayLabel, theme } from './theme.js';
import { padEndVisible, termWidth, visibleLen, wrapText } from './ui.js';

export type KindOf = (name: string) => MemberKind;

/** A status older than this is shown with its age (`working: x · Nm`) to signal it may be stale. */
const STALE_AFTER_MS = 5 * 60_000;

/** Pad a colorized string to an exact visible width (no trailing slack — for box alignment). */
function padExact(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLen(s)));
}

/** Wrap lines in a rounded nameplate; dim borders, padded to the widest visible line. */
function nameplate(lines: string[], pad = 2): string {
  const inner = Math.max(...lines.map(visibleLen));
  const w = inner + pad * 2;
  const bar = theme.meta('│');
  const gap = ' '.repeat(pad);
  const top = theme.meta('╭' + '─'.repeat(w) + '╮');
  const bot = theme.meta('╰' + '─'.repeat(w) + '╯');
  const body = lines.map((l) => `${bar}${gap}${padExact(l, inner)}${gap}${bar}`);
  return [top, ...body, bot].join('\n');
}

/**
 * The wordmark banner (brand.md §1, ADR 114). A rounded nameplate — no letter-art — holding the
 * roll-call dots (online · away · offline, the CLI's own presence glyphs), the `musterd` brand chip
 * (the word reversed out of a solid mustard block) with a trailing terminal cursor (the web-hero nod),
 * and the tagline. `muster` = take the roll; the dots show the product itself, a team present. The frame
 * matches the web's rounded-corner language. 16-color-safe; degrades cleanly with color off.
 */
export function renderBanner(): string {
  const dots = `${theme.presenceDot('online')} ${theme.presenceDot('away')} ${theme.presenceDot('offline')}`;
  const chip = theme.brandmark(' musterd ');
  const cursor = theme.accent('▊');
  const tagline = theme.meta('muster your agents and humans into persistent teams');
  return nameplate([`${dots}   ${chip} ${cursor}`, tagline]);
}

/** A recipient label for a message row: `→ Lin`, `→ @team`, `→ @broadcast`. */
function toLabel(to: Envelope['to'], kindOf: KindOf): string {
  if (to.kind === 'team') return theme.meta('→ @team');
  if (to.kind === 'broadcast') return theme.meta('→ @broadcast');
  return theme.meta('→ ') + theme.memberName(to.name, kindOf(to.name));
}

/** One message row: `HH:MM name [act] → to  body` with hanging-indent wrap at 80 cols. */
/**
 * The inbox body, grouped by calendar day (ADR: elite inbox). Messages come in ascending order and
 * newest lands at the bottom (where the terminal cursor rests). Each day is announced once by a
 * {@link theme.dayHeader} — `Today` / `Yesterday` / `Monday · Jul 7` — so a date is stated per day
 * instead of never; rows keep a clean `HH:MM`. `cursorTs` drives the per-row unread marker.
 */
export function renderInbox(
  messages: Envelope[],
  kindOf: KindOf,
  opts: { cursorTs: number; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const out: string[] = [];
  let lastDay: string | null = null;
  for (const m of messages) {
    const day = dayLabel(m.ts, now);
    if (day !== lastDay) {
      // A blank line separates groups; the first header needs none.
      out.push((lastDay === null ? '' : '\n') + theme.dayHeader(day));
      lastDay = day;
    }
    out.push(renderMessageRow(m, kindOf, { unread: m.ts > opts.cursorTs }));
  }
  return out.join('\n');
}

export function renderMessageRow(
  env: Envelope,
  kindOf: KindOf,
  opts: { unread?: boolean } = {},
): string {
  const marker = opts.unread ? theme.accent('▌') + ' ' : '  ';
  const head = `${theme.meta(clock(env.ts))} ${theme.memberName(env.from, kindOf(env.from))} ${theme.actBadge(env.act)} ${toLabel(env.to, kindOf)}`;
  const indent = '    ';
  const body = wrapText(env.body, termWidth() - indent.length)
    .map((line) => `${indent}${line}`)
    .join('\n');
  return env.body ? `${marker}${head}\n${body}` : `${marker}${head}`;
}

/**
 * The `status` header: which team, which daemon, and — critically — which database that daemon
 * serves. A daemon silently serving the wrong db reads as "everyone offline", so surfacing the db
 * path makes that diagnosable at a glance (dogfood finding). `db`/`schema` are omitted pre-0.2.
 */
export function renderStatusHeader(
  team: string,
  server: string,
  health?: { db?: string; schema?: number },
): string {
  const parts = [theme.accent(team), theme.meta(server)];
  if (health?.db) {
    const schema = health.schema != null ? ` (schema ${health.schema})` : '';
    parts.push(theme.meta(`db: ${health.db}${schema}`));
  }
  return parts.join(theme.meta('  ·  '));
}

/**
 * The roster table for `status`: MEMBER KIND ROLE LIFECYCLE ACTIVITY.
 * ACTIVITY is last because its `working: …` label is unbounded — a free-flowing final
 * column never collides with the columns after it.
 */
export function renderStatusTable(members: MemberSummary[], now = Date.now()): string {
  const header = theme.meta(
    pad('MEMBER', 14) + pad('KIND', 8) + pad('ROLE', 14) + pad('LIFECYCLE', 18) + 'ACTIVITY',
  );
  const rows = members.map((m) => {
    const name = theme.memberName(m.name, m.kind);
    // Availability (SPEC A.6 Axis 2) outranks the activity-derived label in the display resolution
    // (away → `off until <ts>`); when unset/available it falls through to the live activity (ADR 044).
    const avail = availabilityLabel(m);
    const label = avail ?? activityLabel(m, now);
    const dot = avail ? 'away' : activityOf(m) === 'offline' ? 'offline' : 'online';
    const activity = `${theme.presenceDot(dot)} ${theme.meta(label)}`;
    const lifecycle =
      m.lifecycle === 'until' && m.lifecycle_until
        ? `until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`
        : m.lifecycle;
    return (
      padEndVisible(name, 14) +
      pad(m.kind, 8) +
      pad(m.role || '—', 14) +
      pad(lifecycle, 18) +
      activity
    );
  });
  return [header, ...rows].join('\n');
}

/**
 * The explicit availability label, or null to fall through to the live activity. `away` renders
 * `off until <ts>` (or bare `away` with no `away_until`), `dnd` renders `dnd`; `available` is the
 * implicit default and never overrides the activity column (SPEC A.6 display resolution; ADR 044).
 */
function availabilityLabel(m: MemberSummary): string | null {
  const a = m.availability;
  if (!a || a.status === 'available') return null;
  if (a.status === 'dnd') return 'dnd';
  return a.until ? `off until ${shortTs(a.until)}` : 'away';
}

/** Compact `YYYY-MM-DD HH:MM` for an away_until timestamp. */
function shortTs(ms: number): string {
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/** Activity, falling back to a presence-derived value for older rosters that predate the field. */
function activityOf(m: MemberSummary): Activity {
  return m.activity ?? (m.presence === 'offline' ? 'offline' : 'online');
}

/**
 * The text after the dot. Examples:
 *   `offline`
 *   `online via claude-code (session) · driven by nick · movetrail@feat/login`
 *   `working: refactoring auth · 18m (session) · driven by nick · movetrail@feat/login`
 * Provenance (`why`), driver (`who`), and workspace (`where`) are attach-time context (ADR 014 +
 * ADR 021), read from the live presence and shown dim alongside the activity. `driven by …` makes
 * the roster tell the truth when a human is steering the agent's session, instead of showing that
 * human offline — location/co-presence context, not an authoritative scope.
 */
function activityLabel(m: MemberSummary, now: number): string {
  const activity = activityOf(m);
  if (activity === 'offline') return 'offline';
  const p = m.presences[0];
  let core: string;
  if (activity === 'working' && m.state) {
    const stale = m.last_status_at != null && now - m.last_status_at >= STALE_AFTER_MS;
    const age = stale && m.last_status_at != null ? ` · ${ageLabel(m.last_status_at, now)}` : '';
    core = `working: ${clipStatus(m.state)}${age}`;
  } else {
    core = p?.surface ? `online via ${p.surface}` : 'online';
  }
  const why = p?.provenance ? ` (${p.provenance})` : '';
  const who = p?.driver ? ` · driven by ${p.driver}` : '';
  const where = p?.workspace ? ` · ${p.workspace}` : '';
  return `${core}${why}${who}${where}`;
}

/**
 * Clip a self-reported status to one tidy roster line: collapse whitespace and cap length. The full
 * text is preserved in `status --json`; agents sometimes post a paragraph (keep the table readable).
 */
const STATUS_MAX = 72;
function clipStatus(state: string): string {
  const oneLine = state.replace(/\s+/g, ' ').trim();
  return oneLine.length > STATUS_MAX ? oneLine.slice(0, STATUS_MAX - 1) + '…' : oneLine;
}

/** Coarse human age: `18m` / `2h` / `3d`. */
function ageLabel(since: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - since) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Does this delivered act need the human's attention now? `request_help` (a call for help anyone on
 * the team can answer) or anything addressed specifically to me (`handoff`/`message`/`wait` → me,
 * and the ADR 103 steering acts `steer`/`challenge`/`defer` → me).
 * `resolve` is terminal — a thread-close is good news, never an action — so it never flags, even
 * when addressed to me. Drives the watch-stream ⚑ salience per delivery and (via {@link openActionNeeded})
 * the comeback "N requests waiting" summary, so a real ask can't slip past buried in a stream of team
 * `status_update`s — the recipient-side half of the notification loop (ADR 024). Pure, so the live
 * and comeback paths classify identically.
 */
export function isActionNeeded(env: Envelope, me: string): boolean {
  if (env.act === 'resolve') return false;
  if (env.act === 'request_help') return true;
  return env.to.kind === 'member' && env.to.name === me;
}

/** The thread an envelope belongs to: its `thread` root id, or its own id if it is a root. */
function threadKey(env: Envelope): string {
  return env.thread ?? env.id;
}

/**
 * The still-open action-needed messages in a set: those {@link isActionNeeded} whose thread has no
 * `resolve` (ADR 025). This is the open-vs-done axis ADR 024's read-cursor deliberately doesn't
 * track — a resolved request stops counting as waiting even if it is still unread, because the work
 * it asked for is done. Pure; the comeback summary reads it off the inbox.
 */
export function openActionNeeded(messages: Envelope[], me: string): Envelope[] {
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
  }
  return messages.filter((m) => isActionNeeded(m, me) && !resolved.has(threadKey(m)));
}

/**
 * The comeback banner that leads `status`: `⚑ 2 requests waiting for you since 14:32 …`. Counted off
 * the durable inbox cursor (unread, action-needed messages). Returns '' when nothing waits, so a
 * caller can prepend it unconditionally without adding a blank line of noise on the common path.
 */
export function renderPendingSummary(count: number, sinceTs: number): string {
  if (count <= 0) return '';
  const noun = count === 1 ? 'request' : 'requests';
  return (
    theme.actionNeeded(`⚑ ${count} ${noun} waiting for you`) +
    theme.meta(` since ${clock(sinceTs)} — musterd inbox to read`)
  );
}

/**
 * The agent-side reachability nudge (ADR 046): the same open-action count as the comeback summary,
 * but addressed to a named member and appended to *any* acting command's stderr — so a heads-down
 * agent that never thinks to run `inbox` still sees a directed act waiting. Names the member (it is
 * surfaced away from `status`, where "you" has no anchor) and points at the fix. Returns '' when
 * nothing waits, so a caller can append it unconditionally. Pure — same predicate as the live path.
 */
export function renderReachabilityNudge(count: number, sinceTs: number, me: string): string {
  if (count <= 0) return '';
  const noun = count === 1 ? 'act' : 'acts';
  return (
    theme.actionNeeded(`⚑ ${count} ${noun} waiting for ${me}`) +
    theme.meta(` — musterd inbox  (since ${clock(sinceTs)})`)
  );
}

export function renderPresence(status: PresenceStatus, surface?: string): string {
  const dot = theme.presenceDot(status);
  const label = surface && status !== 'offline' ? `${status} via ${surface}` : status;
  return `${dot} ${theme.meta(label)}`;
}

// ---- helpers ----

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}
