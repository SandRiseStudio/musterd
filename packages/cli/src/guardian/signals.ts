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

export interface SignalDeps {
  now: () => number;
  /** GET /health on the explicitly configured server (#780: name the server you measured). */
  fetchHealth: () => Promise<HealthPayload>;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const h = await d.fetchHealth();
      bootedAt = h.booted_at ?? now;
      health = {
        ok: h.ok,
        bootedAt,
        schemaOk: d.expected.schema === null || h.schema === d.expected.schema,
        dbPathExpected: h.db === d.expected.dbPath,
      };
      break;
    } catch {
      if (attempt < 2) await (d.sleep?.(1_000) ?? Promise.resolve());
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
  const handover = health === null && d.readHandover ? await d.readHandover().catch(() => null) : null;

  return {
    now,
    health,
    handover,
    launchd,
    publisherLog: { freshFailure },
    errLinesSinceBoot: errLines.length,
    httpErrorRateSinceBoot,
    reaperStormSinceBoot: errLines.filter((l) => /presence\.reaped/.test(l)).length >= 10,
    lastRefreshAt: await d.lastRefreshAt().catch(() => null),
  };
}
