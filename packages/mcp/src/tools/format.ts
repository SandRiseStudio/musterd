import { MODEL_UNKNOWN, type Envelope, type MemberSummary } from '@musterd/protocol';

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
  if (members.length === 0) return 'no members';
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
  const activity = m.activity ?? (m.presence === 'offline' ? 'offline' : 'idle');
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
  if (m.role) facets.push(m.role);
  const model = p?.model?.trim();
  if (model && model !== MODEL_UNKNOWN) facets.push(model);
  if (group !== 'out' && p?.surface) facets.push(p.surface);
  if (m.lifecycle === 'session') facets.push('session');
  // `!= null`, not truthiness: an epoch-0 timestamp is falsy and would silently drop the date.
  if (m.lifecycle === 'until' && m.lifecycle_until != null) {
    facets.push(`until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`);
  }
  // A residency-enrolled seat (ADR 131) is offline but not unreachable — a directed act wakes it.
  if (group === 'out' && m.wakeable) facets.push('wakeable');

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
 * The dormant-guard message for acting tools. If a prior (auto)join failed, include *why* —
 * otherwise a silent autojoin failure (e.g. a wrong-db token rejection) just reads as
 * "call team_join first" and the real cause (member offline everywhere) stays hidden.
 */
export function notJoinedMessage(action: string, lastJoinError: string | null): string {
  const base = `you haven't joined the team yet — call team_join first, then ${action}`;
  return lastJoinError ? `${base}.\nNote: the last join attempt failed: ${lastJoinError}` : base;
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
    return (
      `you're a pending presence (unclaimed, code ${client.claimCode}) — you hold no seat, so you ` +
      `can't ${action}. Claim one first: team_join {as:'Ada'} (named) or team_join {role:'backend'} ` +
      `(pool), or have a human run \`musterd claim <name>\` here.`
    );
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
