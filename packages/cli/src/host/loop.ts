import {
  wakeabilityFromFacts,
  type MemberSummary,
  type WakeLeasesResponse,
  type WakeReportBody,
} from '@musterd/protocol';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { HttpClient } from '../client.js';
import { findBinding } from '../config.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../session/liveness.js';
import type { ActuatorBackend, WakeBounds, WakeOutcome } from './backend.js';
import { loadHostRegistry, type HostRegistryEntry } from './registry.js';

/**
 * The host poll loop (ADR 131 §1) — the actuator half of harness residency, in the `musterd notify`
 * resident-client shape: poll, presence-neutral, best-effort. Each tick reloads the machine-local
 * registry (so `residency on` takes effect without a restart), claims wake leases per
 * (server, team, enrolled-host-label), hands each order to its harness's {@link ActuatorBackend},
 * and reports the outcome inside the lease TTL.
 *
 * Credentials: the loop authenticates with the team agent key read *through each seat's workspace
 * binding* — the host is harness-side infrastructure, not a seat, and holds nothing centrally
 * (ADR 131 §1). The woken session occupies via the standing grant in its own binding; the loop
 * never touches it.
 *
 * Telemetry carve-out (ADR 131 O&E): narrator lines per *actuation* only — a quiet tick logs
 * nothing, ever.
 */

/** Roster polling cadence during verification. */
const VERIFY_POLL_MS = 2_000;
/** How long a spawn may take to appear on the roster. Under the 120s lease TTL with margin to
 *  report; a run that hasn't authenticated in this window is a failed wake. */
const VERIFY_WINDOW_MS = 90_000;

/** The slice of {@link HttpClient} the loop drives — injectable so tests never open a socket. */
export interface WakeClient {
  wakeLeases(team: string, host: string): Promise<WakeLeasesResponse>;
  wakeReport(team: string, body: WakeReportBody): Promise<unknown>;
  roster(team: string): Promise<{ members: MemberSummary[] }>;
}

export interface HostPollDeps {
  /** Backends by harness class. Inc 3 ships `claude-code`; the native loop is inc 6. */
  backends: Map<string, ActuatorBackend>;
  bounds: WakeBounds;
  log: (line: string) => void;
  /** Override every entry's enrolled host label (the `--host` flag). */
  hostLabel?: string;
  // ── injectables (tests) ──
  loadRegistry?: () => { entries: HostRegistryEntry[] };
  readAgentKey?: (workspace: string) => string | undefined;
  clientFor?: (server: string, agentKey: string) => WakeClient;
  liveness?: (workspace: string, harness?: string) => LocalSessionLiveness;
  verifyWindowMs?: number;
  verifyPollMs?: number;
}

/** One tick's result: how many orders were claimed, and the in-flight actuations (`host --once`
 *  awaits them so the mandatory watchdog is never orphaned by a short-lived host process). */
export interface HostPollResult {
  registered: number;
  orders: number;
  settled: Promise<void>[];
}

const defaultReadAgentKey = (workspace: string): string | undefined =>
  // Empty env on purpose: a `MUSTERD_BINDING` override in the host's own shell must not shadow
  // the *target workspace's* binding.
  findBinding(workspace, {})?.agent_key;

const defaultClientFor = (server: string, agentKey: string): WakeClient =>
  new HttpClient({ server, key: agentKey }).presenceNeutral();

/** Clock slack for the freshness bar: `last_seen_at` is daemon-stamped, `sinceTs` host-stamped —
 *  same machine today, but a couple of seconds of skew must not reject honest evidence. */
const VERIFY_FRESHNESS_SLACK_MS = 2_000;

/**
 * Roster-derived wake verification (never stdout): occupied when the seat shows presence touched
 * at-or-after `sinceTs` (the spawn) — live, or `reclaimable` (a run so fast the session already
 * exited; its presence row still carries a post-spawn `last_seen_at`). The freshness bar is
 * load-bearing (first live fallback rehearsal, 2026-07-13): a presence row lingering from a
 * PREVIOUS occupancy reads non-offline for minutes after the daemon's lease-eligibility read went
 * offline, and crediting it reported a dead resume child as `woke {session:resumed}` while the act
 * went unanswered. Returns the attested provenance so the backend can flag an adapter that isn't
 * stamping `wake` yet.
 */
async function verifyOccupied(
  client: WakeClient,
  team: string,
  seat: string,
  windowMs: number,
  pollMs: number,
  sinceTs: number,
): Promise<{ occupied: boolean; provenance?: string | null }> {
  const deadline = Date.now() + windowMs;
  const freshBar = sinceTs - VERIFY_FRESHNESS_SLACK_MS;
  // ADR 238: the newest non-wake occupancy seen so far. Held, not returned — see below.
  let otherOccupancy: { occupied: boolean; provenance?: string | null } | null = null;
  for (;;) {
    const roster = await client.roster(team).catch(() => null);
    const me = roster?.members.find((m) => m.name === seat);
    if (me) {
      const fresh = me.presences.filter((p) => p.last_seen_at >= freshBar);
      if (fresh.length > 0 && (me.presence !== 'offline' || me.reclaimable)) {
        const attested = fresh.find((p) => p.provenance === 'wake');
        if (attested) return { occupied: true, provenance: 'wake' };
        // ADR 238: a row belonging to ANOTHER live session is fresh by definition — its owner keeps
        // touching it — so the freshness bar above, which filters by time, cannot exclude it.
        // Returning here credited that row to this wake and judged the wake before our own adapter
        // had claimed: measured 2026-08-05, the codex adapter's `wake` row landed ~8s after spawn,
        // behind a `session` row that answered instantly. Keep waiting for OUR evidence; only when
        // the window is spent does the other session's occupancy become the answer — which the
        // backend reads as "someone else holds the seat" and defers on, never as this wake failing.
        otherOccupancy = { occupied: true, provenance: fresh[0]?.provenance ?? null };
      }
    }
    if (Date.now() >= deadline) return otherOccupancy ?? { occupied: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Group registry entries by the (server, team, host-label) tuple one lease poll covers. */
function pollGroups(
  entries: HostRegistryEntry[],
  hostLabel?: string,
): Map<string, { server: string; team: string; host: string; entries: HostRegistryEntry[] }> {
  const groups = new Map<
    string,
    { server: string; team: string; host: string; entries: HostRegistryEntry[] }
  >();
  for (const entry of entries) {
    const host = hostLabel ?? entry.host;
    const key = `${entry.server}\u0000${entry.team}\u0000${host}`;
    const group = groups.get(key) ?? { server: entry.server, team: entry.team, host, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/** One poll tick: lease → actuate → report, per group. Best-effort throughout — a failed group
 *  (unreachable daemon, missing key) is logged and skipped, never fatal to the resident loop. */
export async function pollHostOnce(deps: HostPollDeps): Promise<HostPollResult> {
  const registry = (deps.loadRegistry ?? loadHostRegistry)();
  const readAgentKey = deps.readAgentKey ?? defaultReadAgentKey;
  const clientFor = deps.clientFor ?? defaultClientFor;
  const settled: Promise<void>[] = [];
  let orders = 0;

  for (const group of pollGroups(registry.entries, deps.hostLabel).values()) {
    const keyed = group.entries
      .map((e) => ({ entry: e, key: readAgentKey(e.workspace) }))
      .filter((e): e is { entry: HostRegistryEntry; key: string } => e.key !== undefined);
    // `keyed` is not only how the group's auth key is picked — it is the set of entries whose
    // workspace is actually READABLE, which is a precondition for spawning into it at all. Dispatch
    // below resolves seats through this map rather than through `group.entries`, because a MIXED
    // group (one healthy seat, one whose worktree was deleted) keeps `keyed` non-empty and would
    // otherwise sail past the guard above and spawn with a `cwd` that does not exist.
    const spawnable = new Map(keyed.map((k) => [k.entry.seat, k.entry]));
    if (keyed.length === 0) {
      deps.log(
        `! no agent key readable for ${group.team} on ${group.server} — ` +
          `re-run \`musterd residency on\` in a seat's workspace`,
      );
      continue;
    }
    const client = clientFor(group.server, keyed[0]!.key);

    let response: WakeLeasesResponse;
    try {
      response = await client.wakeLeases(group.team, group.host);
    } catch (err) {
      deps.log(`! wake-lease poll failed for ${group.team}: ${(err as Error).message}`);
      continue;
    }

    for (const order of response.orders) {
      orders += 1;
      deps.log(
        `wake due: ${order.seat} [${order.lane}] — ${order.act ?? 'work_order'} from ${order.sender ?? 'board'} ` +
          `(lease ${order.lease_id})`,
      );
      const entry = spawnable.get(order.seat);
      // Every failed wake is loud HERE, in the one place every outcome funnels through, rather than
      // only on the actuation path. The pre-actuation branches below (no registry entry, dead
      // workspace, no backend) settle the lease and `continue` — before this, they did so with the
      // host log showing nothing but a placid "wake due", which is the exact failure mode ADR 179's
      // gate forbids ("a dead rail must be loud within one poll cycle"). A deferral is not a failure
      // and stays quiet: that is the local-session guard working as designed.
      const report = (outcome: WakeOutcome) => {
        if (!outcome.occupied && !outcome.deferred)
          deps.log(
            `! wake FAILED for ${order.seat} (${order.lane}): ` +
              `${outcome.reason ?? 'no reason reported'}`,
          );
        return client
          .wakeReport(group.team, { lease_id: order.lease_id, ...outcome })
          .catch((err: Error) =>
            deps.log(`! wake-report failed for lease ${order.lease_id}: ${err.message}`),
          );
      };

      if (!entry) {
        // Two distinct faults, told apart because the operator's next move differs. Registered but
        // unreadable is the stale-pointer case: an enrollment outlives the worktree it named (a
        // worktree created in the wrong place and later deleted, say), and the registry never
        // notices. Spawning anyway costs an attempt, fails ENOENT, and — because the only ENOENT
        // heal on the path is the one written for a moved `claude` binary — gets reported as a
        // stale binary. Three of those exhaust the act on a diagnosis that names the wrong thing.
        // ADR 189: same enum the wake pool marks with — dead workspace vs not on this host's
        // registry (cross-machine / never-registered mismatch).
        const registered = group.entries.find((e) => e.seat === order.seat);
        const wakeability = registered
          ? wakeabilityFromFacts({ enrolled: true, workspace_readable: false })
          : wakeabilityFromFacts({ enrolled: false });
        await report({
          occupied: false,
          wakeability,
          reason: registered
            ? `workspace ${registered.workspace} is missing or has no binding — the registry entry ` +
              `outlived it; re-run \`musterd residency on --as <admin>\` in the seat's real workspace`
            : 'seat not in this machine’s host registry — re-run `musterd residency on` in its workspace',
        });
        continue;
      }
      const backend = deps.backends.get(entry.harness);
      if (!backend) {
        await report({
          occupied: false,
          reason: `no "${entry.harness}" backend on this host (increment 3 ships claude-code)`,
        });
        continue;
      }

      // The resident-loop telemetry carve-out (ADR 131 O&E): one `musterd.residency.wake` span per
      // ACTUATION — never per tick. A no-op tracer when telemetry is off (opt-in, ADR 115 shape).
      const span = trace.getTracer('musterd-host').startSpan('musterd.residency.wake', {
        attributes: {
          'musterd.seat': order.seat,
          'musterd.lane': order.lane,
          'musterd.act': order.act ?? 'work_order',
          'musterd.lease_id': order.lease_id,
          'musterd.harness': entry.harness,
        },
      });

      // The local-session guard (ADR 131 §5, increment 4): roster-offline ≠ workspace-idle. The
      // daemon leased on presence it can see; only this machine can see a session actively working
      // in the worktree (a daemon bounce dropped the WS once and the wake spawned a CONCURRENT
      // session beside a live human). A live capture ⇒ defer: settle the lease with
      // `deferred: true` — audited as `residency.wake_deferred`, burning no attempt/rate budget —
      // and let the daemon's snooze keep the seat un-leased while the session works.
      const live = deps.liveness
        ? deps.liveness(entry.workspace, entry.harness)
        : localSessionLiveness(entry.workspace, Date.now(), undefined, entry.harness);
      if (live.state === 'live') {
        deps.log(
          `wake deferred: ${order.seat} — a live local session holds ${entry.workspace} ` +
            `(transcript active); the act stays due`,
        );
        span.setAttribute('musterd.deferred', true);
        span.setStatus({ code: SpanStatusCode.OK });
        await report({ occupied: false, deferred: true, reason: 'local-session-live' });
        span.end();
        continue;
      }
      // Effective bounds (increment 5 / ADR 199): reply wakes only tighten the operator
      // `--timeout` ceiling. Work-orders use the seat's `work_timeout_ms` without that clamp —
      // a coding session under a 5m host flag must not silently die at 5m.
      const policyTimeout = order.bounds?.timeout_ms;
      const isWorkOrder = order.derivation === 'work_order';
      const timeoutMs =
        policyTimeout !== undefined
          ? isWorkOrder
            ? policyTimeout
            : Math.min(policyTimeout, deps.bounds.timeout_ms)
          : deps.bounds.timeout_ms;
      if (policyTimeout !== undefined && policyTimeout > deps.bounds.timeout_ms && !isWorkOrder)
        deps.log(
          `wake bounds: ${order.seat} policy timeout ${policyTimeout}ms clamped to the ` +
            `host's --timeout ${deps.bounds.timeout_ms}ms ceiling`,
        );
      if (isWorkOrder && policyTimeout !== undefined && policyTimeout > deps.bounds.timeout_ms)
        deps.log(
          `wake bounds: ${order.seat} work_order using policy timeout ${policyTimeout}ms ` +
            `(host --timeout ${deps.bounds.timeout_ms}ms is not a ceiling for work_orders)`,
        );
      const actuation = await backend.wake(
        {
          order,
          team: group.team,
          server: group.server,
          workspace: entry.workspace,
          bounds: {
            timeout_ms: timeoutMs,
            ...(order.bounds?.max_turns !== undefined ? { max_turns: order.bounds.max_turns } : {}),
            ...(order.bounds?.budget_usd !== undefined
              ? { budget_usd: order.bounds.budget_usd }
              : {}),
          },
        },
        {
          verifyOccupied: (seat, windowMs, sinceTs) =>
            verifyOccupied(
              client,
              group.team,
              seat,
              windowMs ?? deps.verifyWindowMs ?? VERIFY_WINDOW_MS,
              deps.verifyPollMs ?? VERIFY_POLL_MS,
              sinceTs ?? Date.now(),
            ),
          log: deps.log,
        },
      );
      span.setAttribute('musterd.occupied', actuation.outcome.occupied);
      if (actuation.outcome.reason) span.setAttribute('musterd.reason', actuation.outcome.reason);
      span.setStatus({
        code: actuation.outcome.occupied ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      // The loud-failure log for this outcome lives in `report` above, so every branch that settles
      // a lease — actuation and the pre-actuation bail-outs alike — is equally loud. It was here
      // alone until 2026-07-31, which is why a dead registry entry could fail three times in silence.
      await report(actuation.outcome);
      span.end();
      // The supplementary cost report (increment 5): harness-attested cost exists only at run
      // exit, long after the primary report settled the lease at verification — so the settled
      // completion posts a second report and the daemon records `residency.wake_cost`. Skipped
      // when the primary already carried the summary (fast-fail merge) — one record per lease.
      settled.push(
        actuation.settled.then(async (completion) => {
          if (!completion) return;
          if (completion.cost_usd === undefined && completion.duration_ms === undefined) return;
          if (
            actuation.outcome.cost_usd !== undefined ||
            actuation.outcome.duration_ms !== undefined
          )
            return;
          await client
            .wakeReport(group.team, {
              lease_id: order.lease_id,
              occupied: actuation.outcome.occupied,
              ...(actuation.outcome.delivery_outcome
                ? { delivery_outcome: actuation.outcome.delivery_outcome }
                : {}),
              ...(actuation.outcome.transcript_bytes !== undefined
                ? { transcript_bytes: actuation.outcome.transcript_bytes }
                : {}),
              ...(actuation.outcome.transcript_age_ms !== undefined
                ? { transcript_age_ms: actuation.outcome.transcript_age_ms }
                : {}),
              ...completion,
            })
            .then(() =>
              deps.log(
                `wake cost recorded for ${order.seat}: ` +
                  `$${completion.cost_usd?.toFixed(4) ?? '—'} (lease ${order.lease_id})`,
              ),
            )
            .catch((err: Error) =>
              deps.log(`! wake-cost report failed for lease ${order.lease_id}: ${err.message}`),
            );
        }),
      );
    }
  }

  return { registered: registry.entries.length, orders, settled };
}
