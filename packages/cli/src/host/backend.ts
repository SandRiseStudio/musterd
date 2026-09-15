import type { UnpricedReason, WakeOrder, WakeReportBody, WakeUsage } from '@musterd/protocol';

/**
 * The actuator seam (ADR 131 §7): the host loop drives this interface and knows nothing about CLI
 * flag shapes. `claude --resume` is backend #1, *not* the design — the native row (musterd's own
 * agent loop, increment 6) must be expressible as an in-process invocation with a trivial verify,
 * so anything a backend needs beyond "spawn-or-invoke in this workspace, under these bounds,
 * verified from the roster" belongs in the backend, not above it.
 */

/** Bounds for one wake run (ADR 131 §6). The watchdog timeout is the one universally enforceable
 *  bound and is mandatory; turn/budget caps apply where a backend supports them. Policy-supplied
 *  values arrive per-order (increment 5) and can only TIGHTEN the operator's local `--timeout`
 *  ceiling — the loop computes the effective minimum before the backend sees it. `budget_usd` is a
 *  report bound, not a kill switch: no backend can stop a run mid-flight on dollars. */
export interface WakeBounds {
  timeout_ms: number;
  max_turns?: number;
  budget_usd?: number;
}

/** Everything a backend may know about one wake: the daemon's order (structured fields only — no
 *  message bodies, ADR 088/128), the seat's workspace, and the bounds. */
export interface WakeSpec {
  order: WakeOrder;
  team: string;
  server: string;
  workspace: string;
  bounds: WakeBounds;
}

/** What one actuation produced — the `wake-report` body minus the lease id (the loop owns leases).
 *  `session` is the fresh-first doctrine's outcome axis; increment 4's resume upgrade adds
 *  `resumed`. */
export type WakeOutcome = Omit<WakeReportBody, 'lease_id'>;

/** What the settled run attested about itself (increment 5) — harness-reported cost/duration,
 *  known only at exit. The loop posts it as a SUPPLEMENTARY wake report (the daemon records
 *  `residency.wake_cost`); undefined when the run surfaced no summary. */
export interface WakeCompletion {
  cost_usd?: number;
  duration_ms?: number;
  /** ADR 364: tokens the harness printed at turn end; rides the supplementary report as-is. */
  usage?: WakeUsage;
  /** ADR 364: why `cost_usd` is absent — a fact about the harness's output, set by the adapter. */
  unpriced_reason?: UnpricedReason;
  /** ADR 364: a price the harness printed that the host cannot attest (opencode). */
  harness_cost_usd?: number;
}

/**
 * A concluded actuation. `outcome` is ready as soon as the wake is *verified* (occupied on the
 * roster, or conclusively failed) so the loop reports inside the lease TTL; `settled` resolves when
 * the spawned run actually finishes (exit, or watchdog kill) — the host awaits it before exiting so
 * the mandatory watchdog can never be orphaned by a short-lived host process (`host --once`) — and
 * carries the run's cost/duration summary for the supplementary report.
 */
export interface WakeActuation {
  outcome: WakeOutcome;
  settled: Promise<WakeCompletion | undefined>;
}

/** The roster-derived verdict on one wake (see {@link BackendContext.verifyOccupied}). */
export interface VerifyResult {
  occupied: boolean;
  provenance?: string | null;
  lease_matched?: boolean;
  own_unattested?: boolean;
}

/** Host-side context a backend actuates with. Verification is roster-derived on purpose — headless
 *  modes hang and lie; process stdout is NEVER a verification source (ADR 131 §1). */
export interface BackendContext {
  /** Poll the roster (presence-neutral, agent-key) until the seat shows a live presence; resolves
   *  with how the occupancy attests (`provenance` should read `wake`) or `occupied: false` on
   *  window expiry. `windowMs` shortens the poll window (default: the loop's full verify window) —
   *  a resume attempt (increment 4) verifies in a sub-window so a failure still leaves budget for
   *  the fresh fallback inside the same lease. `sinceTs` is the freshness bar (default: call time):
   *  only presence touched at-or-after it counts — a lingering presence row from a PREVIOUS
   *  occupancy can read non-offline for minutes after the daemon's lease-eligibility read went
   *  offline, and crediting it once reported a dead resume child as woke (first live fallback
   *  rehearsal, 2026-07-13). Backends pass their spawn timestamp.
   *
   *  `lease_matched` (ADR 241) is the one field that answers "is this occupancy MINE": true only
   *  when a fresh row attests this wake's own lease token. There is deliberately no parameter for
   *  it — the loop binds the lease it is actuating, so a backend cannot verify against any other.
   *  `occupied && !lease_matched` means the seat is held by a session this wake did not create,
   *  which is a deferral, never a failure.
   *
   *  `own_unattested` (ADR 379) is the one exception the loop is allowed to make to that reading:
   *  set only when the window expired with no lease-attesting row AND the freshest unattested row
   *  was created in THIS wake's workspace after THIS wake spawned (`attached_at`, `workspace`) —
   *  evidence the actuator already held, which until 2026-09-04 it never consulted before killing
   *  the child. A backend treats `lease_matched || own_unattested` as "mine" and does not kill;
   *  `lease_matched` alone still means the token matched. */
  verifyOccupied(seat: string, windowMs?: number, sinceTs?: number): Promise<VerifyResult>;
  /** One narrator line to the host's stdout (never per poll tick — telemetry carve-out). */
  log(line: string): void;
}

export interface ActuatorBackend {
  /** Harness class this backend actuates (matches the registry/enrollment `harness` field). */
  readonly harness: string;
  wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation>;
}
