import {
  actMayRing,
  askContract,
  AskSpeciesSchema,
  AskTierSchema,
  type DoorbellPolicy,
  type DoorbellRecord,
  type DoorbellSink,
  type Envelope,
  holdsRing,
  OFF_MACHINE_SINKS,
  resolveRoute,
  ringTargets,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import {
  actAnsweredOrResolved,
  getDoorbellPolicy,
  insertRing,
  listHeldRings,
  listMembersWithHeldRings,
  memberAvailability,
  memberDoorbellPrefs,
  type Ring,
  setRingState,
} from '../store/doorbell.js';
import { getMemberById, listMembers } from '../store/members.js';
import { adminHumanPresent, humanPresent } from '../store/reachability.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { resolveCapabilities } from '../store/rows.js';
import { formatDoorbellSlackText, postSlackWebhook } from './slack.js';
import { postDoorbellWebhook } from './webhook.js';

/**
 * The doorbell (ADR 443): ring a human when something is addressed to them, through surfaces
 * musterd owns — never through a harness session.
 *
 * `ringDoorbell` runs from `routeEnvelope` after persist + deliver. Per rung human it composes the
 * body-less record, resolves the route, and either holds the ring (self-set away/dnd) or dispatches
 * it. Dispatch is detached: every off-machine POST is fire-and-forget and audits
 * `doorbell.surfaced {surface, ok, status?}` — never a URL, never a body. `live` needs nothing from
 * the daemon (the firehose already carried the act to `/live`); `os` leaves the ring `queued` for
 * the host named on it to raise the banner.
 */

/** Does the daemon have anything to do for this sink right now? */
function resolveUrl(
  sink: DoorbellSink,
  policy: DoorbellPolicy,
  personal: string | undefined,
): string | undefined {
  if (sink === 'slack') return personal ?? policy.slack_url;
  if (sink === 'webhook') return personal ?? policy.webhook_url;
  return undefined;
}

interface DispatchOptions {
  /** ADR 155 Increment 2, off-machine sinks only: the human is present, so Slack/webhook wait. */
  quietOffMachine: boolean;
  /** URLs already POSTed for this act — a team URL shared by several rung humans fires once. */
  posted: Set<string>;
  /** The ask body, for the `slack` sink's ADR 149 exception only. Never stored. */
  askBody: string;
}

function dispatch(
  ctx: Ctx,
  team: TeamRow,
  member: MemberRow,
  ring: Ring,
  policy: DoorbellPolicy,
  opts: DispatchOptions,
): void {
  const prefs = memberDoorbellPrefs(member);
  for (const sink of ring.sinks) {
    if (!OFF_MACHINE_SINKS.has(sink) || opts.quietOffMachine) continue;
    const url = resolveUrl(sink, policy, prefs?.sinks[sink]?.url);
    if (!url || opts.posted.has(url)) continue;
    opts.posted.add(url);
    const attempt =
      sink === 'slack'
        ? postSlackWebhook(url, formatDoorbellSlackText(ring.record, opts.askBody))
        : postDoorbellWebhook(url, ring.record);
    void attempt.then(({ ok, status }) => {
      appendAudit(ctx.db, team.id, {
        actor: ring.record.from,
        action: 'doorbell.surfaced',
        target: member.name,
        result: 'allow',
        detail: { surface: sink, ok, ...(status !== undefined ? { status } : {}) },
      });
    });
  }
  // The host raises the banner; until it reports, the ring waits for it. With no host label there
  // is no machine to raise it on, and nothing is left to do.
  const waitsForHost = ring.sinks.includes('os') && ring.host !== null;
  setRingState(ctx.db, ring.id, waitsForHost ? 'queued' : 'done');
}

/** Ring every human this act rings (ADR 443 §2). Never throws into the send path. */
export function ringDoorbell(ctx: Ctx, team: TeamRow, env: Envelope): void {
  try {
    ring(ctx, team, env);
  } catch (err) {
    log.warn({ msg: 'doorbell_ring_failed', team: team.slug, act: env.id, err: String(err) });
  }
}

function ring(ctx: Ctx, team: TeamRow, env: Envelope): void {
  if (!actMayRing(env.act)) return;
  const members = listMembers(ctx.db, team.id).filter((m) => m.kind === 'human' && !m.observer);
  const humans = new Set(members.map((m) => m.name));
  const admins = new Set(members.filter((m) => resolveCapabilities(m).is_admin).map((m) => m.name));
  const to = env.to.kind === 'member' ? env.to.name : null;
  const targets = ringTargets({ act: env.act, to, meta: env.meta, humans, admins });
  if (targets.length === 0) return;

  const meta = env.meta ?? {};
  const species = AskSpeciesSchema.safeParse(meta['species']).data;
  const tier = AskTierSchema.safeParse(meta['tier']).data;
  const now = Date.now();
  const record: DoorbellRecord = {
    team: team.slug,
    from: env.from,
    act: env.act,
    ...(species ? { species } : {}),
    ...(tier ? { tier } : {}),
    act_id: env.id,
    ...(env.act === 'ask' && tier ? { deadline_ms: now + askContract(tier).timeout_ms } : {}),
    answer_path: `/live?act=${encodeURIComponent(env.id)}`,
  };
  const policy = getDoorbellPolicy(ctx.db, team.id);
  // ADR 155 Increment 2: an in-thread ask is the agent's re-notify, and always rings loud.
  const isRenotify = env.act === 'ask' && typeof env.thread === 'string' && env.thread.length > 0;
  // Rung as the admin group (team-addressed, or an ask to an agent): the ADR 155 rule as it was —
  // any present admin keeps the off-machine sinks quiet. Rung by name: that human's own presence.
  const directedToHuman = to !== null && humans.has(to);
  const timeout = ctx.config.presenceTimeoutMs;
  const groupPresent =
    !isRenotify && !directedToHuman && adminHumanPresent(ctx.db, team.id, timeout);
  const posted = new Set<string>();

  for (const name of targets) {
    const member = members.find((m) => m.name === name);
    if (!member) continue;
    const prefs = memberDoorbellPrefs(member);
    const sinks = resolveRoute(policy, prefs, tier);
    const held = holdsRing(memberAvailability(member), tier, now);
    const stored = insertRing(ctx.db, {
      team_id: team.id,
      member_id: member.id,
      act_id: env.id,
      record,
      sinks,
      state: held ? 'held' : 'queued',
      host: prefs?.sinks.os?.host ?? null,
      created_at: now,
    });
    if (held) continue;
    const quietOffMachine =
      !isRenotify &&
      (directedToHuman ? humanPresent(ctx.db, team.id, member, timeout) : groupPresent);
    dispatch(ctx, team, member, stored, policy, {
      quietOffMachine,
      posted,
      askBody: env.act === 'ask' ? env.body : '',
    });
  }
}

/**
 * Release a member's held rings (ADR 443 §4) — called when they set `available`, and from the
 * reaper's sweep when a hold lapses by its `until`. A ring whose act was answered meanwhile (an
 * accept/decline replying to it, or a resolve of its thread) is dropped, not rung. Presence quiet
 * does not apply: a flush is not a raise, and the human asked to be held, not silenced.
 */
export function flushHeldRings(ctx: Ctx, team: TeamRow, member: MemberRow): void {
  try {
    const now = Date.now();
    const held = listHeldRings(ctx.db, member.id);
    if (held.length === 0) return;
    const policy = getDoorbellPolicy(ctx.db, team.id);
    const posted = new Set<string>();
    for (const ring of held) {
      if (holdsRing(memberAvailability(member), ring.record.tier, now)) continue;
      if (actAnsweredOrResolved(ctx.db, team.id, ring.act_id)) {
        setRingState(ctx.db, ring.id, 'done');
        continue;
      }
      dispatch(ctx, team, member, ring, policy, {
        quietOffMachine: false,
        posted,
        askBody: ring.record.act === 'ask' ? askBodyOf(ctx, team, ring.act_id) : '',
      });
    }
  } catch (err) {
    log.warn({
      msg: 'doorbell_flush_failed',
      team: team.slug,
      member: member.name,
      err: String(err),
    });
  }
}

/**
 * The sweep's half (dolly's change b): flush every member whose hold may have lapsed. A member who
 * has left, or a team that is archived, has nobody left to ring — those rings are closed, not rung.
 */
export function flushLapsedHolds(ctx: Ctx, teamsById: (id: string) => TeamRow | undefined): void {
  for (const { member_id, team_id } of listMembersWithHeldRings(ctx.db)) {
    const member = getMemberById(ctx.db, member_id);
    const team = teamsById(team_id);
    if (member && team && member.left_at === null && team.archived_at === null) {
      flushHeldRings(ctx, team, member);
    } else {
      for (const ring of listHeldRings(ctx.db, member_id)) setRingState(ctx.db, ring.id, 'done');
    }
  }
}

/** Read an ask's body at dispatch for the `slack` sink — it is never stored with the ring. */
function askBodyOf(ctx: Ctx, team: TeamRow, actId: string): string {
  const row = ctx.db
    .prepare<
      [string, string],
      { body: string }
    >('SELECT body FROM messages WHERE team_id = ? AND id = ?')
    .get(team.id, actId);
  return row?.body ?? '';
}
