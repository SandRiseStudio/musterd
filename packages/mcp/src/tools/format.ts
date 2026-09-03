import {
  MODEL_UNKNOWN,
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
  const mine = client.build;
  if (!mine) return '';
  const daemon = await client.daemonBuild();
  if (!daemon || daemon === mine) return '';
  return (
    `\n⚠ your musterd adapter (${mine.slice(0, 7)}) differs from the daemon (${daemon.slice(0, 7)})` +
    ` — this session runs stale tools. Rebuild this worktree (pnpm build) and /mcp reload to pick it up.`
  );
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
