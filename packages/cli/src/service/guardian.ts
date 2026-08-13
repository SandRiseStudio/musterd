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
  type GuardianStamp,
} from '../guardian/damp.js';

export interface GuardianTickDeps {
  now: () => number;
  stampPath: string;
  collect: () => Promise<GuardianSignals>;
  /** Tier map in force (policy over defaults); failures fall back to DEFAULT_TIERS. */
  getTiers: () => Promise<Record<GuardianClass, GuardianTier>>;
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

export async function guardianTick(d: GuardianTickDeps): Promise<number> {
  const now = d.now();
  let stamp = loadStamp(d.stampPath);

  const signals = await d.collect();
  const incidents = classify(signals);

  let tiers: Record<GuardianClass, GuardianTier>;
  try {
    tiers = await d.getTiers();
  } catch (e) {
    tiers = DEFAULT_TIERS;
    d.log(`tiers unreadable (${String(e)}) — shipped defaults in force`);
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
  return `guardian: last tick ${ageStr} ago, ${incident}${stale}`;
}
