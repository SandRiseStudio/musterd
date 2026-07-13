import type { WakeOrder, WakeReportBody } from '@musterd/protocol';

/**
 * The actuator seam (ADR 131 §7): the host loop drives this interface and knows nothing about CLI
 * flag shapes. `claude --resume` is backend #1, *not* the design — the native row (musterd's own
 * agent loop, increment 6) must be expressible as an in-process invocation with a trivial verify,
 * so anything a backend needs beyond "spawn-or-invoke in this workspace, under these bounds,
 * verified from the roster" belongs in the backend, not above it.
 */

/** Bounds for one wake run (ADR 131 §6). The watchdog timeout is the one universally enforceable
 *  bound and is mandatory; turn/budget caps apply where a backend supports them (deferred knobs). */
export interface WakeBounds {
  timeout_ms: number;
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

/**
 * A concluded actuation. `outcome` is ready as soon as the wake is *verified* (occupied on the
 * roster, or conclusively failed) so the loop reports inside the lease TTL; `settled` resolves when
 * the spawned run actually finishes (exit, or watchdog kill) — the host awaits it before exiting so
 * the mandatory watchdog can never be orphaned by a short-lived host process (`host --once`).
 */
export interface WakeActuation {
  outcome: WakeOutcome;
  settled: Promise<void>;
}

/** Host-side context a backend actuates with. Verification is roster-derived on purpose — headless
 *  modes hang and lie; process stdout is NEVER a verification source (ADR 131 §1). */
export interface BackendContext {
  /** Poll the roster (presence-neutral, agent-key) until the seat shows a live presence; resolves
   *  with how the occupancy attests (`provenance` should read `wake`) or `occupied: false` on
   *  window expiry. */
  verifyOccupied(seat: string): Promise<{ occupied: boolean; provenance?: string | null }>;
  /** One narrator line to the host's stdout (never per poll tick — telemetry carve-out). */
  log(line: string): void;
}

export interface ActuatorBackend {
  /** Harness class this backend actuates (matches the registry/enrollment `harness` field). */
  readonly harness: string;
  wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation>;
}
