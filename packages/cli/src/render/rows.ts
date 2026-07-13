import {
  MODEL_UNKNOWN,
  type Activity,
  type Envelope,
  type MemberKind,
  type MemberSummary,
  type PresenceStatus,
} from '@musterd/protocol';
import { clock, dayLabel, theme } from './theme.js';
import { heading, hint, padEndVisible, sym, termWidth, visibleLen, wrapText } from './ui.js';

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

export interface Health {
  db?: string;
  schema?: number;
  /** The daemon's build ref (ADR 130) — shown short, so a stale daemon is visible without digging. */
  build?: string;
}

export interface StatusHead {
  team: string;
  server: string;
  health?: Health | undefined;
  members: MemberSummary[];
  /** The seat *this folder* resolves to, if any — the question `status` never used to answer. */
  me?: { name: string; kind: MemberKind } | undefined;
  /** Rendered `⚑ N acts waiting for you` banner, or '' — outranks everything else on screen. */
  pending?: string | undefined;
  /** Rendered seat-memory continuity line, or '' (ADR 093). */
  memory?: string | undefined;
}

/**
 * The `status` header — an orientation card, read top-down in order of what you need first:
 *
 *   1. **the team** + a live dot (mustard, bold) — the anchor, and proof the daemon answered
 *   2. **who you are here** — with six seats across worktrees, "which seat is this folder?" is the
 *      question `status` is really asked, and the old header never answered it
 *   3. **what needs you** — the ⚑ banner (inverse mustard), outranking everything by design (ADR 024)
 *   4. **what you were doing** — the seat-memory continuity line (ADR 093)
 *   5. **the plumbing** — server / db / build, dimmest and home-compressed
 *
 * The plumbing stays because a daemon silently serving the wrong db reads as "everyone offline", and
 * that path is what makes it diagnosable (dogfood finding). It is demoted, never dropped: quiet until
 * you go looking for it.
 */
export function renderStatusHeader(head: StatusHead): string {
  const { team, server, health, members, me, pending, memory } = head;
  // A dot before the team: the daemon answered (green) or didn't (a red ○ — the roster below is stale).
  const alive = health ? theme.ok(sym.online) : theme.err(sym.offline);
  const lines = [
    `${alive} ${theme.accent(team)}` + (members.length ? theme.meta(`  ${rollCall(members)}`) : ''),
  ];

  if (me) {
    // Your own seat, in your own identity color — the one row on screen that is *you*.
    const mine = members.find((m) => m.name === me.name);
    const facets = mine ? meFacets(mine) : '';
    lines.push(
      theme.meta('you are ') +
        theme.bold(theme.memberName(me.name, me.kind)) +
        (facets ? theme.meta(`  ${facets}`) : ''),
    );
  } else {
    // Not seated here is not an error — but it *is* the reason your acts would fail. Say so, with the fix.
    lines.push(theme.meta('you hold no seat here') + '  ' + hint('musterd claim <name>'));
  }

  if (pending) lines.push(pending);
  if (memory) lines.push(memory);
  lines.push(theme.dim(plumbing(server, health)));
  return lines.join('\n');
}

/** The facets of *your* seat: model + where you're running — enough to catch a wrong-folder mistake. */
function meFacets(m: MemberSummary): string {
  const parts: string[] = [m.kind];
  const model = m.presences[0]?.model?.trim();
  if (model && model !== MODEL_UNKNOWN) parts.push(model);
  if (m.presences[0]?.workspace) parts.push(m.presences[0]!.workspace);
  return parts.join(` ${sym.dot} `);
}

/** `127.0.0.1:4849 · ~/.musterd/musterd.db · schema 16 · build bfe043c` — quiet, but there when needed. */
function plumbing(server: string, health?: Health): string {
  const parts = [server.replace(/^https?:\/\//, '')];
  if (health?.db) parts.push(tildeHome(health.db));
  if (health?.schema != null) parts.push(`schema ${health.schema}`);
  if (health?.build) parts.push(`build ${health.build.slice(0, 7)}`);
  return parts.join(` ${sym.dot} `);
}

/** Compress `$HOME` to `~` — the db path is long, and its *identity* is what matters, not its prefix. */
function tildeHome(p: string): string {
  const home = process.env['HOME'];
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** `6 members · 3 present · 2 working` — the roll call, stated once so the roster needs no counting. */
function rollCall(members: MemberSummary[]): string {
  const present = members.filter((m) => activityOf(m) !== 'offline').length;
  const working = members.filter((m) => groupOf(m) === 'working').length;
  const noun = members.length === 1 ? 'member' : 'members';
  const parts = [`${members.length} ${noun}`, `${present} present`];
  if (working) parts.push(`${working} working`);
  return parts.join(` ${sym.dot} `);
}

/** The roster groups, in reading order — the question `status` answers, top to bottom. */
type Group = 'working' | 'here' | 'away' | 'out';
const GROUPS: { key: Group; label: string }[] = [
  { key: 'working', label: 'working' },
  { key: 'here', label: 'here' },
  { key: 'away', label: 'away' },
  { key: 'out', label: 'out' },
];

/**
 * Which group a member sits in. Availability (SPEC A.6 Axis 2) outranks the activity-derived state in
 * the display resolution (ADR 044) — a member who declared themselves away is `away` even while
 * attached — and only a member actually reporting work lands in `working`.
 */
function groupOf(m: MemberSummary): Group {
  if (activityOf(m) === 'offline') return 'out';
  if (availabilityLabel(m)) return 'away';
  return activityOf(m) === 'working' && m.state ? 'working' : 'here';
}

/**
 * The roster for `status` — a grouped roll call, not a table.
 *
 * The old grid paid a fixed column width for `KIND`/`ROLE`/`MODEL`/`LIFECYCLE` — information that is
 * absent for most members most of the time (`—`, `unknown`, `forever`) — while clipping the one thing
 * you actually read, the self-reported status, at 72 chars. This inverts that: facets appear **only
 * when they carry information** (progressive disclosure), and the status text gets its own wrapped
 * line so it can be read instead of guessed at.
 *
 * Grouping answers the question the command is asked: who is working, who is here, who is out.
 */
export function renderRoster(
  members: MemberSummary[],
  now = Date.now(),
  width = termWidth(),
): string {
  if (members.length === 0) {
    return theme.meta("nobody's on the team yet") + '\n' + hint('musterd team add <name>');
  }
  // One name column across every group, so the eye tracks a single left edge down the whole roster.
  const nameCol = Math.max(...members.map((m) => visibleLen(m.name))) + 2;
  const out: string[] = [];
  for (const { key, label } of GROUPS) {
    const inGroup = members.filter((m) => groupOf(m) === key);
    if (inGroup.length === 0) continue; // an empty group is not a fact worth a heading
    out.push('', `${heading(label)}  ${theme.meta(String(inGroup.length))}`);
    const entries = inGroup.map((m) => renderMember(m, key, nameCol, now, width));
    // Multi-line entries (a working member, with their status) need air between them or they read as
    // one wall of text; a group of one-liners stays tight. Spacing follows the content, not the group.
    const multiline = entries.some((e) => e.includes('\n'));
    out.push(entries.join(multiline ? '\n\n' : '\n'));
  }
  return out.join('\n').trimStart();
}

/**
 * One member: a headline (dot · name · the facets that say something) and, for a working member, the
 * status they reported plus where they're doing it. A quiet member is exactly one line.
 */
function renderMember(
  m: MemberSummary,
  group: Group,
  nameCol: number,
  now: number,
  width: number,
): string {
  const dot = theme.presenceDot(group === 'out' ? 'offline' : group === 'away' ? 'away' : 'online');
  const head = `  ${dot} ${padEndVisible(theme.memberName(m.name, m.kind), nameCol)}`;
  const facets = memberFacets(m, group);
  const lines = [head + (facets ? theme.meta(facets) : '')];

  const indent = ' '.repeat(4);
  // The reported status — wrapped, not clipped. This is the payload of the command.
  if (group === 'working' && m.state) {
    const body = wrapText(oneLine(m.state), Math.max(24, width - indent.length));
    for (const line of body.slice(0, STATUS_MAX_LINES)) lines.push(indent + line);
    if (body.length > STATUS_MAX_LINES) lines[lines.length - 1] += theme.meta(` ${sym.more}`);
  }
  const context = memberContext(m, group, now);
  if (context) lines.push(indent + theme.meta(context));
  return lines.join('\n');
}

/** How many wrapped lines of a self-reported status to show before eliding (agents post paragraphs). */
const STATUS_MAX_LINES = 2;

/**
 * The identity facets, shown **only when they carry information**: kind always (it is the one thing
 * color alone encodes, and color may be off); role, attested model (ADR 101), and surface when set;
 * lifecycle only when it is not the `forever` default. An absent facet is silence, not a `—`.
 */
function memberFacets(m: MemberSummary, group: Group): string {
  const parts: string[] = [m.kind];
  if (m.role) parts.push(m.role);
  const model = m.presences[0]?.model?.trim();
  if (model && model !== MODEL_UNKNOWN) parts.push(model);
  if (group !== 'out' && m.presences[0]?.surface) parts.push(m.presences[0]!.surface);
  if (m.lifecycle === 'session') parts.push('session');
  if (m.lifecycle === 'until' && m.lifecycle_until) {
    parts.push(`until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`);
  }
  // A residency-enrolled seat (ADR 131) is offline but not unreachable — a directed act wakes it.
  if (group === 'out' && m.wakeable) parts.push('wakeable');
  if (group === 'away') parts.push(availabilityLabel(m) ?? 'away');
  return parts.join(` ${sym.dot} `);
}

/**
 * The dim second line: where the work is happening and how fresh it is. Provenance (`why`), driver
 * (`who`), and workspace (`where`) are attach-time context (ADR 014 + ADR 021) — `driven by …` makes
 * the roster tell the truth when a human is steering an agent's session. Age appears only once the
 * status is stale enough to doubt.
 */
function memberContext(m: MemberSummary, group: Group, now: number): string {
  if (group === 'out') return '';
  const p = m.presences[0];
  const parts: string[] = [];
  if (p?.workspace) parts.push(p.workspace);
  // Provenance is shown only when it is *not* the `session` default: "a human opened a session" is the
  // boring case and printing it on every row is what made the old table read as a dump. A seat that is
  // up because a directed act woke it (`wake`, ADR 131) is genuinely worth saying — and now it stands out.
  if (p?.provenance && p.provenance !== 'session') parts.push(p.provenance);
  if (p?.driver) parts.push(`driven by ${p.driver}`);
  const stale = m.last_status_at != null && now - m.last_status_at >= STALE_AFTER_MS;
  if (group === 'working' && stale && m.last_status_at != null) {
    parts.push(ageLabel(m.last_status_at, now));
  }
  return parts.join(` ${sym.dot} `);
}

/** Collapse a self-reported status to a single flowing line before wrapping. */
function oneLine(state: string): string {
  return state.replace(/\s+/g, ' ').trim();
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
