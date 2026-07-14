import type {
  AccountStatus,
  Capabilities,
  Envelope,
  MemberSummary,
  Posture,
} from '@musterd/protocol';
import { resolvePosture } from '@musterd/protocol';

export type ActTone =
  | 'accent'
  | 'success'
  | 'danger'
  | 'info'
  | 'handoff'
  | 'lane'
  | 'status'
  | 'steer'
  | 'challenge'
  | 'neutral';

/** Map an act to its colour role — mirrors brand.md / the act-badge variants (ADR 061 view). */
export function actTone(act: string): ActTone {
  switch (act) {
    case 'request_help':
      return 'accent';
    case 'accept':
    case 'resolve':
    case 'lane_resolve':
      return 'success';
    case 'decline':
      return 'danger';
    case 'wait':
      return 'info';
    // Lane transitions in flight (ADR 102) share a distinct lane accent so they read as one "work
    // moving" family, above status chatter. Resolve keeps success (done is green); handoff keeps its
    // violet — same family, so the cluster still reads together.
    case 'lane_open':
    case 'lane_claim':
    case 'lane_state':
    // A Goal declaration (ADR 084) is the umbrella the lanes hang under — same plan-spine family, so it
    // rides the lane tone and the cluster reads together.
    case 'goal':
      return 'lane';
    case 'handoff':
    case 'lane_handoff':
      return 'handoff';
    case 'status_update':
      return 'status';
    // Steering trio (ADR 103). `steer` is interrupt-class → its own prominent tone; `challenge` is the
    // epistemic "justify?" → a distinct questioning tone; `defer` mutates a Goal on the plan, so it
    // rides the lane (work-moving) family alongside the lane transitions above.
    case 'steer':
      return 'steer';
    case 'challenge':
      return 'challenge';
    case 'defer':
      return 'lane';
    default:
      return 'neutral';
  }
}

/**
 * A short, human label per act — what reads in the badge. Distinct from the raw act token so the
 * stream stays legible (`status_update` → `status`, `request_help` → `help`) without losing meaning.
 */
export function actLabel(act: string): string {
  switch (act) {
    case 'status_update':
      return 'status';
    case 'request_help':
      return 'help';
    case 'lane_open':
      return 'lane open';
    case 'lane_claim':
      return 'lane claim';
    case 'lane_state':
      return 'lane state';
    case 'lane_resolve':
      return 'lane done';
    case 'lane_handoff':
      return 'lane handoff';
    case 'goal':
      return 'goal';
    // The ADR 103 steering acts (`steer`, `challenge`, `defer`) are already single clean words, so they
    // read verbatim through the default — no relabel needed (unlike the underscored lane_* sub-types).
    default:
      return act;
  }
}

/**
 * A lane lifecycle event (open/resolve/handoff) rides as an ordinary `message` envelope with
 * structured meta (ADR 083 §4: no new act token, no SPEC bump) — this recovers the intended
 * sub-type from `meta` so the stream badge, glyph, and office choreography can key on it distinctly
 * from a plain message instead of all three collapsing into a generic "message".
 */
export type LaneEventKind =
  | 'lane_open'
  | 'lane_claim'
  | 'lane_state'
  | 'lane_resolve'
  | 'lane_handoff';
export function laneEvent(env: Pick<Envelope, 'act' | 'meta'>): LaneEventKind | null {
  if (env.act !== 'message' || !env.meta) return null;
  if (env.meta['lane_open']) return 'lane_open';
  if (env.meta['lane_claim']) return 'lane_claim';
  if (env.meta['lane_state']) return 'lane_state';
  if (env.meta['lane_resolve']) return 'lane_resolve';
  if (env.meta['lane_handoff']) return 'lane_handoff';
  return null;
}

/**
 * A Goal declaration (ADR 084) also rides as a plain `message` + `meta.goal` — recover it the same way
 * a lane event is recovered, so the stream badges it `goal` (not `message`) and renders the Goal title
 * as a work item rather than dumping the composed `[goal] declared "…"` body.
 */
export function goalEvent(env: Pick<Envelope, 'act' | 'meta' | 'body'>): { title: string; wave?: string } | null {
  if (env.act !== 'message' || !env.meta) return null;
  const g = env.meta['goal'];
  if (!g || typeof g !== 'object') return null;
  const rec = g as Record<string, unknown>;
  const title = typeof rec['title'] === 'string' ? rec['title'] : titleFromBody(env.body);
  if (!title) return null;
  return typeof rec['wave'] === 'string' ? { title, wave: rec['wave'] } : { title };
}

/**
 * The human parts of a lane event, pulled from its structured meta (ADR 083 §4) — the title plus
 * whichever of state/branch/project applies. This is what the stream renders as a rich work-item line
 * so the row never repeats the badge's verb (`[lane] claimed …`) or exposes the raw lane ULID.
 * `lane_handoff` carries only `{lane, branch}` in meta, so its title falls back to the quoted body.
 */
export interface LaneEventDetail {
  title: string | null;
  state?: string;
  branch?: string;
  project?: string;
}
export function laneEventDetail(env: Pick<Envelope, 'meta' | 'body'>): LaneEventDetail | null {
  const meta = env.meta;
  if (!meta) return null;
  const bag =
    meta['lane_open'] ??
    meta['lane_claim'] ??
    meta['lane_state'] ??
    meta['lane_resolve'] ??
    meta['lane_handoff'];
  if (!bag || typeof bag !== 'object') return null;
  const b = bag as Record<string, unknown>;
  const out: LaneEventDetail = {
    title: typeof b['title'] === 'string' ? b['title'] : titleFromBody(env.body),
  };
  if (typeof b['state'] === 'string') out.state = b['state'];
  if (typeof b['branch'] === 'string') out.branch = b['branch'];
  // `default` is the unnamed project — not worth a pill.
  if (typeof b['project'] === 'string' && b['project'] !== 'default') out.project = b['project'];
  return out;
}

/** The first `"quoted"` span of a composed body — the title fallback when meta doesn't carry one. */
function titleFromBody(body: string): string | null {
  const m = body.match(/"([^"]+)"/);
  return m ? m[1]! : null;
}

/* ─── rich body text ──────────────────────────────────────────────────────────────────────────────
 * Free-text bodies (status updates, messages, handoff notes) are prose an agent wrote — often carrying
 * `**emphasis**`, `code`/paths, PR/issue refs (`#210`), commit SHAs, and the occasional raw ULID. The
 * stream renders them richly rather than as a flat dump: tokenize once here (pure, testable), style in
 * the view. Long unique ids (ULIDs) are collapsed to a `01KX6Q…SF6R` monospace token so a 26-char
 * identifier never blows out a line while the full value stays available on hover. */

export type RichToken =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ref'; text: string }
  /** A collapsed long id: `text` is the short display form, `title` the full value (for hover). */
  | { kind: 'id'; text: string; title: string };

// One scan, alternation in priority order: `code` · **strong** · ULID · #ref · hex SHA. Boundaries keep
// `#210` from matching inside a word/url and keep a 7–40-char lowercase hex run (a commit) distinct from
// an uppercase 26-char Crockford ULID.
const RICH_RE =
  /`([^`]+)`|\*\*([^*\n]+)\*\*|\b[0-9A-HJKMNP-TV-Z]{26}\b|(?<![\w/#])#\d{1,6}\b|(?<![\w])[0-9a-f]{7,40}(?![\w])/g;
const LEADING_TAG = /^\[(?:lane|goal)\]\s+/;

export function richTokens(input: string): RichToken[] {
  const text = input.replace(LEADING_TAG, '');
  const out: RichToken[] = [];
  let last = 0;
  const push = (t: string) => {
    if (t) out.push({ kind: 'text', text: t });
  };
  RICH_RE.lastIndex = 0;
  for (let m = RICH_RE.exec(text); m; m = RICH_RE.exec(text)) {
    push(text.slice(last, m.index));
    const raw = m[0];
    if (m[1] != null) out.push({ kind: 'code', text: m[1] });
    else if (m[2] != null) out.push({ kind: 'strong', text: m[2] });
    else if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw))
      out.push({ kind: 'id', text: `${raw.slice(0, 6)}…${raw.slice(-4)}`, title: raw });
    else if (raw[0] === '#') out.push({ kind: 'ref', text: raw });
    else out.push({ kind: 'code', text: raw });
    last = m.index + raw.length;
  }
  push(text.slice(last));
  return out;
}

/** Total visible length of a token stream — what a character-by-character reveal counts against. */
export function richLength(tokens: RichToken[]): number {
  return tokens.reduce((n, t) => n + t.text.length, 0);
}

/**
 * Break a prose body into scannable **clauses** so a long status update reads as a short stack of lines
 * (with the first as a lead) instead of one wall of text. Split points are natural reading pauses —
 * sentence ends (`. `/`! `/`? ` before a capital/digit/quote), semicolons, and spaced em-dashes — so
 * the segmentation follows how the sentence already breathes. Short bodies (< ~140 chars) are left
 * whole: a one-liner shouldn't be chopped up. Each segment is tokenized for rich inline rendering, and
 * the caller renders segment 0 as the lead. Purely presentational — the text is unchanged, just re-laid.
 */
const CLAUSE_MIN_LEN = 140;
export function proseSegments(input: string): RichToken[][] {
  const text = input.replace(LEADING_TAG, '').trim();
  if (text.length < CLAUSE_MIN_LEN) return [richTokens(text)];
  // Scan for reading-pause boundaries and cut there. A sentence terminator (.!?) stays with the
  // clause it ends; a semicolon or spaced em-dash is dropped (the line break stands in for it).
  const boundary = /([.!?])\s+(?=["\x27([]?[A-Z0-9])|;\s+|\s+—\s+/g;
  const pieces: string[] = [];
  let last = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const end = m.index + (m[1] ? 1 : 0);
    const piece = text.slice(last, end).trim();
    if (piece) pieces.push(piece);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) pieces.push(tail);
  return (pieces.length > 1 ? pieces : [text]).map((p) => richTokens(p));
}

/** Where a message went, distilled to the three audiences a reader cares about (ADR 061 firehose). */
export type ActScope = 'direct' | 'team' | 'all';
export function recipientScope(to: Envelope['to']): ActScope {
  if (to.kind === 'member') return 'direct';
  if (to.kind === 'team') return 'team';
  return 'all';
}
/** The named recipient of a direct (1:1) message; null for team/broadcast. */
export function recipientName(to: Envelope['to']): string | null {
  return to.kind === 'member' ? to.name : null;
}

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** 12-hour clock (e.g. `9:48 PM`) in the viewer's locale, from a ms-epoch ts. */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Local day bucket (ms at local midnight) — for grouping the stream into days. */
export function dayKey(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A day divider label: `Today`, `Yesterday`, or a dated weekday (`Mon, Jun 26`). */
export function dayLabel(ts: number): string {
  const diff = Math.round((dayKey(Date.now()) - dayKey(ts)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export type Kind = 'agent' | 'human';

/** Index the roster by name for O(1) kind/role lookups while rendering. */
export function rosterIndex(roster: MemberSummary[]): Map<string, MemberSummary> {
  return new Map(roster.map((m) => [m.name, m]));
}

export function kindOf(name: string, idx: Map<string, MemberSummary>): Kind {
  return idx.get(name)?.kind === 'human' ? 'human' : 'agent';
}

/**
 * A deterministic, per-member colour so every agent (and human) is individually distinguishable —
 * stable across sessions (hashed from the name, not assigned by index). Agents sit in a cool jewel
 * band, humans in a warm band, so kind still reads at a glance while individuals stay unique. The
 * golden-ratio hash spreads similar names apart. Returns an `hsl()` string usable in CSS and three.js.
 */
export function memberColor(name: string, kind: Kind): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const t = (h * 0.618033988749895) % 1;
  // agents: 150°→280° (green · teal · cyan · blue · indigo); humans: 320°→70° (magenta · rose · coral · amber)
  const hue = kind === 'human' ? Math.round((320 + t * 110) % 360) : Math.round(150 + t * 130);
  return `hsl(${hue}, 68%, 62%)`;
}

/* ─── roster posture + governance projection (ADR 138 / 073 / 070) ────────────────────────────────
 * Primary chip = server-projected `posture` (working|idle|away|offline). Account-status chips are
 * exceptions only (disabled/banned/archived). Capability badges still show deviations from the
 * generalist default. Nothing is enforced here — this is the observable surface. */

/** How a posture reads in the rail. */
export function postureMeta(posture: Posture): StatusMeta {
  switch (posture) {
    case 'working':
      return { label: 'working', tone: 'ok', quiet: false };
    case 'idle':
      return { label: 'idle', tone: 'ok', quiet: true };
    case 'away':
      return { label: 'away', tone: 'pending', quiet: false };
    case 'offline':
      return { label: 'offline', tone: 'muted', quiet: true };
    default: {
      const _exhaustive: never = posture;
      return _exhaustive;
    }
  }
}

/** Resolve the chip posture from a summary — prefer the server field; fall back for pre-138 daemons. */
export function memberPosture(m: MemberSummary): Posture {
  if (m.posture) return m.posture;
  const activity = m.activity ?? (m.presence === 'offline' ? 'offline' : 'online');
  return resolvePosture({
    activity,
    availability: m.availability ?? null,
  });
}

/** How an account_status reads: wire token + tone. Healthy norms are quiet (and usually hidden). */
export interface StatusMeta {
  label: string;
  tone: 'ok' | 'pending' | 'danger' | 'muted';
  /** Healthy / unknown norms are quiet; exceptions take a tone. */
  quiet: boolean;
}
export function accountStatusMeta(status: AccountStatus | undefined): StatusMeta {
  switch (status) {
    case 'active':
      return { label: 'active', tone: 'ok', quiet: true };
    case 'provisioned':
      return { label: 'provisioned', tone: 'pending', quiet: true };
    case 'disabled':
      return { label: 'disabled', tone: 'muted', quiet: false };
    case 'banned':
      return { label: 'banned', tone: 'danger', quiet: false };
    case 'archived':
      return { label: 'archived', tone: 'muted', quiet: false };
    default:
      return { label: 'unknown', tone: 'muted', quiet: true };
  }
}

/**
 * Account-status chip for the roster rail (ADR 138) — only governance exceptions. Healthy
 * `active`/`provisioned` are omitted; posture owns the primary chip.
 */
export function accountStatusException(status: AccountStatus | undefined): StatusMeta | null {
  switch (status) {
    case 'disabled':
    case 'banned':
    case 'archived':
      return accountStatusMeta(status);
    case 'active':
    case 'provisioned':
    case undefined:
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export type BadgeTone = 'admin' | 'restrict' | 'muted';
export interface CapBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  /** The long-form tooltip explaining the capability behind the badge. */
  title: string;
}

/**
 * The capability badges worth showing for a seat — only **deviations from the generalist default**
 * (everyone-can-do-everything) plus the positive `admin` marker. A fully-generalist seat shows no
 * badges, so the rail stays calm today and lights up exactly as governance is configured. Mirrors the
 * Universe-1 fields the protocol enforces (ADR 070); Universe-2 (tool/resource scopes) is declared-only
 * and intentionally not surfaced as a badge.
 */
export function capabilityBadges(caps: Capabilities | undefined): CapBadge[] {
  if (!caps) return [];
  const out: CapBadge[] = [];
  if (caps.is_admin)
    out.push({ key: 'admin', label: 'admin', tone: 'admin', title: 'Team admin — full governance authority' });
  if (caps.visibility_level === 'admin')
    out.push({
      key: 'view',
      label: 'admin view',
      tone: 'admin',
      title: 'Sees everything: credentials, grants, audit, and all charters',
    });
  if (caps.can_message === 'none')
    out.push({ key: 'muted', label: 'muted', tone: 'muted', title: 'May not send messages to the team' });
  if (!caps.can_flag_urgent)
    out.push({
      key: 'urgent',
      label: 'no urgent',
      tone: 'restrict',
      title: 'May not flag messages as urgent',
    });
  if (!caps.can_observe)
    out.push({
      key: 'observe',
      label: 'no observe',
      tone: 'restrict',
      title: 'May not observe the team firehose',
    });
  return out;
}

/**
 * Pretty-print an audit `action` (ADR 071). Known v0.3 actions get a short human label + a tone;
 * unknown actions (P3 adds `grant.*`, `claim.*`, …) fall back to the raw token so the view never
 * hides a record it doesn't recognise. The dot-namespace (`urgent.denied`) reads fine verbatim.
 */
export function auditActionMeta(action: string): { label: string; tone: ActTone } {
  switch (action) {
    case 'urgent.flagged':
      return { label: 'urgent flagged', tone: 'status' };
    case 'urgent.denied':
      return { label: 'urgent denied', tone: 'danger' };
    case 'send.denied':
      return { label: 'send denied', tone: 'danger' };
    case 'observe.denied':
      return { label: 'observe denied', tone: 'danger' };
    case 'member.reclaim':
      return { label: 'seat reclaimed', tone: 'handoff' };
    case 'member.remove':
      return { label: 'member removed', tone: 'handoff' };
    default:
      return { label: action, tone: 'neutral' };
  }
}

/** Compact one-line render of an audit entry's free-form `detail` object (`k: v · k: v`). */
export function formatAuditDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  return Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

/** A precise audit timestamp — date + 24h time to the second (records can cluster within a second). */
export function auditTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Wall time split into its animated parts: `time` ("9:27:11" — no leading zero on the hour), the
 * `meridiem` ("AM"), and the viewer's `zone` ("PST"). Split rather than one string because the clock
 * animates the digits per-glyph and holds the zone steady beside them.
 */
export function formatClock(d: Date): { time: string; meridiem: string; zone: string } {
  const parts = new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(d);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    time: `${pick('hour')}:${pick('minute')}:${pick('second')}`,
    meridiem: pick('dayPeriod').toUpperCase(),
    zone: pick('timeZoneName'),
  };
}

/** Roster sort for the rail: online before offline, then humans before agents, then by name. */
export function rosterOrder(a: MemberSummary, b: MemberSummary): number {
  const onA = a.presence !== 'offline' ? 0 : 1;
  const onB = b.presence !== 'offline' ? 0 : 1;
  if (onA !== onB) return onA - onB;
  const kA = a.kind === 'human' ? 0 : 1;
  const kB = b.kind === 'human' ? 0 : 1;
  if (kA !== kB) return kA - kB;
  return a.name.localeCompare(b.name);
}
