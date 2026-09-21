/**
 * Guardian damping + heartbeat state (spec §5–§6). Lives in a local JSON stamp file, never the
 * DB — the DB may be the thing that is down, and a count kept in the thing being watched cannot
 * survive the outage it is counting.
 *
 * Two dampers, on the two ways a guardian can become the noise it exists to detect:
 *
 * - ACTING. A guardian that bounces a crashlooping daemon every two minutes IS the crashloop;
 *   one attempt per class per hour (`shouldAttempt`), then the caller escalates.
 * - SPEAKING. A guardian that says the same sentence every tick trains its readers to clear it on
 *   sight, which is what makes the one true raise dangerous. One raise per unchanged reason per
 *   hour (`shouldRaise`), repeats counted and carried on the next one that fires.
 *
 * `shouldAttempt` guarded only the first of those until 2026-08-21, so the alert tier — where
 * `daemon_down` lives — had no damper at all: 30 raises all-time carrying 4 distinct bodies, five
 * of them byte-identical inside 33 minutes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GuardianClass } from './classify.js';

export const ATTEMPT_WINDOW_MS = 3_600_000;
/** How long an unchanged raise reason stays quiet after it has been said once. */
export const RAISE_WINDOW_MS = 3_600_000;
export const HEARTBEAT_INTERVAL_MS = 24 * 3_600_000;

export type GuardianPolicySource =
  | 'team_policy'
  /**
   * The read SUCCEEDED and the team has set no tier overrides — the expected state of a fresh
   * install. Its own value because `team_policy` claimed a dial nobody had turned (ADR 173: absent
   * is not unknown), which made "nothing configured" unreadable from both the stamp and status.
   */
  | 'team_policy_unset'
  | 'shipped_default_unprovisioned'
  | 'shipped_default_degraded';

/**
 * Why a policy read failed, as coarse as it can be while still separating the causes that call for
 * DIFFERENT repairs: start the daemon / re-provision the guardian seat / fix the policy body.
 * `unknown` is deliberate and load-bearing — a reason we cannot name must not be filed under one we
 * can (wiki: cannot-separate-two-causes).
 */
export type GuardianPolicyErrorReason =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'malformed'
  | 'unknown';

/** The bound error, kept verbatim-ish so the stamp answers "why" without a log archaeology trip. */
export interface GuardianPolicyError {
  reason: GuardianPolicyErrorReason;
  /** The error's own message, truncated. Never the credential — no error path here carries one. */
  detail: string;
  at: number;
}

/**
 * What was last said about a class, so the same sentence is not said twice.
 *
 * `raisedAt` is the raise that actually reached a human — suppression moves `lastSeenAt` and never
 * `raisedAt`, because a window that slid on every suppressed tick would go quiet forever while a
 * real outage persisted.
 */
export interface RaiseMemo {
  /** The full raise text, compared verbatim. Stored raw rather than hashed: a stamp nobody can
   *  read is how 22 undiagnosable raises happened in the first place. */
  reason: string;
  raisedAt: number;
  lastSeenAt: number;
  /** Identical raises withheld since `raisedAt`. Rides the next re-raise so the series is visible. */
  suppressed: number;
  /**
   * The act id of the raise that reached the team — what a later discharge closes (ADR 432).
   *
   * Guardian cannot `accept` its own ask (ADR 232 bars a service seat from the peer verbs), so the
   * discharge it CAN express is a `resolve` on the ask's thread (ADR 025), and a resolve must name
   * the thread it closes. Without the id there is nothing to name. Absent from stamps written
   * before this existed and from a raise whose send did not report an id — treated as "no thread to
   * close", which degrades to the pre-432 behaviour (the ask stays owed) rather than to a wrong
   * close.
   */
  actId?: string | null;
}

export interface GuardianStamp {
  lastAttemptAt: Partial<Record<GuardianClass, number>>;
  /** Per-class raise memory. Absent from stamps written before this existed — treated as empty. */
  lastRaise: Partial<Record<GuardianClass, RaiseMemo>>;
  lastTickAt: number | null;
  lastHeartbeatAt: number | null;
  lastIncident: { class: GuardianClass; at: number } | null;
  /** `/health.build` from the newest HEALTHY tick — the crashloop rollback target (`refresh --pin`). */
  lastGoodBuild: string | null;
  /**
   * When a tick first found /health unreachable with a clean launchd exit — the maybe-just-stalled
   * shape. Held here so the NEXT tick can confirm before anything raises; cleared by any healthy
   * tick. Absent from stamps written before this existed — treated as null.
   */
  pendingDownSince?: number | null;
  /** The last successfully observed policy source, never its secret-bearing body. */
  policySource: GuardianPolicySource;
  lastPolicyReadAt: number | null;
  lastPolicyErrorAt: number | null;
  /**
   * The last policy failure WITH its cause. `lastPolicyErrorAt` above is kept beside it (and stays
   * the field status reads for the timestamp) so stamps written before this existed still render.
   * Absent from those older stamps — treated as null.
   */
  lastPolicyError?: GuardianPolicyError | null;
  /**
   * When the CURRENT run of degraded ticks began — not the last failure. A single tick that fails
   * and recovers is a blip; the same read failing for a day is a condition, and only this field can
   * tell them apart. Cleared by any successful read. Absent from older stamps — treated as null.
   */
  policyDegradedSince?: number | null;
}

export function emptyStamp(): GuardianStamp {
  return {
    lastAttemptAt: {},
    lastRaise: {},
    lastTickAt: null,
    lastHeartbeatAt: null,
    lastIncident: null,
    lastGoodBuild: null,
    pendingDownSince: null,
    policySource: 'shipped_default_unprovisioned',
    lastPolicyReadAt: null,
    lastPolicyErrorAt: null,
    lastPolicyError: null,
    policyDegradedSince: null,
  };
}

export function loadStamp(path: string): GuardianStamp {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardianStamp>;
    return { ...emptyStamp(), ...parsed };
  } catch {
    return emptyStamp();
  }
}

export function saveStamp(path: string, s: GuardianStamp): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 1));
}

/**
 * Forget the open raise for a class whose condition has cleared (ADR 432).
 *
 * The inverse of {@link recordRaise}, and the half that never existed. Guardian is a `service` seat
 * and ADR 232 bars it from the peer verbs, so it can raise an obligation and can never accept one —
 * not even its own. The only actor that knows the condition cleared is the one actor the protocol
 * forbids from saying so, which is why 55 `daemon_down`/`daemon_wedged` asks sat unanswered on the
 * hub daemon on 2026-09-21, 30 of them from August.
 *
 * Dropping the memo also un-damps the class: a recurrence after a recovery is NEWS, not a repeat,
 * and must not be withheld against a reason nobody is still owed.
 */
export function clearRaise(s: GuardianStamp, cls: GuardianClass): GuardianStamp {
  if (s.lastRaise[cls] === undefined) return s;
  const lastRaise = { ...s.lastRaise };
  delete lastRaise[cls];
  return { ...s, lastRaise };
}

export function shouldAttempt(s: GuardianStamp, cls: GuardianClass, now: number): boolean {
  const last = s.lastAttemptAt[cls];
  return last === undefined || now - last >= ATTEMPT_WINDOW_MS;
}

export function recordAttempt(s: GuardianStamp, cls: GuardianClass, now: number): GuardianStamp {
  return {
    ...s,
    lastAttemptAt: { ...s.lastAttemptAt, [cls]: now },
    lastIncident: { class: cls, at: now },
  };
}

/** The comparison key for a raise: same class, same words, same evidence = same raise. */
export function raiseReason(cls: GuardianClass, why: string, evidence?: string): string {
  return `${cls}\n${why}\n${evidence ?? ''}`;
}

/**
 * A raise fires when it is new, when its reason has CHANGED — a different probe error or run count
 * is information a human has not seen — or when the window since the last firing has run out.
 */
export function shouldRaise(
  s: GuardianStamp,
  cls: GuardianClass,
  reason: string,
  now: number,
): boolean {
  const memo = s.lastRaise[cls];
  if (memo === undefined || memo.reason !== reason) return true;
  return now - memo.raisedAt >= RAISE_WINDOW_MS;
}

export function recordRaise(
  s: GuardianStamp,
  cls: GuardianClass,
  reason: string,
  now: number,
  /** The act id the raise landed as, when the send reported one (ADR 432) — the thread a later
   *  discharge closes. Optional so every existing caller and older stamp still type and read. */
  actId?: string | null,
): GuardianStamp {
  return {
    ...s,
    lastRaise: {
      ...s.lastRaise,
      [cls]: { reason, raisedAt: now, lastSeenAt: now, suppressed: 0, actId: actId ?? null },
    },
  };
}

/** Count a withheld repeat. A no-op if nothing was ever raised for the class. */
export function recordSuppressed(s: GuardianStamp, cls: GuardianClass, now: number): GuardianStamp {
  const memo = s.lastRaise[cls];
  if (memo === undefined) return s;
  return {
    ...s,
    lastRaise: {
      ...s.lastRaise,
      [cls]: { ...memo, lastSeenAt: now, suppressed: memo.suppressed + 1 },
    },
  };
}

export function recordTick(s: GuardianStamp, now: number): GuardianStamp {
  return { ...s, lastTickAt: now };
}

export function dueDailyHeartbeat(s: GuardianStamp, now: number): boolean {
  return s.lastHeartbeatAt === null || now - s.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS;
}
