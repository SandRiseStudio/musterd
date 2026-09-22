/**
 * Guardian incident classification — pure decision ladder over recency-keyed signals
 * (spec: docs/superpowers/specs/2026-08-13-platform-guardian-design.md §3–§4).
 *
 * Every input is already boot-filtered by the collector (signals.ts): a signal here is fresh by
 * construction, so classification never has to reason about staleness — that is the whole
 * defense against the 8-day-old-log ghost the seed recorded.
 */

import type { GuardianClass, GuardianTier, GuardianTiers } from '@musterd/protocol';
import { describeSample, type StackSample } from './sample.js';

export type { GuardianClass, GuardianTier };

/**
 * The publisher's last completed outcome (ADR 435). `unknown` means the log did not say — a build
 * still in flight, a log trimmed past its last outcome line, a publisher that has never run — and
 * it is NOT `published`: ADR 173's rule, absent is unknown, never zero.
 */
export type PublisherOutcome = 'published' | 'failed' | 'unknown';

export interface Incident {
  class: GuardianClass;
  /**
   * Why this classification fired, in the raise itself.
   *
   * Measured 2026-08-19: all 22 `daemon_down` raises ever written were byte-identical
   * ("guardian: daemon_down — needs a human"), so establishing whether any of them was a real
   * outage meant hand-written SQL and a manual probe. A raise nobody can adjudicate trains seats
   * to clear it on sight, which is precisely what makes the one real outage dangerous.
   */
  evidence?: string;
  /**
   * Do not act yet: hold this incident for the next tick to confirm. Only the clean-exit
   * daemon_down shape sets it — the shape a merely-stalled daemon presents (see below).
   */
  defer?: true;
}

export interface GuardianSignals {
  now: number;
  /** null = /health unreachable. */
  health: { ok: boolean; bootedAt: number; schemaOk: boolean; dbPathExpected: boolean } | null;
  /** Why the probe gave up, present only when `health` is null. The probe's three attempts used to
   *  be swallowed by a bare `catch {}`, which is why no `daemon_down` raise could ever be
   *  diagnosed after the fact. */
  healthProbe?: {
    attempts: number;
    lastError: string;
    /** The bound on the ONE confirming probe, present only when that probe also failed. */
    confirmMs?: number;
    confirmError?: string;
  };
  /** A current autorefresh restart. Only suppresses a confirmed unavailable health result. */
  handover?: { startedAt: number; targetBuild: string } | null;
  launchd: { lastExit: number; runs: number };
  /**
   * What the publisher last finished doing, as a THREE-state answer (ADR 435). `unknown` is its own
   * state and must stay one all the way to the discharge: folding it into "not failed" is how an
   * unreadable log came to read as health — see {@link indeterminate}.
   */
  publisherLog: { outcome: PublisherOutcome };
  errLinesSinceBoot: number;
  httpErrorRateSinceBoot: number;
  reaperStormSinceBoot: boolean;
  /** Newest refresh/restart the guardian or autorefresh performed; null if none known. */
  lastRefreshAt: number | null;
  /**
   * When a PREVIOUS tick first found /health unreachable with a clean launchd exit — injected by
   * the tick from its stamp, never by the collector. Absent/null = this tick is the first sighting.
   */
  firstUnreachableAt?: number | null;
  /**
   * The bounded stack sample of the live pid (ADR 389 §1), present only on a tick that reached the
   * clean-exit-unreachable shape. Absent means no sample was attempted; `taken: false` means one
   * was attempted and could not be read — and both degrade to `daemon_down`, never past it.
   */
  stack?: StackSample;
  /**
   * The machine's 1-minute load average against its core count (lane 01M2GTB0RA). Absent on a
   * build that wires no reader; the classifier then degrades to the sample-only rule.
   */
  load?: { one: number; cores: number };
}

/**
 * Above this many runnable tasks per core the machine, not the daemon, owns the stall. 2× is
 * deliberately coarse: the six measured pages sat at 2.0–3.6× (16–29 on 8 cores), and a laptop
 * merely busy sits under 1×.
 */
export const STARVED_LOAD_PER_CORE = 2;

/** A crashloop is only attributed to a refresh that happened inside this window. */
export const CRASHLOOP_REFRESH_WINDOW_MS = 30 * 60_000;

/** 5xx/`musterd.errors` lines since boot before `error_rate` fires — one bad request is not an
 * incident on a single-laptop deployment; a steady stream since boot is. */
export const ERROR_RATE_FLOOR = 25;

/** Spec §4 shipped defaults — the policy knob (guardian_tiers) overrides per class. */
export const DEFAULT_TIERS: Record<GuardianClass, GuardianTier> = {
  publisher_failed: 'auto',
  crashloop: 'auto',
  daemon_down: 'alert',
  // Ships dark (ADR 389 §3): arming the first DESTRUCTIVE remediation must not be one line of
  // policy away from a machine that has never watched it fire — and the tier alone still would not
  // be enough, because §4's ladder is a second, independent condition.
  daemon_wedged: 'alert',
  daemon_starved: 'observe',
  schema_drift: 'alert',
  wrong_db: 'alert',
  error_rate: 'alert',
  presence_churn: 'alert',
};

/** Tier map in force: policy's sparse overrides over the shipped defaults (ADR 185 read-time). */
export function resolveGuardianTiers(
  policyTiers: GuardianTiers | undefined,
): Record<GuardianClass, GuardianTier> {
  return { ...DEFAULT_TIERS, ...(policyTiers ?? {}) };
}

export function classify(s: GuardianSignals): Incident[] {
  const auto: Incident[] = [];
  const alert: Incident[] = [];

  const recentRefresh =
    s.lastRefreshAt !== null && s.now - s.lastRefreshAt <= CRASHLOOP_REFRESH_WINDOW_MS;

  if (s.health === null) {
    // Down. Attributable to a fresh refresh (climbing runs + fresh err output) → crashloop
    // (auto: restart last-known-good); otherwise an unexplained daemon_down (alert).
    // What the probe actually saw, carried into the raise. Without it the two branches below —
    // genuinely different situations — produced byte-identical alerts, and 22 of them did.
    // Both bounds, when both were spent. Two probes on the SAME bound inside one stall are one
    // observation repeated; naming the second bound is what lets a reader see that "merely slow"
    // was tested and ruled out, rather than assumed away.
    const probe =
      s.healthProbe === undefined
        ? '/health unreachable (no probe detail recorded)'
        : `/health did not answer in ${s.healthProbe.attempts} attempts (${s.healthProbe.lastError})` +
          (s.healthProbe.confirmMs !== undefined
            ? `, nor a confirming probe bounded at ${s.healthProbe.confirmMs}ms (${s.healthProbe.confirmError})`
            : '');

    if (recentRefresh && s.launchd.runs > 1 && s.errLinesSinceBoot > 0) {
      auto.push({ class: 'crashloop' });
    } else if (s.launchd.lastExit !== 0) {
      alert.push({
        class: 'daemon_down',
        evidence: `launchd reports exit ${s.launchd.lastExit} after ${s.launchd.runs} runs; ${probe}`,
      });
    } else {
      // Unreachable but launchd says it never exited: still down from where we stand — but SAY that
      // this is where we stand. A daemon merely too busy to answer within the timeout presents
      // exactly this way (hydrate.ts: "time any handler holds is time /health waits"), and reading
      // it as death has produced false alarms that cost a human's attention each time.
      // The old text ended "Check /health directly and compare booted_at before treating this as
      // an outage" — homework for a human, on a check the guardian can run. It now HAS run: the
      // confirming probe on a longer bound is exactly that check, so this says what it found.
      //
      // And one bound was still not enough. 2026-08-24, 16:10:13: a 77 s event-loop stall outlasted
      // the 2 s probes AND the 10 s confirm, against a daemon that never restarted and was
      // answering /health in 1.8 ms minutes later. No bound a single tick can afford outwaits an
      // arbitrary stall; the only observation that separates a stall from an outage is the NEXT
      // tick, ~120 s away — longer than any stall yet measured. So the first sighting defers
      // (`defer`), and only a sighting a previous tick already made raises. launchd's clean-exit
      // word is what earns the deferral: when it reports a real exit, the branch above still
      // raises immediately.
      const persisted =
        s.firstUnreachableAt !== undefined && s.firstUnreachableAt !== null
          ? s.now - s.firstUnreachableAt
          : null;
      const base =
        `${probe}, but launchd reports a clean exit and ${s.launchd.runs} run(s) — the process was ` +
        `never restarted. ` +
        (s.healthProbe?.confirmMs !== undefined
          ? `Slow-but-alive within this tick was tested: it answered neither bound. `
          : `This build recorded no confirming probe. `);
      // The sample rides the raise whether or not it promotes the class (ADR 389 §1): the top frame
      // is the single most useful sentence a human can be handed about a wedge, and "no sample, and
      // here is why" is what keeps a degraded host's raise honest rather than merely quieter.
      const sample = s.stack !== undefined ? ` ${describeSample(s.stack)}.` : '';
      if (persisted === null) {
        alert.push({
          class: 'daemon_down',
          defer: true,
          evidence:
            base +
            `First sighting — held one tick to separate a transient stall from an outage ` +
            `(a stall recovers before the next tick; an outage does not).` +
            sample,
        });
      } else if (s.load !== undefined && s.load.one > STARVED_LOAD_PER_CORE * s.load.cores) {
        // The machine is the reason (lane 01M2GTB0RA): with the load average past twice the core
        // count, a single-threaded sync daemon cannot get a slot inside the bound, and the sample
        // — whatever frame it names — is what a busy healthy daemon looks like. Not a page: the
        // remedy is on the machine (stop the tsc/vitest, rank the daemon), not with a reader.
        alert.push({
          class: 'daemon_starved',
          evidence:
            base +
            `Persisted across ticks: still unreachable ${Math.round(persisted / 1000)}s after the ` +
            `first sighting. The MACHINE is the reason: load average ${s.load.one.toFixed(1)} on ` +
            `${s.load.cores} cores (over ${STARVED_LOAD_PER_CORE}× per core) — a single-threaded ` +
            `daemon starved by other work, not blocked by its own.` +
            sample,
        });
      } else if (s.stack?.wedged === true) {
        // All four circumstantial conditions AND a sample naming one synchronous frame. Those four
        // alone are jointly satisfied by "went away without launchd noticing" — a different
        // incident with a different owner — so only the sample can make this class.
        alert.push({
          class: 'daemon_wedged',
          evidence:
            base +
            `Persisted across ticks: still unreachable ${Math.round(persisted / 1000)}s after the ` +
            `first sighting, so a transient stall is ruled out. The process is ALIVE and blocked, ` +
            `not gone:${sample}`,
        });
      } else {
        alert.push({
          class: 'daemon_down',
          evidence:
            base +
            `Persisted across ticks: still unreachable ${Math.round(persisted / 1000)}s after the ` +
            `first sighting, so a transient stall is ruled out. Either it is wedged with the ` +
            `socket still held, or it went away without launchd noticing — the probe errors ` +
            `above tell which.` +
            sample,
        });
      }
    }
  } else {
    if (!s.health.schemaOk) alert.push({ class: 'schema_drift' });
    if (!s.health.dbPathExpected) alert.push({ class: 'wrong_db' });
  }

  if (s.publisherLog.outcome === 'failed') auto.push({ class: 'publisher_failed' });
  if (s.httpErrorRateSinceBoot >= ERROR_RATE_FLOOR) alert.push({ class: 'error_rate' });
  if (s.reaperStormSinceBoot) alert.push({ class: 'presence_churn' });

  return [...auto, ...alert];
}

/**
 * The classes this tick could not OBSERVE — not firing, and not observed healthy either.
 *
 * `classify` answers one question ("what is wrong right now"), and a class it omits is normally a
 * class just observed healthy: that absence is what ADR 432's discharge reads as recovery. But
 * absence has two causes, and only one of them is health. When the publisher's log carries no
 * outcome line at all, `classify` omits `publisher_failed` because there is nothing to raise —
 * which, since ADR 438 made the discharge run on EVERY tick, silently closed a genuine open raise
 * on the strength of a tick that observed nothing. ADR 435's Decision says in writing that
 * `unknown` "does not raise, and does not clear an existing raise either"; the landed code kept
 * only the first half, because the signal folded `unknown` into `false` before anything downstream
 * could tell the two apart.
 *
 * REACHABLE, not theoretical: autorefresh trims logs over a cap (observed 2026-09-21 16:51 on
 * daemon.log). A trimmed `build.log` whose last outcome line is gone reads `unknown` while the
 * publisher is genuinely broken — the exact "one real outage going quiet" direction clear.test.ts
 * names as the safety case.
 *
 * This is the per-class version of the handover rule the tick already applies wholesale (ADR 274:
 * a daemon restarting on purpose classifies nothing, and that emptiness is not health).
 */
export function indeterminate(s: GuardianSignals): GuardianClass[] {
  return s.publisherLog.outcome === 'unknown' ? ['publisher_failed'] : [];
}
