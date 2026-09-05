/**
 * Guardian tick + status (2026-08-13 guardian spec) — the pure-code on-call probe. The LaunchAgent
 * lifecycle reuses the autorefresh module verbatim (same ctx shape, same bootout/bootstrap retry);
 * this file owns what a tick DOES: collect → classify → act → stamp, with every effect injected so
 * the wiring is unit-testable and the real runners live in commands/service.ts.
 *
 * A tick must never throw: the guardian reporting nothing is a claim (wiki: instrument silence),
 * so every failure path degrades to a logged line and the stamp still records the tick.
 */
import {
  classify,
  DEFAULT_TIERS,
  type GuardianClass,
  type GuardianTier,
  type GuardianSignals,
  type Incident,
} from '../guardian/classify.js';
import {
  dueDailyHeartbeat,
  loadStamp,
  recordTick,
  saveStamp,
  type GuardianPolicySource,
  type GuardianStamp,
} from '../guardian/damp.js';

export interface GuardianTickDeps {
  now: () => number;
  stampPath: string;
  collect: () => Promise<GuardianSignals>;
  /** Tier map in force (policy over defaults), with the non-secret source exposed to status. */
  getTiers: () => Promise<GuardianPolicyRead>;
  /** `/health.build` when reachable — recorded on HEALTHY ticks as the crashloop rollback target. */
  healthBuild: () => Promise<string | null>;
  /** actOn with the real runners bound (commands/service.ts supplies them). */
  act: (
    incidents: Incident[],
    stamp: GuardianStamp,
    tiers: Record<GuardianClass, GuardianTier>,
  ) => Promise<{ stamp: GuardianStamp }>;
  /** The daily in-band heartbeat act (best-effort; unprovisioned seat = silent no-op). */
  heartbeat: () => Promise<void>;
  log: (line: string) => void;
}

export interface GuardianPolicyRead {
  tiers: Record<GuardianClass, GuardianTier>;
  source: Exclude<GuardianPolicySource, 'shipped_default_degraded'>;
}

export async function guardianTick(d: GuardianTickDeps): Promise<number> {
  const now = d.now();
  let stamp = loadStamp(d.stampPath);

  const signals = await d.collect();
  // Cross-tick outage confirmation (ADR 274 amendment): the stamp remembers a clean-exit
  // unreachable sighting so the classifier can tell "first sighting" (defer one tick — a stall
  // recovers before the next tick, an outage does not) from "persisted" (raise). A pending
  // sighting older than the freshness window is the guardian's OWN silence, not evidence about
  // the daemon — two observations that far apart are not one incident, so it re-arms.
  const pendingFresh =
    stamp.pendingDownSince != null && now - stamp.pendingDownSince <= PENDING_DOWN_MAX_AGE_MS
      ? stamp.pendingDownSince
      : null;
  signals.firstUnreachableAt = pendingFresh;
  const handoverDeferred =
    signals.health === null && signals.handover !== null && signals.handover !== undefined;
  const classified = handoverDeferred ? [] : classify(signals);
  if (handoverDeferred) d.log('guardian.handover_deferred');

  /**
   * ADR 389's Eval dataset, written on EVERY tick that reached the sample — armed or not, promoted
   * or not. The arming decision is supposed to read 30 days of these rows rather than the ADR, and
   * a row written only when the class was promoted would be a dataset of confirmations: the
   * sample that said "parked, not held", and the sample that could not be taken at all, are
   * exactly the rows that could talk anyone out of arming this.
   */
  if (signals.stack !== undefined) {
    d.log(
      `guardian.sampled ${JSON.stringify({
        taken: signals.stack.taken,
        wedged: signals.stack.wedged,
        frame: signals.stack.frame ?? null,
        share: signals.stack.share ?? null,
        samples: signals.stack.total ?? null,
        pid: signals.stack.pid ?? null,
        reason: signals.stack.reason ?? null,
        promoted: classified.some((i) => i.class === 'daemon_wedged'),
      })}`,
    );
  }

  const deferred = classified.filter((i) => i.defer === true);
  const incidents = classified.filter((i) => i.defer !== true);
  if (deferred.length > 0) {
    stamp = { ...stamp, pendingDownSince: pendingFresh ?? now };
    d.log(`guardian.down_deferred {"first_unreachable_at":${stamp.pendingDownSince}}`);
  } else if (signals.health !== null && stamp.pendingDownSince != null) {
    d.log(`guardian.stall_recovered {"unreachable_for_ms":${now - stamp.pendingDownSince}}`);
    stamp = { ...stamp, pendingDownSince: null };
  }

  let tiers: Record<GuardianClass, GuardianTier>;
  try {
    const policy = await d.getTiers();
    tiers = policy.tiers;
    stamp = {
      ...stamp,
      policySource: policy.source,
      lastPolicyReadAt: policy.source === 'team_policy' ? now : stamp.lastPolicyReadAt,
      lastPolicyErrorAt: null,
    };
  } catch {
    tiers = DEFAULT_TIERS;
    stamp = { ...stamp, policySource: 'shipped_default_degraded', lastPolicyErrorAt: now };
    d.log('guardian.policy_unreadable {"source":"shipped_default_degraded"}');
  }

  if (incidents.length === 0) {
    // Healthy: refresh the rollback target. Only here — a build sha observed mid-incident is
    // exactly the sha we must never roll back to.
    const build = await d.healthBuild().catch(() => null);
    if (build) stamp = { ...stamp, lastGoodBuild: build };
  } else {
    d.log(`incidents: ${incidents.map((i) => i.class).join(', ')}`);
    try {
      stamp = (await d.act(incidents, stamp, tiers)).stamp;
    } catch (e) {
      d.log(`act failed (${String(e)}) — will re-classify next tick`);
    }
  }

  if (dueDailyHeartbeat(stamp, now)) {
    await d.heartbeat().catch((e) => d.log(`heartbeat failed (${String(e)})`));
    stamp = { ...stamp, lastHeartbeatAt: now };
  }

  saveStamp(d.stampPath, recordTick(stamp, now));
  return 0;
}

/**
 * A pending clean-exit down sighting older than this is stale — the guardian was quiet in between,
 * so the next unreachable tick counts as a fresh first sighting rather than a confirmation.
 * 15 minutes ≈ 7 missed 2-minute ticks: generous against tick jitter, far below any real outage.
 */
export const PENDING_DOWN_MAX_AGE_MS = 15 * 60_000;

/** Stamp staleness past this is loud in `service status` — 5 missed 2-minute ticks. */
export const GUARDIAN_STALE_MS = 10 * 60_000;

/** One `service status` line: last tick age, last incident, staleness. Never throws. */
export function guardianStatusLine(stampPath: string, now: number): string {
  const s = loadStamp(stampPath);
  if (s.lastTickAt === null)
    return 'guardian: never ticked (installed? run: musterd service --guardian install)';
  const age = now - s.lastTickAt;
  const ageStr = age < 120_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)}m`;
  const incident = s.lastIncident
    ? `last incident ${s.lastIncident.class} at ${new Date(s.lastIncident.at).toISOString()}`
    : 'no incident';
  const stale = age > GUARDIAN_STALE_MS ? ' — STALE: the guardian itself needs attention' : '';
  const policy =
    s.policySource === 'team_policy'
      ? 'policy team'
      : s.policySource === 'shipped_default_degraded'
        ? `policy defaults — degraded since ${new Date(s.lastPolicyErrorAt ?? now).toISOString()}`
        : 'policy defaults (guardian unprovisioned)';
  return `guardian: last tick ${ageStr} ago, ${incident}; ${policy}${stale}`;
}
