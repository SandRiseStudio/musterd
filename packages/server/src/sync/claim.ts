import {
  LANE_TERMINAL_STATES,
  type Lane,
  LaneSchema,
  SeatBoundElsewhereRefusalSchema,
  type SeatNodeTrusted,
  SeatNodeTrustedSchema,
  type SyncClaimRequest,
  SyncClaimRefusalSchema,
  type SyncLanePatchRequest,
  type Policy,
  type PolicyOverride,
  type SyncPolicyRequest,
  type SyncTrustRequest,
  type UpdateLane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { appendAudit } from '../store/audit.js';
import { getLane, LaneConflictError, type LaneExpectation, updateLane } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode, seatBinding, seatBindings, trustNodeForSeat } from '../store/nodes.js';
import { hasLivePresence } from '../store/presence.js';

/**
 * Federation increment 3c: the hub-authoritative claim (ADR 325 §Authority split, residence 1).
 *
 * Two halves of one act. `arbitrateClaim` runs ON THE HUB: the same guarded CAS and the same
 * live-incumbent rule the local PATCH applies, against the hub's row, writing the `lane.claimed`
 * event from the hub's allocator so it reaches every machine through the fold. `claimAtHub` runs
 * ON A JOINER: it asks, and it never writes — the joiner's row converges from the hub's log, which
 * is what makes "exactly one holder" a fact rather than a race between two machines each sure of
 * itself.
 *
 * Offline follows ADR 325 §Offline semantics: a claim that cannot reach the hub REFUSES, with its
 * own code. A provisional claim that might lose on reconnect invites building in a lane you do not
 * own — the exact failure musterd exists to prevent.
 */

const CLAIM_TIMEOUT_MS = 10_000;

/** The hub said no, and said why: the lane moved, or the seat/lane is not resolvable there yet. */
export class ClaimRefusedError extends Error {
  constructor(
    message: string,
    readonly holder: string | null,
    readonly state: string,
  ) {
    super(message);
    this.name = 'ClaimRefusedError';
  }
}

/**
 * The seat lives on another node (ADR 328 §4). Authorization, not contention: the lane may be
 * free, and the answer is an admin unbind or a claim from the machine the seat is bound to.
 */
export class SeatBoundElsewhereError extends Error {
  constructor(
    seat: string,
    readonly nodeId: string,
    readonly nodeLabel: string,
  ) {
    super(
      `seat "${seat}" is bound to node "${nodeLabel}" — a node speaks only for the seats resident ` +
        `on it (ADR 328 §4). Claim from that machine, or have an admin unbind the seat ` +
        `(DELETE /teams/<slug>/nodes/bindings/${seat}) to move it.`,
    );
    this.name = 'SeatBoundElsewhereError';
  }
}

/** The trust act was refused for a reason a retry does not clear (ADR 358). */
export class TrustRefusedError extends Error {
  constructor(
    readonly code: 'bound_elsewhere' | 'forbidden' | 'not_found',
    message: string,
    readonly nodeId: string | null = null,
    readonly nodeLabel: string | null = null,
  ) {
    super(message);
    this.name = 'TrustRefusedError';
  }
}

/**
 * ADR 358, the act itself — runs wherever the binding lives: on the hub for a forwarded request,
 * on a single-machine daemon for its own residents. `speaker` is the node vouching (the hub's
 * authenticated joiner, or the local row); it must already hold the seat. Writes `seat.node_trusted`
 * on a fresh row and nothing on an idempotent repeat. A refusal is a `seat.bound_elsewhere` deny row
 * when the speaker is not resident — the same ADR 328 §Experiment signal a bad claim leaves.
 */
export function applyTrust(
  db: Database,
  teamId: string,
  seat: { id: string; name: string; kind: string },
  speaker: { id: string; label: string },
  targetNodeId: string,
  now: number = Date.now(),
): SeatNodeTrusted {
  const result = trustNodeForSeat(db, teamId, seat, speaker.id, targetNodeId, now);
  if (result.trusted) {
    if (!result.already) {
      appendAudit(db, teamId, {
        actor: seat.name,
        action: 'seat.node_trusted',
        target: seat.name,
        result: 'allow',
        detail: { node: targetNodeId, by_node: speaker.id, by_label: speaker.label },
      });
    }
    return { seat: seat.name, node_id: targetNodeId, already: result.already };
  }
  if (result.reason === 'not_human') {
    throw new TrustRefusedError(
      'forbidden',
      `"${seat.name}" is an agent seat — agents stay bound to one node (ADR 042 kind scope, ADR 358); ` +
        'an admin unbind is the only way to move one.',
    );
  }
  if (result.reason === 'unknown_node') {
    throw new TrustRefusedError(
      'not_found',
      `node "${targetNodeId}" is not an enrolled, unrevoked node of this team — enroll it first ` +
        '(musterd node invite / join), then trust it.',
    );
  }
  const holder = seatBinding(db, seat.id);
  appendAudit(db, teamId, {
    actor: seat.name,
    action: 'seat.bound_elsewhere',
    target: seat.name,
    result: 'deny',
    detail: {
      node: speaker.id,
      bound_to: holder?.node_id ?? null,
      bound_label: holder?.label ?? null,
      act: 'trust',
    },
  });
  throw new TrustRefusedError(
    'bound_elsewhere',
    holder
      ? `only a session on a machine "${seat.name}" already lives on can trust another — this ` +
          `one (${speaker.label}) is not in the set; run it from "${holder.label}".`
      : `"${seat.name}" is not bound to any machine yet, so no session can vouch for another — ` +
          'act as the seat from this machine once (a claim, a presence) and it binds here first.',
    holder?.node_id ?? null,
    holder?.label ?? null,
  );
}

/**
 * The strict form of residence, for a forwarded act that CHANGES THE TEAM (gptbot's review of
 * #1228, 2026-09-03): the node must ALREADY be in the seat's set. It never creates the binding.
 *
 * `assertSeatResident` is first-writer-wins, which is right for ordinary work — a seat's first act
 * has to bind somewhere, and a lane claim is that act as readily as anything else. It is wrong for
 * an admin forward. There the seat being unbound is exactly the opening: any enrolled machine could
 * name an admin nobody had spoken for yet, take the binding in the same call that uses it, and set
 * the team's policy on every machine. "Not yet bound" must read as "not entitled here", not as a
 * free claim.
 *
 * A privileged forward never needs the lenient form, because it is never a seat's first act: the
 * seat lives on the joiner and has been acting there, and those acts bind it on the hub as they
 * replicate. If the seat is unbound, the request did not come from where the seat lives.
 *
 * Refusals reuse `TrustRefusedError` for its nullable node — an unbound seat has no holder to name
 * — and leave the same `seat.bound_elsewhere` deny row ADR 328 §Experiment counts.
 */
export function assertSeatAlreadyResident(
  db: Database,
  teamId: string,
  seat: { id: string; name: string },
  node: { id: string; label: string },
  act: string,
): void {
  const holders = seatBindings(db, seat.id);
  if (holders.some((h) => h.node_id === node.id)) return;
  const holder = holders[0];
  appendAudit(db, teamId, {
    actor: seat.name,
    action: 'seat.bound_elsewhere',
    target: seat.name,
    result: 'deny',
    detail: {
      node: node.id,
      bound_to: holder?.node_id ?? null,
      bound_label: holder?.label ?? null,
      act,
    },
  });
  throw new TrustRefusedError(
    'bound_elsewhere',
    holder
      ? `"${seat.name}" lives on "${holder.label}" — a ${act} is forwarded from a machine the ` +
          `seat is resident on, and this one (${node.label}) is not in its set.`
      : `"${seat.name}" is not resident on any machine yet, so no node may forward a ${act} as ` +
          'that seat — act as the seat from its own machine once and it binds there first.',
    holder?.node_id ?? null,
    holder?.label ?? null,
  );
}

/**
 * ADR 328 §4, the enforced half: bind the seat to the node speaking for it, first-writer-wins, and
 * refuse when another node already holds it. Runs on the hub for a forwarded claim and on every
 * daemon for a local self-claim (where `node` is the local row) — so by the time a second machine
 * enrolls, the seats that have been building on the first are already bound to it, and the ledger
 * records each refusal as the `seat.bound_elsewhere` row ADR 328 §Experiment watches for.
 *
 * Throws `SeatBoundElsewhereError`; every other outcome is a `seat.bound` row on first bind and
 * silence after.
 */
export function assertSeatResident(
  db: Database,
  teamId: string,
  seat: { id: string; name: string },
  node: { id: string; label: string },
  now: number = Date.now(),
): void {
  const had = seatBinding(db, seat.id);
  const result = bindSeatToNode(db, teamId, seat.id, node.id, now);
  if (result.bound) {
    if (!had) {
      appendAudit(db, teamId, {
        actor: seat.name,
        action: 'seat.bound',
        target: seat.name,
        result: 'allow',
        detail: { node: node.id, label: node.label },
      });
    }
    return;
  }
  appendAudit(db, teamId, {
    actor: seat.name,
    action: 'seat.bound_elsewhere',
    target: seat.name,
    result: 'deny',
    detail: { node: node.id, bound_to: result.node_id, bound_label: result.label },
  });
  throw new SeatBoundElsewhereError(seat.name, result.node_id, result.label);
}

/** The hub could not be asked. Distinct from a refusal by construction, never folded into one. */
export class HubUnreachableError extends Error {
  constructor(hubUrl: string, cause: string) {
    super(`the hub at ${hubUrl} could not be reached to arbitrate this claim (${cause})`);
    this.name = 'HubUnreachableError';
  }
}

/** This daemon's own node row with its label — minted on first use, the `insertMessage` rule. */
export function localNodeWithLabel(db: Database, teamId: string): { id: string; label: string } {
  const { id } = localNodeForTeam(db, teamId);
  const row = db
    .prepare<[string], { label: string }>('SELECT label FROM nodes WHERE id = ?')
    .get(id);
  return { id, label: row?.label ?? '' };
}

/** This daemon's enrollment for the team, if it is a joiner (the push/pull rule: node.json names OUR node row). */
export function joinerEnrollment(
  db: Database,
  teamId: string,
  teamSlug: string,
): { hub_url: string; credential: string; node_id: string } | null {
  const local = db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId);
  const record = readNodeState().nodes[teamSlug];
  if (!local || !record || record.node_id !== local.node_id) return null;
  return record;
}

/**
 * The policy that runs BEFORE an ownership/state write, in one place for both the local PATCH
 * handler and the hub's arbitration (ADR 361): what the daemon decides about a patch given the
 * row it can see. Service seats hold no lanes (ADR 232); a self-directed takeover is refused while
 * the incumbent is live (ADR 203); a counterpart's terminal close must not rewrite the worker's
 * stage-one merge attestation (ADR 305). Returns the patch to write and the guard the write must
 * carry — the caller's read, so the write is a CAS. Throws `MusterdError`.
 */
export function decideLanePatch(
  db: Database,
  teamId: string,
  member: { name: string; kind: string },
  before: Lane,
  body: UpdateLane,
  presenceTimeoutMs: number,
): { patch: UpdateLane; guard: LaneExpectation | undefined } {
  if (body.owner_seat !== undefined && member.kind === 'service')
    throw new MusterdError(
      'forbidden',
      `"${member.name}" is a service seat — ledger seats never claim or hold lanes (ADR 232)`,
    );
  if (body.owner_seat) {
    const newOwner = getMemberByName(db, teamId, body.owner_seat);
    if (newOwner?.kind === 'service')
      throw new MusterdError(
        'forbidden',
        `"${body.owner_seat}" is a service seat — a lane cannot be handed to a ledger seat (ADR 232)`,
      );
  }
  // A CLAIM is distinguishable from a HANDOFF by who the new owner is: taking it for yourself is
  // a claim; naming someone else is a deliberate give-away that must keep working. Only a
  // self-directed takeover of a LIVE incumbent is refused — an offline or departed owner stays
  // claimable (ADR 196's posture). Since presence replication (ADR 356) the presence consulted
  // here is the whole team's on every machine.
  const takingForSelf =
    body.owner_seat !== undefined &&
    body.owner_seat === member.name &&
    before.owner_seat !== null &&
    before.owner_seat !== member.name;
  if (takingForSelf) {
    const incumbent = getMemberByName(db, teamId, before.owner_seat!);
    const incumbentLive =
      incumbent !== undefined && hasLivePresence(db, incumbent.id, presenceTimeoutMs);
    if (incumbentLive) {
      throw new MusterdError(
        'conflict',
        `lane "${before.id}" is owned by ${before.owner_seat}, who is live — claiming it would ` +
          `duplicate their work. Pick another lane, or ask them to hand it over ` +
          `(lane_handoff) or release it.`,
      );
    }
  }
  const counterpartTerminal =
    body.state !== undefined &&
    LANE_TERMINAL_STATES.has(body.state) &&
    !LANE_TERMINAL_STATES.has(before.state) &&
    before.owner_seat !== null &&
    member.name !== before.owner_seat;
  const patch = counterpartTerminal ? { ...body, merged: undefined } : body;
  const guard =
    body.owner_seat !== undefined || body.state !== undefined
      ? { owner_seat: before.owner_seat, state: before.state }
      : undefined;
  return { patch, guard };
}

/** Does this patch move ownership or state — the edges ADR 325 residence 1 makes the hub's? */
export function isOwnershipOrStatePatch(body: UpdateLane): boolean {
  return body.owner_seat !== undefined || body.state !== undefined;
}

/**
 * Hub side, every ownership/state edge (ADR 361; the claim since ADR 355). Throws
 * `ClaimRefusedError` for every "no" the caller can act on; anything else is a fault. In order:
 *  - the seat is not on this roster yet (git lag) — retry after the roster reconciles;
 *  - the seat is bound to another node (ADR 328 §4) — `SeatBoundElsewhereError`;
 *  - the lane is not here yet (the origin's `lane.opened` has not folded) — retry after sync;
 *  - the policy (`decideLanePatch`) against the HUB's row — a live incumbent, a service seat;
 *  - the CAS with the JOINER's expectation: the lane moved since the joiner read it.
 * The hub writes the transition row as the seat, from its own allocator, with `node` naming the
 * joiner; it emits no act — the origin speaks (ADR 361 §2).
 */
export function arbitrateLanePatch(
  ctx: Ctx,
  team: { id: string; slug: string },
  node: { id: string; label: string },
  req: SyncLanePatchRequest,
  now: number = Date.now(),
): Lane {
  const seat = getMemberByName(ctx.db, team.id, req.seat);
  if (!seat) {
    throw new ClaimRefusedError(
      `seat "${req.seat}" is not on the hub's roster yet — the roster reconciles from git; retry`,
      null,
      'unknown',
    );
  }
  if (seat.kind === 'service' && req.patch.owner_seat !== undefined) {
    throw new ClaimRefusedError(
      `"${req.seat}" is a service seat — ledger seats never claim or hold lanes (ADR 232)`,
      null,
      'unknown',
    );
  }
  // Residence before anything about the lane: an unentitled node learns nothing about the board.
  assertSeatResident(ctx.db, team.id, seat, node, now);
  const before = getLane(ctx.db, team.id, req.lane, team.slug);
  if (!before) {
    throw new ClaimRefusedError(
      `lane "${req.lane}" is not yet replicated to the hub — its birth has not folded here; ` +
        'retry after the next sync',
      null,
      'unknown',
    );
  }
  let decided: { patch: UpdateLane; guard: LaneExpectation | undefined };
  try {
    decided = decideLanePatch(
      ctx.db,
      team.id,
      seat,
      before,
      req.patch,
      ctx.config.presenceTimeoutMs,
    );
  } catch (err) {
    if (err instanceof MusterdError && err.code === 'conflict') {
      throw new ClaimRefusedError(err.message, before.owner_seat, before.state);
    }
    throw err;
  }
  try {
    return updateLane(ctx.db, team.id, req.lane, team.slug, decided.patch, now, req.expect, {
      actor: req.seat,
      node: node.id,
    })!;
  } catch (err) {
    if (err instanceof LaneConflictError) {
      throw new ClaimRefusedError(
        `lane "${req.lane}" changed since it was read — it is now ` +
          `${err.actual.owner_seat ? `owned by ${err.actual.owner_seat}` : 'unowned'} ` +
          `(${err.actual.state}). Re-read the lane and retry.`,
        err.actual.owner_seat,
        err.actual.state,
      );
    }
    throw err;
  }
}

/** The claim, as the special case of `arbitrateLanePatch` it always was (ADR 355). */
export function arbitrateClaim(
  ctx: Ctx,
  team: { id: string; slug: string },
  node: { id: string; label: string },
  req: SyncClaimRequest,
  now: number = Date.now(),
): Lane {
  return arbitrateLanePatch(
    ctx,
    team,
    node,
    { lane: req.lane, seat: req.seat, patch: { owner_seat: req.seat }, expect: req.expect },
    now,
  );
}

/**
 * Joiner side, every ownership/state edge. Returns the hub's lane on success. Throws
 * `ClaimRefusedError` on a 409 with the hub's holder/state, `SeatBoundElsewhereError` on a 403,
 * `HubUnreachableError` when no answer came, and a plain Error for anything the hub answered that
 * is neither — an upgrade skew, say — so it surfaces as a fault, not a refusal.
 */
export async function patchAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  req: SyncLanePatchRequest,
): Promise<Lane> {
  let res: Response;
  try {
    res = await fetch(new URL(`/teams/${slug}/sync/lane`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ msg: 'sync_claim_hub_unreachable', team: slug, lane: req.lane, err: String(err) });
    throw new HubUnreachableError(enrollment.hub_url, String(err));
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 403) {
    const refusal = SeatBoundElsewhereRefusalSchema.safeParse(body);
    if (refusal.success) {
      // Relayed as-is: the hub's binding is the fact, and this daemon has nothing to add to it.
      throw new SeatBoundElsewhereError(req.seat, refusal.data.node_id, refusal.data.node_label);
    }
  }
  if (res.status === 409) {
    const refusal = SyncClaimRefusalSchema.safeParse(body);
    if (refusal.success) {
      throw new ClaimRefusedError(
        refusal.data.error.message,
        refusal.data.holder,
        refusal.data.state,
      );
    }
  }
  if (!res.ok) {
    throw new Error(`the hub answered ${res.status} to the lane patch: ${JSON.stringify(body)}`);
  }
  return LaneSchema.parse((body as { lane: unknown }).lane);
}

/** The claim, forwarded as the lane patch it is. Kept for callers that speak the claim shape. */
export async function claimAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  req: SyncClaimRequest,
): Promise<Lane> {
  return patchAtHub(enrollment, slug, {
    lane: req.lane,
    seat: req.seat,
    patch: { owner_seat: req.seat },
    expect: req.expect,
  });
}

/**
 * Joiner side of the trust act: ask the hub, write nothing. The hub's set is the fact; the joiner
 * has no row of its own for it. Refusals relay verbatim with the hub's code.
 */
export async function trustAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  req: SyncTrustRequest,
): Promise<SeatNodeTrusted> {
  let res: Response;
  try {
    res = await fetch(new URL(`/teams/${slug}/sync/trust`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ msg: 'sync_trust_hub_unreachable', team: slug, seat: req.seat, err: String(err) });
    throw new HubUnreachableError(enrollment.hub_url, String(err));
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 403 || res.status === 404) {
    const b = body as {
      error?: { code?: string; message?: string };
      node_id?: string;
      node_label?: string;
    } | null;
    const code = b?.error?.code;
    if (code === 'bound_elsewhere' || code === 'forbidden' || code === 'not_found') {
      throw new TrustRefusedError(
        code,
        b?.error?.message ?? '',
        b?.node_id ?? null,
        b?.node_label ?? null,
      );
    }
  }
  if (!res.ok) {
    throw new Error(`the hub answered ${res.status} to the trust act: ${JSON.stringify(body)}`);
  }
  return SeatNodeTrustedSchema.parse(body);
}

/**
 * Joiner side of the policy act (residence-2 census gap 1): forward the admin's sparse override to
 * the hub, write nothing locally. The hub's row is the fact; this daemon learns the answer back
 * through the fold, the same way it learns a lane it did not decide.
 *
 * Refusals relay with the hub's own code — an actor who is not an admin THERE is a 403 here, not a
 * local success. `HubUnreachableError` when no answer came: policy is not an act that may fork
 * (ADR 325 §Offline semantics), so the caller turns this into `hub_unreachable` and changes nothing.
 */
export async function policyAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  req: SyncPolicyRequest,
): Promise<{ policy: Policy; stored: PolicyOverride }> {
  let res: Response;
  try {
    res = await fetch(new URL(`/teams/${slug}/sync/policy`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ msg: 'sync_policy_hub_unreachable', team: slug, err: String(err) });
    throw new HubUnreachableError(enrollment.hub_url, String(err));
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as { error?: { code?: string; message?: string } } | null;
    // The hub's refusal is the answer, relayed with its code — `forbidden` for an actor who is no
    // admin there, `not_found` for a seat its roster lacks, `bound_elsewhere` for a seat that does
    // not live on this machine (gptbot's review of #1228). Anything else is a fault, not a verdict:
    // a 500 here would tell the admin the hub is broken when it has in fact answered them.
    if (
      b?.error?.code === 'forbidden' ||
      b?.error?.code === 'not_found' ||
      b?.error?.code === 'bound_elsewhere'
    ) {
      throw new MusterdError(
        b.error.code === 'bound_elsewhere' ? 'forbidden' : b.error.code,
        b.error.message ?? 'the hub refused the policy change',
      );
    }
    throw new Error(`the hub answered ${res.status} to the policy change: ${JSON.stringify(body)}`);
  }
  const parsed = body as { policy: Policy; stored: PolicyOverride };
  return { policy: parsed.policy, stored: parsed.stored };
}
