import { type Binding } from '@musterd/protocol';
import { findBinding, saveBinding } from './binding.js';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { clearPendingMarker } from './pending.js';

/** What `team_join` was asked to claim — a named seat, or the next open seat in a role pool. */
export type ClaimTarget = { seat: string } | { role: string };

export interface ClaimResult {
  /** The resolved seat name (a role pool's `<role>-<n>` is resolved server-side). While `pending`
   *  nothing is resolved yet, so this carries the seat or role that was ASKED for. */
  member: string;
  /** True when this session re-occupied a seat it already held rather than claiming a new one. */
  reused: boolean;
  /**
   * ADR 095: set when the caller asked not to block (`wait: 0`) and the server opened an approval
   * request instead of seating. **The seat is not held.** The socket stays parked, so a later
   * approval occupies in the background and the next `team_join` reports already-joined; nothing is
   * persisted here, because a binding written now would claim an identity this session does not have.
   */
  pending?: { requestId: string | null };
}

export class ClaimConflictError extends Error {
  constructor(
    message: string,
    readonly claimable: string[],
  ) {
    super(message);
    this.name = 'ClaimConflictError';
  }
}

/**
 * Claim a seat (or pool seat) via the v0.3 handshake (ADR 075) and occupy it. Points the session's
 * claim policy at the target, `join()`s — which sends the `claim` frame (team agent key + target) and
 * resolves on `occupied` (the server assigns a role pool's `<role>-<n>`) — then persists the resolved
 * seat into the workspace binding (ADR 018) + clears the pending marker. Shared by the `team_join` tool
 * and launch-time autojoin so both follow one path. Throws {@link ClaimConflictError} when the seat is
 * already occupied, or a plain error (refusal / network failure); the caller formats.
 */
export async function claimAndJoin(
  client: MusterdClient,
  config: McpConfig,
  target: ClaimTarget,
  waitMs?: number,
): Promise<ClaimResult> {
  const reused =
    client.claimed && 'seat' in target && client.member === target.seat && client.joined;
  if (reused) return { member: client.member!, reused: true };

  // Single-flight the claim (first live native wake, 2026-08-12). The `reused` guard above answers
  // "have we ALREADY claimed", which a second caller that arrives while the first claim is still in
  // flight passes straight through — and then the session claims its own seat twice. Measured: the
  // native loop's model issued `team_join` in PARALLEL with `team_inbox_check` in one assistant
  // turn; `AUTOJOIN_EXEMPT_TOOLS` correctly stopped the join itself from arming autojoin, but not
  // its sibling, so the explicit join and the implicit one raced. The server did its job —
  // `claim.duplicate_workspace`, then `claim.superseded {evicted:1}` — and the woken session
  // watched itself get evicted and declined to answer the act it was woken for.
  //
  // Keyed by target: two callers converging on the same seat share one claim, while a deliberate
  // re-target (a different seat or pool) is a distinct intent and still proceeds on its own.
  const key = targetKey(target);
  const pending = inFlight.get(client);
  if (pending && pending.key === key) return pending.promise;
  const promise = performClaim(client, config, target, waitMs).finally(() => {
    if (inFlight.get(client)?.promise === promise) inFlight.delete(client);
  });
  inFlight.set(client, { key, promise });
  return promise;
}

/** Claims in flight per client — the single-flight register (see {@link claimAndJoin}). */
const inFlight = new WeakMap<MusterdClient, { key: string; promise: Promise<ClaimResult> }>();

const targetKey = (t: ClaimTarget): string => ('seat' in t ? `seat:${t.seat}` : `role:${t.role}`);

async function performClaim(
  client: MusterdClient,
  config: McpConfig,
  target: ClaimTarget,
  waitMs?: number,
): Promise<ClaimResult> {
  // Re-read binding.json before an explicit named claim (#118 class / ADR 018 source-of-truth). The
  // boot config pins the grant + key read at launch, so an in-session binding *repair* — e.g. a
  // clobbered binding re-provisioned with `musterd agent <seat> --path <worktree>` — was invisible
  // until a full MCP reconnect: `team_join {as:X}` kept presenting the stale boot grant (and could
  // rejoin as the wrong seat). If the freshest on-disk binding now targets exactly this seat, adopt
  // its grant/key/surface so the repair takes effect without a process restart. A binding for a
  // *different* seat is left untouched — we never silently borrow another seat's grant.
  if ('seat' in target) {
    const fresh = findBinding(config.bindingDir);
    if (fresh && fresh.claim && fresh.claim.mode === 'seat' && fresh.claim.name === target.seat) {
      if (fresh.grant !== undefined) config.grant = fresh.grant;
      if (fresh.agent_key !== undefined) config.agent_key = fresh.agent_key;
      if (fresh.seat_credential !== undefined) config.seatCredential = fresh.seat_credential;
      if (fresh.session_lease !== undefined) config.sessionLease = fresh.session_lease;
      // Surface is NOT adopted from disk, ever (ADR 286): it is what the LAUNCHER declared for
      // THIS session, resolved once at startup. v2 identity files carry no surface to adopt.
    }
  }

  // Point the claim at the target; `join()` presents the agent key + this target and resolves the seat.
  // When no grant is present the server opens an approval request; `join()` parks on it up to `waitMs`
  // (ADR 087 — one blocking call through the single approval).
  config.claim =
    'seat' in target ? { mode: 'seat', name: target.seat } : { mode: 'role', role: target.role };
  try {
    const outcome = await client.join(waitMs, { parkOnPending: true });
    if (outcome === 'pending') {
      // Non-blocking return (ADR 095). Deliberately BEFORE persistBinding/clearPendingMarker: this
      // session holds no seat, and the pending marker is what a later `musterd claim --for <code>`
      // resolves against.
      return {
        member: 'seat' in target ? target.seat : target.role,
        reused: false,
        pending: { requestId: client.awaitingRequestId },
      };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/claim_conflict|conflict|occupied|busy/i.test(msg)) {
      const { members } = await client.roster();
      throw conflict('seat' in target ? target.seat : target.role, members);
    }
    throw err;
  }
  const member = client.member!;
  persistBinding(config, member);
  clearPendingMarker(config);
  return { member, reused: false };
}

/**
 * Adopt the seat an external `musterd claim --for <code>` resolved for this running session (ADR 034)
 * and go online — the live-delivery counterpart of {@link claimAndJoin}. This session holds the team
 * agent key, so it claims the resolved seat itself and persists. No-op once already joined.
 */
export async function adoptIdentity(
  client: MusterdClient,
  config: McpConfig,
  seat: string,
): Promise<void> {
  if (client.joined) return;
  config.claim = { mode: 'seat', name: seat };
  await client.join();
  persistBinding(config, client.member ?? seat);
  clearPendingMarker(config);
}

/** Persist the resolved seat as this folder's standing claim policy (so a re-launch re-occupies it). */
/**
 * Write a lease the daemon renewed over the socket (ADR 347) into the binding of the seat that holds
 * it — so a CLI hook in this worktree presents a live lease too — and nowhere else. Same seat on
 * disk, or nothing is written: an adapter whose binding was re-provisioned to another seat must not
 * hand that seat its authority.
 */
export function persistRenewedLease(config: McpConfig): void {
  if (!config.member || !config.bindingDir || !config.sessionLease) return;
  const onDisk = findBinding(config.bindingDir);
  if (!onDisk?.claim || onDisk.claim.mode !== 'seat' || onDisk.claim.name !== config.member) return;
  persistBinding(config, config.member);
}

function persistBinding(config: McpConfig, seat: string): void {
  const binding: Binding = {
    version: 2,
    server: config.server,
    team: config.team,
    ...(config.agent_key ? { agent_key: config.agent_key } : {}),
    ...(config.seatCredential ? { seat_credential: config.seatCredential } : {}),
    ...(config.sessionLease ? { session_lease: config.sessionLease } : {}),
    claim: { mode: 'seat', name: seat },
    ...(config.grant !== undefined ? { grant: config.grant } : {}),
    // Carry the attested model through the rewrite (ADR 101). `config.model` is the resolved ladder
    // (env > binding.json), so a re-claim re-persists what this occupancy attests instead of dropping
    // it — without this, every autojoin/reclaim silently wiped a `--model`-provisioned seat back to
    // `unknown` and the diversity flag went dark on the next boot.
    ...(config.model !== undefined ? { model: config.model } : {}),
    // The capabilities this occupancy resolved (ADR 144 inc 5) — cached for the NEXT session to scope
    // its tool surface at connect, exactly as `model` above is carried through for attestation.
    ...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
  };
  try {
    // Write back to the workspace this session was resolved from — NEVER ambient process.cwd(). An
    // adapter whose cwd wandered into a sibling worktree used to clobber that worktree's binding.json
    // with its own seat (byte-identical bindings, wrong-seat autojoin). `bindingDir` anchors the write.
    saveBinding(config.bindingDir, binding);
  } catch {
    // identity is held in memory for this session regardless of a binding write failure
  }
}

function conflict(name: string, members: { name: string }[]): ClaimConflictError {
  const taken = members.map((m) => m.name);
  return new ClaimConflictError(
    `"${name}" is already occupied and this session couldn't take it — ` +
      `pick another seat (team_join {as:'<name>'}) or claim a pool seat (team_join {role:'<role>'}).`,
    taken,
  );
}
