/**
 * Guardian damping + heartbeat state (spec §5–§6). Lives in a local JSON stamp file, never the
 * DB — the DB may be the thing that is down. A guardian that bounces a crashlooping daemon every
 * two minutes IS the crashloop; one attempt per class per hour, then the caller escalates.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GuardianClass } from './classify.js';

export const ATTEMPT_WINDOW_MS = 3_600_000;
export const HEARTBEAT_INTERVAL_MS = 24 * 3_600_000;

export interface GuardianStamp {
  lastAttemptAt: Partial<Record<GuardianClass, number>>;
  lastTickAt: number | null;
  lastHeartbeatAt: number | null;
  lastIncident: { class: GuardianClass; at: number } | null;
  /** `/health.build` from the newest HEALTHY tick — the crashloop rollback target (`refresh --pin`). */
  lastGoodBuild: string | null;
}

export function emptyStamp(): GuardianStamp {
  return {
    lastAttemptAt: {},
    lastTickAt: null,
    lastHeartbeatAt: null,
    lastIncident: null,
    lastGoodBuild: null,
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

export function recordTick(s: GuardianStamp, now: number): GuardianStamp {
  return { ...s, lastTickAt: now };
}

export function dueDailyHeartbeat(s: GuardianStamp, now: number): boolean {
  return s.lastHeartbeatAt === null || now - s.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS;
}
