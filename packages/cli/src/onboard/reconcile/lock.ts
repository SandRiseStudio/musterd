import { randomUUID } from 'node:crypto';
import type { HarnessLockRecord } from '@musterd/protocol';
import type { ClockSeam, FsSeam, ProcessSeam } from './context.js';
import { loadLockRecord, removeLockRecord, saveLockRecord } from './store.js';

/**
 * The cross-process recoverable lease keyed by containerKey (ADR 282, hardened by ADR 286 §2).
 *
 * Not an in-memory mutex: reconciler A and reconciler B may be different processes, and A may be
 * KILLED between the prepared journal and the external write. The lease is what keeps B out while
 * A works, and what lets B in — provably safely — after A dies:
 *
 * - a live, unexpired holder is `busy`;
 * - reclamation needs BOTH expiry AND evidence the holder process is gone. PID alone is not
 *   evidence (PIDs are reused); the recorded process-start identity must fail to match. Unknown
 *   liveness is busy, never reclaimable — a guess that reclaims is a guess that corrupts;
 * - a torn or invalid lock record is ambiguous ownership: busy, with the path in the report, so a
 *   human repairs it deliberately. We never adopt or overwrite ambiguity (plan constraint).
 *
 * The 30-second lease with 10-second renewal is the crash-recovery bound the spec fixes: a stopped
 * holder blocks journal recovery for at most 30 seconds.
 */
export const LEASE_MS = 30_000;
export const RENEW_MS = 10_000;

export interface HarnessLease {
  /** Extend the lease. A stale handle (the record is no longer ours) silently declines. */
  renew(): void;
  /** Release the lease. Only deletes a record this holder still owns. */
  release(): void;
}

export type AcquireResult =
  | { status: 'acquired'; lease: HarnessLease }
  | { status: 'busy'; reason: 'held' | 'unknown-liveness' | 'invalid-record' };

export interface HarnessLocks {
  acquire(containerKey: string): AcquireResult;
}

export interface HarnessLockDeps {
  fs: FsSeam;
  proc: ProcessSeam;
  clock: ClockSeam;
  machineConfigRoot: string;
}

export function createHarnessLocks(deps: HarnessLockDeps): HarnessLocks {
  const { fs, proc, clock, machineConfigRoot } = deps;

  const record = (holderId: string, acquiredAt: string): HarnessLockRecord => {
    const now = clock.now();
    return {
      version: 1,
      holderId,
      pid: proc.pid,
      processStartedAt: proc.startedAt(),
      acquiredAt,
      renewedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LEASE_MS).toISOString(),
    };
  };

  const stillOurs = (containerKey: string, holderId: string): boolean => {
    const current = loadLockRecord(fs, machineConfigRoot, containerKey);
    return current.kind === 'valid' && current.value.holderId === holderId;
  };

  return {
    acquire(containerKey) {
      const existing = loadLockRecord(fs, machineConfigRoot, containerKey);
      if (existing.kind === 'invalid' || existing.kind === 'legacy') {
        // Ambiguous ownership — never adopt, never overwrite. Manual repair is the only exit.
        return { status: 'busy', reason: 'invalid-record' };
      }
      if (existing.kind === 'valid') {
        const held = existing.value;
        const expired = clock.now() > Date.parse(held.expiresAt);
        if (!expired) return { status: 'busy', reason: 'held' };
        const liveness = proc.liveness(held.pid, held.processStartedAt);
        if (liveness === 'unknown') return { status: 'busy', reason: 'unknown-liveness' };
        if (liveness === true) return { status: 'busy', reason: 'held' };
        // Expired AND the recorded process identity is provably gone: reclaim.
      }
      const holderId = randomUUID();
      const acquiredAt = new Date(clock.now()).toISOString();
      saveLockRecord(fs, machineConfigRoot, containerKey, record(holderId, acquiredAt));
      return {
        status: 'acquired',
        lease: {
          renew() {
            if (!stillOurs(containerKey, holderId)) return;
            saveLockRecord(fs, machineConfigRoot, containerKey, record(holderId, acquiredAt));
          },
          release() {
            if (!stillOurs(containerKey, holderId)) return;
            removeLockRecord(fs, machineConfigRoot, containerKey);
          },
        },
      };
    },
  };
}
