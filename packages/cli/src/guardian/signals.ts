/**
 * Guardian signal collection — every source injected, every read recency-keyed
 * (spec §3: classify only from live /health, launchctl, and log lines newer than daemon boot).
 *
 * The collector owns staleness so classify.ts never sees a stale line: readSince is always
 * anchored at the daemon's boot instant, and when an older daemon omits `booted_at` we anchor at
 * `now` — under-reporting is safe (a missed incident on a skewed daemon), a stale line is not
 * (the 8-day-old-log ghost paged a human for an incident that ended a week ago).
 */
import type { GuardianSignals } from './classify.js';

export interface HealthPayload {
  ok: boolean;
  db: string;
  schema: number;
  booted_at?: number;
  /** The commit the daemon booted from (ADR 130) — the guardian's rollback target when healthy. */
  build?: string;
}

/**
 * The bound on the ONE confirming probe, and the whole point of it: a different bound is a
 * different observation. Derived from measurement rather than taste — /health latency is bursty and
 * load-correlated (2026-08-21, live daemon: 25 samples under load gave p50 2.8 ms, p90 16 ms, max
 * 3.22 s; 90 samples while quiet gave max 0.02 s), so 10 s is ~3x the worst answer yet observed and
 * still a fraction of the ~120 s tick. Revisit it if a raise ever shows this probe failing on a
 * daemon later found healthy — that is the falsifier, and it is cheap to run.
 */
export const CONFIRM_TIMEOUT_MS = 10_000;

export interface SignalDeps {
  now: () => number;
  /** GET /health on the explicitly configured server (#780: name the server you measured). */
  fetchHealth: () => Promise<HealthPayload>;
  /**
   * The same GET, on a bound the COLLECTOR dictates rather than the caller.
   *
   * Taking `timeoutMs` as an argument is what makes the bound reported in the raise true by
   * construction: if the caller chose it, a wiring that quietly passed the short bound would still
   * produce evidence claiming the long one, and the raise would assert a discrimination that never
   * happened.
   *
   * REQUIRED, deliberately. As an optional dep a forgotten wiring would degrade in silence — the
   * guardian back to calling every slow tick an outage, with nothing to show it had stopped
   * confirming. Required makes every caller, and every fixture, say what the long probe does.
   */
  confirmHealth: (timeoutMs: number) => Promise<HealthPayload>;
  /** Delay between outage-confirmation probes. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** `launchctl print gui/<uid>/<daemon label>` raw output; '' when the call fails. */
  launchctlPrint: () => Promise<string>;
  /** Lines of `path` whose timestamp is at/after `epochMs`. */
  readSince: (path: string, epochMs: number) => Promise<string[]>;
  /** mtime of `path` in epoch ms, null when absent. */
  statMtime: (path: string) => Promise<number | null>;
  /** What THIS build expects — drift is measured against the probe's own code. `schema: null`
   *  skips the drift check (the CLI has no compiled-in schema constant to compare against yet). */
  expected: { dbPath: string; schema: number | null };
  daemonErrLogPath: string;
  publisherBuildLogPath: string;
  /** Stamp updated on the last successful /live publish. */
  publisherOkStampPath: string;
  /** Newest guardian/autorefresh refresh instant, from the shared stamp; null when none. */
  lastRefreshAt: () => Promise<number | null>;
  /** ADR 274's explicit, bounded daemon-restart state. Read only after a confirmed health miss. */
  readHandover?: () => Promise<Exclude<GuardianSignals['handover'], undefined>>;
}

/** Tolerant parse of `launchctl print` — absent fields are zeros, never a throw. */
export function parseLaunchctlPrint(out: string): { lastExit: number; runs: number } {
  const runs = /runs\s*=\s*(\d+)/.exec(out);
  const exit = /last exit code\s*=\s*(\d+)/.exec(out);
  return { lastExit: exit ? Number(exit[1]) : 0, runs: runs ? Number(runs[1]) : 0 };
}

export async function collectSignals(d: SignalDeps): Promise<GuardianSignals> {
  const now = d.now();

  let health: GuardianSignals['health'] = null;
  let bootedAt = now; // no reachable daemon / no booted_at → nothing is "since boot"
  // One failed request is a transport observation, not an outage. Confirm it inside this tick so
  // transient handovers do not enter the daemon_down classifier (ADR 274).
  // Kept, never swallowed: the reason the LAST attempt failed, and how many were made. The bare
  // `catch {}` that used to stand here is why 22 daemon_down raises were byte-identical and none
  // could be adjudicated — the same defect as Chrome's stderr discarded by `stdio: 'ignore'` (#894).
  let probe: GuardianSignals['healthProbe'];
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    attempts = attempt + 1;
    try {
      const h = await d.fetchHealth();
      bootedAt = h.booted_at ?? now;
      health = {
        ok: h.ok,
        bootedAt,
        schemaOk: d.expected.schema === null || h.schema === d.expected.schema,
        dbPathExpected: h.db === d.expected.dbPath,
      };
      probe = undefined;
      break;
    } catch (err) {
      // One line, bounded: this rides an alert body, and an unbounded stack would bury the reason.
      probe = {
        attempts,
        lastError: (err instanceof Error ? err.message : String(err))
          .replace(/\s+/g, ' ')
          .slice(0, 200),
      };
      if (attempt < 2) await (d.sleep?.(1_000) ?? Promise.resolve());
    }
  }

  /**
   * ADR 274 confirms an unreachable /health with two further probes — but all three share the short
   * bound, so inside one stall they are ONE observation repeated, not three. Repeating the
   * measurement under question can only restate it; separating slow from down needs a DIFFERENT
   * bound, which is what this is.
   *
   * Run unconditionally rather than gated on the error's shape. The shape does discriminate
   * ("fetch failed" = nothing listening, "aborted due to timeout" = listening but slow, verified
   * 2026-08-21) and that is what diagnosed the six false alarms — but it is not worth gating on: a
   * refused connection fails this probe in about a millisecond, so a real outage pays nothing,
   * while a shape regex would be one more thing to be wrong about a failure mode nobody has met
   * yet. The error shape says which hypothesis is worth testing; the probe is what tests it.
   *
   * A wedged daemon — process alive, socket listening, event loop stuck — answers neither bound and
   * still reports down, which is the property that keeps this a discrimination rather than a
   * blindfold.
   */
  if (health === null) {
    try {
      const h = await d.confirmHealth(CONFIRM_TIMEOUT_MS);
      bootedAt = h.booted_at ?? now;
      health = {
        ok: h.ok,
        bootedAt,
        schemaOk: d.expected.schema === null || h.schema === d.expected.schema,
        dbPathExpected: h.db === d.expected.dbPath,
      };
      // Nothing survives a successful confirm: there is no incident left for a human to adjudicate.
      probe = undefined;
    } catch (err) {
      if (probe !== undefined) {
        probe = {
          ...probe,
          confirmMs: CONFIRM_TIMEOUT_MS,
          confirmError: (err instanceof Error ? err.message : String(err))
            .replace(/\s+/g, ' ')
            .slice(0, 200),
        };
      }
    }
  }

  const launchd = parseLaunchctlPrint(await d.launchctlPrint().catch(() => ''));

  const errLines = await d.readSince(d.daemonErrLogPath, bootedAt).catch(() => []);

  // A publisher failure is fresh only while the failure log is newer than the last success stamp.
  const buildMtime = await d.statMtime(d.publisherBuildLogPath).catch(() => null);
  const okMtime = await d.statMtime(d.publisherOkStampPath).catch(() => null);
  const failLines =
    buildMtime !== null ? await d.readSince(d.publisherBuildLogPath, bootedAt).catch(() => []) : [];
  const freshFailure =
    failLines.some((l) => /error|failed/i.test(l)) &&
    buildMtime !== null &&
    (okMtime === null || buildMtime > okMtime);

  const httpErrorRateSinceBoot = errLines.filter(
    (l) => /"status":5\d\d/.test(l) || /musterd\.errors/.test(l),
  ).length;
  const handover =
    health === null && d.readHandover ? await d.readHandover().catch(() => null) : null;

  return {
    now,
    health,
    ...(probe !== undefined ? { healthProbe: probe } : {}),
    handover,
    launchd,
    publisherLog: { freshFailure },
    errLinesSinceBoot: errLines.length,
    httpErrorRateSinceBoot,
    reaperStormSinceBoot: errLines.filter((l) => /presence\.reaped/.test(l)).length >= 10,
    lastRefreshAt: await d.lastRefreshAt().catch(() => null),
  };
}
