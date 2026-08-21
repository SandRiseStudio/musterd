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
  | 'shipped_default_unprovisioned'
  | 'shipped_default_degraded';

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
  /** The last successfully observed policy source, never its secret-bearing body. */
  policySource: GuardianPolicySource;
  lastPolicyReadAt: number | null;
  lastPolicyErrorAt: number | null;
}

export function emptyStamp(): GuardianStamp {
  return {
    lastAttemptAt: {},
    lastRaise: {},
    lastTickAt: null,
    lastHeartbeatAt: null,
    lastIncident: null,
    lastGoodBuild: null,
    policySource: 'shipped_default_unprovisioned',
    lastPolicyReadAt: null,
    lastPolicyErrorAt: null,
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
): GuardianStamp {
  return {
    ...s,
    lastRaise: { ...s.lastRaise, [cls]: { reason, raisedAt: now, lastSeenAt: now, suppressed: 0 } },
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
