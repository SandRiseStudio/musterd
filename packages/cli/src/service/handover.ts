/**
 * The refresh-to-daemon handover marker (ADR 274). It is deliberately separate from the
 * auto-refresher's attempted-tip debounce: this record means a daemon restart is in progress,
 * never that a build was attempted.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const HANDOVER_GRACE_MS = 30_000;

export interface RefreshHandover {
  startedAt: number;
  targetBuild: string;
}

interface HandoverFile {
  started_at: number;
  target_build: string;
}

export function writeHandover(path: string, handover: RefreshHandover): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: HandoverFile = {
    started_at: handover.startedAt,
    target_build: handover.targetBuild,
  };
  writeFileSync(path, JSON.stringify(file));
}

/** A malformed, future, or expired record is never a reason to defer an outage. */
export function readHandover(path: string, now: number): RefreshHandover | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HandoverFile>;
    if (
      !Number.isFinite(raw.started_at) ||
      typeof raw.target_build !== 'string' ||
      raw.target_build.length === 0 ||
      raw.started_at! > now ||
      now - raw.started_at! > HANDOVER_GRACE_MS
    ) {
      return null;
    }
    return { startedAt: raw.started_at!, targetBuild: raw.target_build };
  } catch {
    return null;
  }
}

export function clearHandover(path: string): void {
  try {
    rmSync(path);
  } catch {
    // A missing or already-cleared marker is the desired postcondition.
  }
}
