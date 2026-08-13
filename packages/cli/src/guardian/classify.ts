/**
 * Guardian incident classification — pure decision ladder over recency-keyed signals
 * (spec: docs/superpowers/specs/2026-08-13-platform-guardian-design.md §3–§4).
 *
 * Every input is already boot-filtered by the collector (signals.ts): a signal here is fresh by
 * construction, so classification never has to reason about staleness — that is the whole
 * defense against the 8-day-old-log ghost the seed recorded.
 */

import type { GuardianClass, GuardianTier, GuardianTiers } from '@musterd/protocol';

export type { GuardianClass, GuardianTier };

export interface Incident {
  class: GuardianClass;
}

export interface GuardianSignals {
  now: number;
  /** null = /health unreachable. */
  health: { ok: boolean; bootedAt: number; schemaOk: boolean; dbPathExpected: boolean } | null;
  launchd: { lastExit: number; runs: number };
  publisherLog: { freshFailure: boolean };
  errLinesSinceBoot: number;
  httpErrorRateSinceBoot: number;
  reaperStormSinceBoot: boolean;
  /** Newest refresh/restart the guardian or autorefresh performed; null if none known. */
  lastRefreshAt: number | null;
}

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
    if (recentRefresh && s.launchd.runs > 1 && s.errLinesSinceBoot > 0) {
      auto.push({ class: 'crashloop' });
    } else if (s.launchd.lastExit !== 0) {
      alert.push({ class: 'daemon_down' });
    } else {
      // Unreachable but launchd says it never exited: still down from where we stand.
      alert.push({ class: 'daemon_down' });
    }
  } else {
    if (!s.health.schemaOk) alert.push({ class: 'schema_drift' });
    if (!s.health.dbPathExpected) alert.push({ class: 'wrong_db' });
  }

  if (s.publisherLog.freshFailure) auto.push({ class: 'publisher_failed' });
  if (s.httpErrorRateSinceBoot >= ERROR_RATE_FLOOR) alert.push({ class: 'error_rate' });
  if (s.reaperStormSinceBoot) alert.push({ class: 'presence_churn' });

  return [...auto, ...alert];
}
