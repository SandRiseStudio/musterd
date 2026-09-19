import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_UNKNOWN,
  DriftCacheSchema,
  type DriftCache,
  type Envelope,
  type MemberSummary,
  describeSyncWedge,
  type SyncWedge,
} from '@musterd/protocol';

/**
 * The roster, rendered for an **agent** to read (`team_status` / `team_members`).
 *
 * Deliberately *not* the CLI's renderer. The CLI's job is visual scanning by a human — color, glyphs,
 * aligned columns. This one feeds a model: ANSI is noise, box-drawing is wasted tokens. What carries
 * over is the substance, not the styling:
 *
 *   - **what each teammate is working on** (`state`) — the single most useful fact on a coordination
 *     roster, and the one the old tools left out entirely. An agent could see *that* a teammate was
 *     online but never *what they were doing*, which is the whole premise of the product.
 *   - the attested model (ADR 101) and workspace — who is on what, and where.
 *   - **silence for absent facets**: no `role=—`, no `lifecycle=forever`. An empty field is not a fact,
 *     and every one of them costs the reader tokens and attention.
 *
 * Grouped by working / here / out so the reader's attention lands on the active team first.
 */
export function formatRoster(members: MemberSummary[], me?: string): string {
  if (members.length === 0) return 'no members yet — team_join claims your seat';
  const groups: Record<string, MemberSummary[]> = { working: [], here: [], out: [] };
  for (const m of members) groups[rosterGroup(m)]!.push(m);

  const present = members.filter((m) => rosterGroup(m) !== 'out').length;
  const head = [
    `${members.length} member${members.length === 1 ? '' : 's'} · ${present} present · ${groups['working']!.length} working`,
  ];
  if (me) head.push(`you are ${me}`);

  const out: string[] = [head.join(' · ')];
  for (const key of ['working', 'here', 'out'] as const) {
    const inGroup = groups[key]!;
    if (inGroup.length === 0) continue; // an empty group is not a fact worth a line
    out.push('', `${key}:`);
    // The roster is an overview: a status is clipped so twenty working members can't bury the reader.
    // `team_members {name}` is the detail tool and gives the whole thing.
    for (const m of inGroup) out.push('  ' + formatMember(m, key, ROSTER_STATE_MAX));
  }
  return out.join('\n');
}

/** How much of a self-reported status the *overview* shows before eliding (agents post paragraphs). */
const ROSTER_STATE_MAX = 180;

type RosterGroup = 'working' | 'here' | 'out';
function rosterGroup(m: MemberSummary): RosterGroup {
  const activity = m.activity ?? (m.presence === 'offline' ? 'offline' : 'active');
  if (activity === 'offline') return 'out';
  return activity === 'working' && m.state ? 'working' : 'here';
}

/**
 * One member: `name (agent · claude-opus-4-8 · cursor) — <what they are doing> [workspace]`.
 * Facets appear only when they say something, so a bare member is a bare line.
 *
 * `stateMax` clips the reported status — set by the roster overview, left off by `team_members`, which
 * is the detail tool and must not hand back a truncated status to someone deciding whether to hand off.
 */
export function formatMember(
  m: MemberSummary,
  group: RosterGroup = rosterGroup(m),
  stateMax?: number,
): string {
  const p = m.presences[0];
  const facets: string[] = [m.kind];
  // Every held role (ADR 227 multi-role), joined; an older daemon serves only the single label.
  const roles = m.roles?.length ? m.roles.join('+') : m.role;
  if (roles) facets.push(roles);
  const model = p?.model?.trim();
  if (model && model !== MODEL_UNKNOWN) facets.push(model);
  // A live agent seat attesting nothing is a hole in the evidence, not a quiet absence — same rule
  // and same scoping as the CLI roster (`packages/cli/src/render/rows.ts`). It matters more here:
  // this is the surface a seat reads when picking someone to hand off to or route a review at, and
  // an unattested seat is one ADR 158 will refuse as an acceptor. Better to see that before routing.
  else if (m.kind === 'agent' && group !== 'out' && p) facets.push('model unattested');
  if (group !== 'out' && p?.surface) facets.push(p.surface);
  if (m.lifecycle === 'session') facets.push('session');
  // `!= null`, not truthiness: an epoch-0 timestamp is falsy and would silently drop the date.
  if (m.lifecycle === 'until' && m.lifecycle_until != null) {
    facets.push(`until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`);
  }
  // A residency-enrolled seat (ADR 131) is offline but not unreachable — a directed act wakes it.
  if (group === 'out' && m.wakeable) {
    facets.push('wakeable');
    // `resumable` only inside the harness's ~30d GC horizon (why the wire carries a timestamp).
    if (m.resumable_at != null && Date.now() - m.resumable_at < 30 * 24 * 60 * 60 * 1000)
      facets.push('resumable');
  }

  let line = `${m.name} (${facets.join(' · ')})`;
  // The payload: what they said they are doing — the fact the old tools left out entirely.
  if (group === 'working' && m.state) {
    const state = m.state.replace(/\s+/g, ' ').trim();
    const clipped =
      stateMax && state.length > stateMax ? state.slice(0, stateMax - 1).trimEnd() + '…' : state;
    line += ` — ${clipped}`;
  }
  if (group !== 'out' && p?.workspace) line += ` [${p.workspace}]`;
  return line;
}

/** Compact text rendering of a message for an agent to read. */
export function formatMessage(env: Envelope): string {
  const to =
    env.to.kind === 'member'
      ? `→ ${env.to.name}`
      : env.to.kind === 'team'
        ? '→ @team'
        : '→ @broadcast';
  const meta = env.meta && Object.keys(env.meta).length ? ` ${JSON.stringify(env.meta)}` : '';
  return `${env.from} [${env.act}] ${to}: ${env.body}${meta} (id=${env.id})`;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * The known failure classes an agent can act on, mapped to their repair (ADR 144 inc 3). Every class
 * here earned its place by stranding a real session: a matched error names the way out instead of
 * leaving the agent to rediscover it. Deterministic string matching only — no model in the request
 * path. Unknown errors get no hint: a wrong repair is worse than none.
 */
/** The one pattern that recognizes an eviction refusal, wherever its text surfaces (ADR 237). */
const EVICTED_RE = /superseded|taken over|replaced by/i;

const REPAIR_CLASSES: { match: RegExp; hint: string }[] = [
  {
    // Transport-level connect failures (Node's fetch/undici + socket vocabulary): the daemon is down
    // or unreachable — no tool call will work until a human restarts it.
    match: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up/i,
    hint: 'the team daemon looks unreachable — no musterd tool will work until a human checks it (`musterd service status`)',
  },
  {
    // The resume-token treadmill (ADR 087 / ADR 193): the seat's grant lapsed. The adapter drops it
    // and retries bare once; if that still cannot occupy, remint + reload.
    match: /grant (expired|revoked|consumed)|expired_grant/i,
    hint: 'the seat grant is stale — this adapter drops it and retries bare; if that still fails, a human remints with `musterd agent <seat> --path <this workspace>` then /mcp reload',
  },
  {
    // ADR 068/092: another session took this seat; this one is stale, not broken.
    match: EVICTED_RE,
    hint: 'another session took this seat — team_status shows who holds it now; team_join re-claims but would displace them, so choose deliberately (ADR 237)',
  },
  {
    match: /no memory saved/i,
    hint: 'nothing saved yet — team_memory_save at wrap-up writes the note the next occupant sees',
  },
  {
    match: /lane .*not found|unknown lane/i,
    hint: 'lane_board lists the live lane ids',
  },
  {
    match: /unknown member|not a member|no such member/i,
    hint: 'team_members lists valid seat names',
  },
];

/** The repair line for a known failure class, or '' — see {@link REPAIR_CLASSES}. */
export function repairHint(message: string): string {
  const cls = REPAIR_CLASSES.find((c) => c.match.test(message));
  return cls ? `\nrepair: ${cls.hint}` : '';
}

/**
 * The one error renderer every tool's catch block uses (ADR 144 inc 3) — `error: <message>` plus the
 * repair line when the failure class is known. Routing all errors through here is what the result
 * audit holds mechanically: a tool that hand-rolls its error text escapes the repair classes.
 */
export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return textResult(`error: ${message}${repairHint(message)}`);
}

/**
 * The dormant-guard message for acting tools. If a prior (auto)join failed, include *why* —
 * otherwise a silent autojoin failure (e.g. a wrong-db token rejection) just reads as
 * "call team_join first" and the real cause (member offline everywhere) stays hidden.
 */
export function notJoinedMessage(action: string, lastJoinError: string | null): string {
  // ADR 237: an evicted session DID join — "call team_join first" is the opposite of what happened,
  // and following it reflexively is the ADR 131 ping-pong. Name the eviction instead.
  if (lastJoinError && EVICTED_RE.test(lastJoinError)) {
    return (
      `this session was evicted from its seat — a newer session took it over, so you can't ${action} as it. ` +
      `team_status shows who holds the seat now; team_join would displace them, so rejoin only deliberately.\n` +
      `Eviction detail: ${lastJoinError}`
    );
  }
  const base = `you haven't joined the team yet — call team_join first, then ${action}`;
  return lastJoinError ? `${base}.\nNote: the last join attempt failed: ${lastJoinError}` : base;
}

/**
 * ADR 237 decision 3 — reads carry the eviction too. An evicted session's `team_status` answered
 * "you are ryder" unqualified for twenty minutes in the incident; the client held the fact the whole
 * time (`lastJoinError`). This renders it ahead of the roster, so the cheapest read a confused
 * session reaches for is the one that corrects it. Empty string when nothing is known — the common
 * case pays one regex. Server-side read gating is deliberately NOT added (the HTTP layer cannot
 * distinguish sessions — ADR 101); this is the client rendering its own knowledge.
 */
export function evictionNotice(lastJoinError: string | null): string {
  if (!lastJoinError || !EVICTED_RE.test(lastJoinError)) return '';
  return (
    `⚠ this session was evicted from its seat — the roster below reflects whoever holds it now, ` +
    `not this session. team_join would displace them, so rejoin only deliberately (ADR 237).\n` +
    `Eviction detail: ${lastJoinError}\n\n`
  );
}

/**
 * Guard message for an acting tool when the session isn't ready (claim-on-first-use, ADR 032/033).
 * Two distinct states: **pending** (no seat claimed yet → name yourself), and **dormant** (claimed
 * but not joined → just join). Refusing cleanly here is what "pending presence … team_send /
 * team_inbox_check refuse while unclaimed" means.
 */
export function notReadyMessage(
  client: { claimed: boolean; lastJoinError: string | null; claimCode: string },
  action: string,
): string {
  if (!client.claimed) {
    const base =
      `you're a pending presence (unclaimed, code ${client.claimCode}) — you hold no seat, so you ` +
      `can't ${action}. Claim one first: team_join {as:'Ada'} (named) or team_join {role:'backend'} ` +
      `(pool), or have a human run \`musterd claim <name>\` here.`;
    // Seat-drop B (ADR 193): a restarted adapter is still `!claimed` after a failed claim, and the
    // failure (e.g. expired_grant) is exactly what the agent needs — not a blank "claim a seat".
    if (!client.lastJoinError) return base;
    return `${base}\nNote: the last join attempt failed: ${client.lastJoinError}${repairHint(client.lastJoinError)}`;
  }
  return notJoinedMessage(action, client.lastJoinError);
}

/**
 * A warning as a fact, not only a sentence (lane 01M2NRYJEQ).
 *
 * Every warning on a result that also carries `structuredContent` must appear here as well: prose
 * appended to `content[].text` reaches only the clients that render text, and the ones that do not
 * were shown nothing at all. `kind` is the discriminator a client can branch on, `text` is the one
 * agreed wording (never a second one — a warning that reads differently in two places is two
 * warnings), and the remaining fields are the facts behind it.
 */
export type BuildSkewWarning = {
  kind: 'build_skew';
  text: string;
  /** The commit this running adapter's dist was built from. */
  adapter: string;
  /** The commit the daemon booted from — the reference, never "behind". */
  daemon: string;
};

export type SyncWedgeWarningFact = {
  kind: 'sync_wedge';
  text: string;
  seat: string;
  bound_to: string;
  node_id: string;
  since: number;
};

/**
 * Provisioning drift (spec 2026-09-16, ADR 408 increment 4) — a workspace whose guidance, hooks or
 * permission floor is behind what this build writes.
 *
 * A THIRD member of this union rather than a `structuredContent.workspace` key of its own, and that
 * is the whole design decision. A field that exists only when something is wrong IS a warning; put
 * it in a second place and every client that does not know the new key drops it — which is exactly
 * the defect lane 01M2NRYJEQ fixed one key over, where the prose said "stale tools" and the
 * structured half said nothing.
 *
 * Counts, never paths: this rides into model context at every inbox check, and which file drifted
 * does not change what the reader types. `repairable_at` is the one judgement the warning makes —
 * `'session-start'` when the next session will heal it by itself, `'manual'` when it will not.
 *
 * The union is deliberately left OPEN to a future `unknown` case: a workspace whose machine-wide
 * hook was never provisioned runs nothing, so its cache is ABSENT rather than clean, and "I cannot
 * tell" is a third state that neither `clean` nor these counts can express.
 */
export type ProvisioningDriftWarning = {
  kind: 'provisioning_drift';
  text: string;
  guidance: number;
  hooks: number;
  permissions: number;
  /** Whether a new session repairs this by itself, or a human has to type the commands. */
  repairable_at: 'session-start' | 'manual';
  /** The `musterd:self-heal` tombstone — drift is real AND self-heal is switched off here. */
  declined: boolean;
  /** When the CLI last measured it, so a reader can judge how old these counts are. */
  inspected_at: number;
};

export type ToolWarning =
  | BuildSkewWarning
  | SyncWedgeWarningFact
  | ProvisioningDriftWarning
  | DriftUnreadableWarning;

/**
 * Read `.musterd/drift.json` and say what is behind — the adapter half of workspace self-heal.
 *
 * Reads the file directly with `readFileSync` + `safeParse` and imports NOTHING from `@musterd/cli`.
 * The inspection is three file reads and this surface runs many times a minute on a busy seat, so
 * the CLI measures on its own cadence (session start, and the interrupt-check probe) and this only
 * ever reads what it left. A cache it cannot read, cannot parse, or that says nothing is wrong is
 * silence — the same rule as build skew: an unknown state is never reported as a problem.
 */
/**
 * How old a drift cache may be before it stops being evidence about the present.
 *
 * The CLI re-inspects on a 10-minute TTL (`DRIFT_CACHE_TTL_MS`) — but only at a tool boundary, because
 * the writer is the PostToolUse hook. So a record older than the threshold means ONE of two things:
 * the hook is not running, or the seat made no tool call for that long — and a seat waiting on a
 * review is quiet for hours (measured on izzo 2026-09-18: written 13:25:44, no tool call
 * 13:29→16:12, "167m old" at the first inbox check after, rewritten by that check's own hook two
 * seconds later). Age alone cannot separate the two; `driftUnreadableOf` separates them by
 * remembering the first sighting and speaking only once a boundary has passed with no write
 * (ADR 421). Three missed cycles remains the threshold at which a sighting starts counting.
 * Deliberately NOT imported from `@musterd/cli` — the adapter takes no cli dependency (ADR 408
 * inc 4) — so this is a duplicated constant, and if the TTL moves this must be re-checked against
 * it. That coupling is the price of the boundary, and it is named rather than hidden.
 */
export const DRIFT_STALE_AFTER_MS = 30 * 60 * 1000;

export type DriftUnreadableWarning = {
  kind: 'drift_unreadable';
  text: string;
  /** Why the record could not be believed — absent, malformed, or too old to be about now. */
  reason: 'absent' | 'unparseable' | 'stale';
  /** Age of the cache in ms; only meaningful for `stale`. */
  age_ms?: number;
};

/**
 * "I cannot tell" as a fact of its own (lane 01M2NYV805).
 *
 * `provisioningDriftOf` returns null for an absent cache, an unparseable one and a genuinely clean
 * one alike, so a seat whose drift record is missing reports exactly like a seat with nothing wrong.
 * That is the worse half of the family this repo kept finding on 2026-09-16: the other instances
 * were fixes that did not arrive and were found because something LOOKED wrong; this one is a report
 * that does not arrive, and it looks like good news.
 *
 * The population it hits is the population it exists for. The cache is written on the interrupt-check
 * cadence, i.e. by the PostToolUse hook, so a seat whose hook is stale or missing never writes one —
 * measured across big-body, kimi and ghost on 2026-09-16. `stale` is the sharper of the three: a seat
 * whose hook breaks AFTER one clean write leaves a zeroed file behind, and absence-only detection
 * stays quiet about it forever.
 *
 * NOT CRYING WOLF is the hard half. `resolveBindingDir` falls back to `process.cwd()` when its walk-up
 * finds nothing (binding.ts:204), so `workspaceDir` is always defined and cannot be the discriminator
 * — a fresh clone or a scratch folder would be told its provisioning is unreadable, which is noise and
 * exactly how a warning gets muted. The gate is the resolver's OWN predicate: a seat workspace is one
 * carrying `.musterd/binding.json` or `.musterd/workspace.json`, which is precisely what the walk-up
 * accepts. Anywhere else has no drift record because it never should have one.
 */
/**
 * When THIS adapter first read each workspace's record as stale, by workspace dir. One entry per
 * process: the adapter lives as long as the session, and every `team_*` call it serves is itself
 * a tool boundary the hook rides — which is exactly the observation the rule needs. Injectable so
 * a test can hold its own.
 */
const staleFirstSeen = new Map<string, number>();

export function driftUnreadableOf(
  cwd: string | undefined,
  now: number = Date.now(),
  seen: Map<string, number> = staleFirstSeen,
): DriftUnreadableWarning | null {
  if (cwd === undefined) return null;
  const dir = join(cwd, '.musterd');
  // The resolver's own two files, in its own order. Using the same predicate means this can never
  // disagree with what counts as a seat workspace elsewhere in the adapter.
  const isSeatWorkspace =
    existsSync(join(dir, 'binding.json')) || existsSync(join(dir, 'workspace.json'));
  if (!isSeatWorkspace) return null;

  let raw: string;
  try {
    raw = readFileSync(join(dir, 'drift.json'), 'utf8');
  } catch {
    return unreadable('absent');
  }
  let cache: DriftCache;
  try {
    const parsed = DriftCacheSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return unreadable('unparseable');
    cache = parsed.data;
  } catch {
    return unreadable('unparseable');
  }
  const age = now - cache.inspected_at;
  if (age <= DRIFT_STALE_AFTER_MS) {
    seen.delete(cwd);
    return null;
  }
  // Stale. Whether the hook is dead or the seat was merely quiet is not in the file; it is in what
  // happens NEXT (ADR 421). This call is a tool boundary, so a living hook rewrites the record
  // before the next one — and the next sighting decides:
  //   · first sighting → remember it, say nothing;
  //   · a later sighting, record still older than the first → a boundary passed and nothing wrote,
  //     which is a hook that is not running — say so, now that it is earned;
  //   · a later sighting, record newer than the first → the hook wrote and the seat idled past the
  //     threshold AGAIN — this is a new first sighting.
  const first = seen.get(cwd);
  if (first === undefined || cache.inspected_at >= first) {
    seen.set(cwd, now);
    return null;
  }
  return unreadable('stale', age);
}

function unreadable(
  reason: 'absent' | 'unparseable' | 'stale',
  age_ms?: number,
): DriftUnreadableWarning {
  // Says neither "you are drifted" (not known) nor nothing (a lie), and names the most likely cause,
  // because the reader's next move depends on it: the writer runs from the hook, so an unreadable
  // record is usually a hook that is not running rather than a provisioning problem of its own.
  // For `stale` the cause is not merely likely — `driftUnreadableOf` only reaches here once a tool
  // boundary has passed with no write (ADR 421), and the sentence says what was seen.
  const why =
    reason === 'absent'
      ? 'no drift record has been written'
      : reason === 'unparseable'
        ? 'its drift record cannot be read'
        : `its drift record is ${String(Math.round((age_ms ?? 0) / 60000))}m old and a tool ` +
          `boundary has passed since this seat first read it stale, with no rewrite`;
  return {
    kind: 'drift_unreadable',
    reason,
    ...(age_ms === undefined ? {} : { age_ms }),
    text:
      `⚠ this workspace's provisioning state is UNKNOWN, not clean — ${why}. The record is written ` +
      `by the interrupt-check hook, so the likeliest cause is that the hook is not running. ` +
      `\`musterd init --check\` reads it directly.`,
  };
}

export function provisioningDriftOf(cwd: string | undefined): ProvisioningDriftWarning | null {
  if (cwd === undefined) return null;
  let cache: DriftCache;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, '.musterd', 'drift.json'), 'utf8'));
    const parsed = DriftCacheSchema.safeParse(raw);
    if (!parsed.success) return null;
    cache = parsed.data;
  } catch {
    return null;
  }
  const { guidance, hooks, permissions, declined } = cache;
  if (guidance + hooks + permissions === 0) return null;

  // Increment 3 self-heals guidance and in-worktree hooks and NOTHING else: the permission floor is
  // the harness's own security boundary (ADR 261) and is never written from a hook. So a folder
  // whose only drift is permissions — or one carrying the tombstone — does not improve by starting
  // a new session, and saying otherwise sends the reader to a repair that will not happen.
  const repairable_at = !declined && guidance + hooks > 0 ? 'session-start' : 'manual';
  const behind = [
    guidance > 0 ? plural(guidance, 'guidance file', 'guidance files') : null,
    hooks > 0 ? plural(hooks, 'hook', 'hooks') : null,
    permissions > 0 ? plural(permissions, 'permission entry', 'permission entries') : null,
  ].filter((f): f is string => f !== null);
  const fixes = [
    guidance > 0 ? '`musterd init --refresh-guidance`' : null,
    hooks > 0 ? '`musterd init --refresh-hooks`' : null,
    permissions > 0 ? '`musterd init --refresh-permissions`' : null,
  ].filter((f): f is string => f !== null);
  // What the sentence has to get right is WHO acts. The permission floor never self-heals, so a
  // reader told "the next session start fixes this" would correctly do nothing and stay broken.
  const tail = declined
    ? 'self-heal is declined in this folder, so nothing repairs it by itself'
    : repairable_at === 'manual'
      ? "the permission floor is never self-healed; it is the harness's security boundary"
      : permissions > 0
        ? 'the next session start repairs the guidance and hooks, but the permission floor never is'
        : 'the next session start repairs this, or you can do it now';
  return {
    kind: 'provisioning_drift',
    guidance,
    hooks,
    permissions,
    repairable_at,
    declined,
    inspected_at: cache.inspected_at,
    text: `⚠ musterd: this workspace is behind on ${list(behind)} — ${tail}; run ${list(fixes)}.`,
  };
}

/** The same finding as its prose twin — same source, same wording, same silence. */
export function provisioningDriftLine(cwd: string | undefined): string {
  const w = provisioningDriftOf(cwd);
  return w ? `\n${w.text}` : '';
}

/** "a", "a and b", "a, b and c" — a sentence a reader scans, not a machine-joined array. */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The wedge as a fact beside its sentence — same source, same wording, same silence. */
export function syncWedgeOf(
  roster: { sync?: { wedged: SyncWedge | null } } | undefined,
  now: number = Date.now(),
): SyncWedgeWarningFact | null {
  const w = roster?.sync?.wedged;
  if (!w) return null;
  return {
    kind: 'sync_wedge',
    text: describeSyncWedge(w, now),
    seat: w.seat,
    bound_to: w.bound_to,
    node_id: w.node_id,
    since: w.since,
  };
}

/** The wedge fact for a client — best-effort, like its prose twin: any failure reads as silence. */
export async function syncWedgeOfClient(client: {
  roster?: () => Promise<{ sync?: { wedged: SyncWedge | null } }>;
}): Promise<SyncWedgeWarningFact | null> {
  try {
    if (typeof client.roster !== 'function') return null;
    return syncWedgeOf(await client.roster());
  } catch {
    return null;
  }
}

/**
 * One warning line when this adapter's dist differs from the daemon's build (ADR 135) — the
 * "money surface": the running process reports the stamp it *booted* with, so a stale dist on disk
 * AND a rebuilt-but-not-reloaded session both self-incriminate. Silence unless BOTH sides are known
 * (an unstamped client or unreachable daemon must not cry wolf). Pure inequality, and the wording is
 * "differs", never "behind" — a feature-branch build is legitimately ahead of the daemon.
 */
export async function buildSkewWarning(client: {
  build: string | undefined;
  daemonBuild: () => Promise<string | undefined>;
}): Promise<string> {
  const w = await buildSkewOf(client);
  return w ? `\n${w.text}` : '';
}

/**
 * The same finding as a structured fact (lane 01M2NRYJEQ).
 *
 * `buildSkewWarning` was correct, was called on the minute-0 surface, and reached nobody: it is
 * appended to `content[].text`, and the non-empty inbox path returns `structuredContent` beside it.
 * A client that renders the structured half and drops the prose showed the seat nothing — so a
 * session running stale tools looked exactly like a fresh one. Measured 2026-09-16: a seat ran a
 * 14-hour-old adapter against a current daemon, saw no line, and nearly reported a correct fix as
 * failing on the strength of it.
 *
 * Both refs ride along rather than only the sentence, so a client can render its own line or act on
 * the fact; `text` is carried too, so a client that only prints stays useful. Same silence rules as
 * before — an unknown side is never reported as skew.
 */
export async function buildSkewOf(client: {
  build: string | undefined;
  daemonBuild: () => Promise<string | undefined>;
}): Promise<BuildSkewWarning | null> {
  const mine = client.build;
  if (!mine) return null;
  const daemon = await client.daemonBuild();
  if (!daemon || daemon === mine) return null;
  return {
    kind: 'build_skew',
    adapter: mine,
    daemon,
    text:
      `⚠ your musterd adapter (${mine.slice(0, 7)}) differs from the daemon (${daemon.slice(0, 7)})` +
      ` — this session runs stale tools. Rebuild this worktree (pnpm build) and /mcp reload to pick it up.`,
  };
}

/**
 * ADR 360 follow-on: a joiner whose push the hub refuses is invisible to the team — every act from
 * this machine is stuck behind the refused one — and the seat named in the refusal is exactly who
 * can clear it. Say so where that seat reads: the roster and the inbox. Silent when the daemon
 * predates the field or the sync is fine.
 */
export function syncWedgeWarning(
  roster: { sync?: { wedged: SyncWedge | null } } | undefined,
  now: number = Date.now(),
): string {
  const w = roster?.sync?.wedged;
  return w ? `\n${describeSyncWedge(w, now)}` : '';
}

/** The wedge line for a client — best-effort: an older daemon, a stub, or a failed read all read as silence. */
export async function syncWedgeWarningFor(client: {
  roster?: () => Promise<{ sync?: { wedged: SyncWedge | null } }>;
}): Promise<string> {
  try {
    if (typeof client.roster !== 'function') return '';
    return syncWedgeWarning(await client.roster());
  } catch {
    return '';
  }
}
