/**
 * Guardian tick + status (2026-08-13 guardian spec) — the pure-code on-call probe. The LaunchAgent
 * lifecycle reuses the autorefresh module verbatim (same ctx shape, same bootout/bootstrap retry);
 * this file owns what a tick DOES: collect → classify → act → stamp, with every effect injected so
 * the wiring is unit-testable and the real runners live in commands/service.ts.
 *
 * A tick must never throw: the guardian reporting nothing is a claim (wiki: instrument silence),
 * so every failure path degrades to a logged line and the stamp still records the tick.
 */
import { CliError, isConnRefused } from '../errors.js';
import {
  classify,
  indeterminate,
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
  type GuardianPolicyError,
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
  /**
   * ADR 432's discharge, with the real senders bound. Called on EVERY tick, healthy or not — the
   * healthy tick IS the observation that discharges a raise (ADR 438), so gating this on there
   * being something to act on is what kept a week-old raise open until an unrelated class happened
   * to fire beside it.
   */
  discharge: (
    firing: ReadonlySet<GuardianClass>,
    withheld: ReadonlySet<GuardianClass>,
    stamp: GuardianStamp,
  ) => Promise<GuardianStamp>;
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
   * or not. The arming decision reads a WEEK of these rows rather than the ADR — 30 days on
   * 2026-09-04, a week on nick's call the next day, pre-registered as
   * docs/watches/2026-09-05-adr-389-sampled-read.md with a volume floor — and
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
        entry: signals.stack.entry ?? null,
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
      lastPolicyReadAt:
        policy.source === 'team_policy' || policy.source === 'team_policy_unset'
          ? now
          : stamp.lastPolicyReadAt,
      lastPolicyErrorAt: null,
      lastPolicyError: null,
      policyDegradedSince: null,
    };
  } catch (e) {
    // The error is BOUND (lane 01M2NZDXPD). The bare catch that used to stand here discarded the
    // one object that knew why, at the only point it existed — so a dead daemon, a revoked
    // guardian token and a malformed policy body all produced the same byte-identical line, in the
    // component whose whole job is separating causes. The tier map decides whether a class reaches
    // a human at all, so falling back silently changes who gets woken and for what.
    //
    // NOT alertable, and that is a measurement rather than a preference: the live log holds ten of
    // these lines between 2026-08-20 and 2026-09-16, every one an isolated tick that recovered on
    // the next. A degrade that has never once persisted does not need its own GuardianClass and its
    // own ADR 274 damper; it needs to be legible, which is what `policyDegradedSince` and the
    // status line below make it. Revisit if a run ever outlives a handful of ticks.
    const failure = classifyPolicyError(e, now);
    tiers = DEFAULT_TIERS;
    const degradedSince = stamp.policyDegradedSince ?? now;
    stamp = {
      ...stamp,
      policySource: 'shipped_default_degraded',
      lastPolicyErrorAt: now,
      lastPolicyError: failure,
      policyDegradedSince: degradedSince,
    };
    d.log(
      `guardian.policy_unreadable ${JSON.stringify({
        source: 'shipped_default_degraded',
        reason: failure.reason,
        detail: failure.detail,
        degraded_for_ms: now - degradedSince,
      })}`,
    );
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

  // ADR 438: discharge runs on EVERY tick, outside the branch above. It used to live inside
  // `actOn`, which is reached only when something is firing — so the tick that observes health,
  // the one that IS the discharge, was the one tick that could not record it.
  //
  // AFTER `act`, deliberately: a class this tick raised must be in `firing`, or a raise would be
  // discharged by the same tick that made it.
  //
  // `classified`, not `incidents`: a DEFERRED sighting (ADR 274's unconfirmed outage) is filtered
  // out of `incidents` and is not evidence of health — discharging on it would close a raise on
  // the strength of an observation the classifier itself declined to trust.
  //
  // Skipped entirely under a handover, where `classified` is empty because the daemon is restarting
  // on purpose (ADR 274). That emptiness means "we know nothing this tick", and ADR 173's rule
  // applies to a guardian reading its own signals too: absent is unknown, never healthy.
  //
  // And the per-class version of that same rule rides beside it: `indeterminate` names the classes
  // whose evidence this tick could not read (ADR 435's `unknown`). They are absent from `classified`
  // for a reason that is not health, so they are withheld from the discharge rather than counted as
  // recovery — otherwise a trimmed build.log closes a real publisher_failed raise.
  if (!handoverDeferred) {
    try {
      stamp = await d.discharge(
        new Set(classified.map((i) => i.class)),
        new Set(indeterminate(signals)),
        stamp,
      );
    } catch (e) {
      d.log(`discharge failed (${String(e)}) — raises stay open; next tick retries`);
    }
  }

  if (dueDailyHeartbeat(stamp, now)) {
    await d.heartbeat().catch((e) => d.log(`heartbeat failed (${String(e)})`));
    stamp = { ...stamp, lastHeartbeatAt: now };
  }

  saveStamp(d.stampPath, recordTick(stamp, now));
  return 0;
}

/** Enough of the message to act on, bounded so one pathological error cannot own the log file. */
const POLICY_DETAIL_MAX = 200;

/**
 * Name the cause of a failed policy read, coarsely enough that each reason maps to a DIFFERENT
 * repair: start the daemon (`unreachable`), re-provision or re-mint the guardian seat
 * (`unauthorized`/`forbidden`), fix the policy body or the daemon's version of this route
 * (`malformed`). `unknown` carries the message rather than guessing — filing an unrecognised
 * failure under a recognised one is the defect this replaces, not a smaller version of it.
 *
 * NOT a reason: an absent policy. A team that has set no tiers returns 200 with nothing in it and
 * never reaches this function (see `team_policy_unset`) — that distinction is the difference
 * between a fresh install and a revoked token, and it used to be invisible.
 */
export function classifyPolicyError(e: unknown, now: number): GuardianPolicyError {
  const message = e instanceof Error ? e.message : String(e);
  const detail =
    message.length > POLICY_DETAIL_MAX ? `${message.slice(0, POLICY_DETAIL_MAX)}…` : message;
  const at = now;
  if (e instanceof CliError && e.code !== undefined) {
    switch (e.code) {
      case 'unauthorized':
      case 'expired_grant':
        return { reason: 'unauthorized', detail, at };
      case 'forbidden':
        return { reason: 'forbidden', detail, at };
      case 'validation':
      case 'bad_request':
      case 'version_mismatch':
        return { reason: 'malformed', detail, at };
      case 'hub_unreachable':
        return { reason: 'unreachable', detail, at };
      default:
        return { reason: 'unknown', detail, at };
    }
  }
  // Exit 7 is the client's own "can't reach the daemon" wrapper; the timeout shapes below are what
  // an aborted fetch looks like, and both mean the same repair.
  if (e instanceof CliError && e.exitCode === 7) return { reason: 'unreachable', detail, at };
  if (isConnRefused(e) || /abort|timed? ?out/i.test(message))
    return { reason: 'unreachable', detail, at };
  if (e instanceof SyntaxError) return { reason: 'malformed', detail, at };
  return { reason: 'unknown', detail, at };
}

/**
 * A pending clean-exit down sighting older than this is stale — the guardian was quiet in between,
 * so the next unreachable tick counts as a fresh first sighting rather than a confirmation.
 * 15 minutes ≈ 7 missed 2-minute ticks: generous against tick jitter, far below any real outage.
 */
export const PENDING_DOWN_MAX_AGE_MS = 15 * 60_000;

/** Stamp staleness past this is loud in `service status` — 5 missed 2-minute ticks. */
export const GUARDIAN_STALE_MS = 10 * 60_000;

/**
 * Which tier map is in force, and — when it is not the team's — why not, so the question is
 * answerable from `musterd service status` instead of by reading a log file (lane 01M2NZDXPD §3).
 */
function policyStatus(s: GuardianStamp, now: number): string {
  switch (s.policySource) {
    case 'team_policy':
      return 'policy team';
    case 'team_policy_unset':
      return 'policy defaults (team has set no tiers)';
    case 'shipped_default_degraded': {
      const since = s.policyDegradedSince ?? s.lastPolicyErrorAt ?? now;
      const why = s.lastPolicyError
        ? `${s.lastPolicyError.reason}: ${s.lastPolicyError.detail}`
        : 'cause not recorded (stamp predates the bound error)';
      return `policy defaults — degraded since ${new Date(since).toISOString()} (${why})`;
    }
    default:
      return 'policy defaults (guardian unprovisioned)';
  }
}

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
  const policy = policyStatus(s, now);
  return `guardian: last tick ${ageStr} ago, ${incident}; ${policy}${stale}`;
}
