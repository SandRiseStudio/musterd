import { describe, expect, it } from 'vitest';
import { memoryFs, type ClockSeam, type ProcessSeam } from './context.js';
import { createHarnessLocks, LEASE_MS, RENEW_MS } from './lock.js';
import { loadLockRecord, lockPath } from './store.js';

const root = '/machine/.musterd';
const KEY = 'folder:/w/a:.claude/settings.json';

/** A controllable clock. */
function fakeClock(startMs = 1_000_000): ClockSeam & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A process seam whose liveness answers are scripted per (pid, startedAt). */
function fakeProc(opts: {
  pid: number;
  startedAt: string;
  live?: Record<string, boolean | 'unknown'>;
}): ProcessSeam {
  return {
    pid: opts.pid,
    startedAt: () => opts.startedAt,
    liveness: (pid, processStartedAt) => opts.live?.[`${pid}@${processStartedAt}`] ?? false,
  };
}

describe('createHarnessLocks — recoverable cross-process lease (ADR 282/286)', () => {
  it('acquires a fresh lease and writes a valid lock record', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const locks = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    const got = locks.acquire(KEY);
    expect(got.status).toBe('acquired');
    const record = loadLockRecord(fs, root, KEY);
    expect(record.kind).toBe('valid');
    if (record.kind === 'valid') {
      expect(record.value.pid).toBe(10);
      expect(record.value.processStartedAt).toBe('s10');
    }
  });

  it('a live, unexpired holder returns busy', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    expect(holder.acquire(KEY).status).toBe('acquired');
    const other = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 11, startedAt: 's11', live: { '10@s10': true } }),
      machineConfigRoot: root,
    });
    expect(other.acquire(KEY).status).toBe('busy');
  });

  it('a dead, expired holder with the same PID but different process-start identity is reclaimable', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's-old' }),
      machineConfigRoot: root,
    });
    expect(holder.acquire(KEY).status).toBe('acquired');
    clock.advance(LEASE_MS + 1);
    // PID 10 is alive again — but as a DIFFERENT process (start identity differs), so not the holder.
    const successor = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's-new', live: { '10@s-old': false } }),
      machineConfigRoot: root,
    });
    expect(successor.acquire(KEY).status).toBe('acquired');
  });

  it('an expired but still-live exact process identity remains busy', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    expect(holder.acquire(KEY).status).toBe('acquired');
    clock.advance(LEASE_MS + 1);
    const other = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 11, startedAt: 's11', live: { '10@s10': true } }),
      machineConfigRoot: root,
    });
    expect(other.acquire(KEY).status).toBe('busy');
  });

  it('unknown liveness is busy, never reclaimable', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    expect(holder.acquire(KEY).status).toBe('acquired');
    clock.advance(LEASE_MS + 1);
    const other = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 11, startedAt: 's11', live: { '10@s10': 'unknown' } }),
      machineConfigRoot: root,
    });
    expect(other.acquire(KEY).status).toBe('busy');
  });

  it('renewal extends expiry only for the matching holder id', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    const got = holder.acquire(KEY);
    if (got.status !== 'acquired') throw new Error('expected acquired');
    const before = loadLockRecord(fs, root, KEY);
    clock.advance(RENEW_MS);
    got.lease.renew();
    const after = loadLockRecord(fs, root, KEY);
    if (before.kind !== 'valid' || after.kind !== 'valid')
      throw new Error('expected valid records');
    expect(Date.parse(after.value.expiresAt)).toBeGreaterThan(Date.parse(before.value.expiresAt));
    expect(after.value.holderId).toBe(before.value.holderId);

    // A different process's stale lease handle must not renew what it no longer holds: overwrite
    // the record with another holder's, then renew — the record must stay the other holder's.
    const usurper = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 12, startedAt: 's12', live: { '10@s10': false } }),
      machineConfigRoot: root,
    });
    clock.advance(LEASE_MS + 1);
    const taken = usurper.acquire(KEY);
    expect(taken.status).toBe('acquired');
    got.lease.renew(); // stale handle
    const final = loadLockRecord(fs, root, KEY);
    if (final.kind !== 'valid') throw new Error('expected valid record');
    expect(final.value.pid).toBe(12);
  });

  it('release from a different holder cannot delete the lease', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    const first = holder.acquire(KEY);
    if (first.status !== 'acquired') throw new Error('expected acquired');
    const stale = first.lease;
    // Holder 1's lease expires; a successor takes it; the stale handle tries to release.
    clock.advance(LEASE_MS + 1);
    const successor = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 11, startedAt: 's11', live: { '10@s10': false } }),
      machineConfigRoot: root,
    });
    expect(successor.acquire(KEY).status).toBe('acquired');
    stale.release();
    const record = loadLockRecord(fs, root, KEY);
    expect(record.kind).toBe('valid');
    if (record.kind === 'valid') expect(record.value.pid).toBe(11);
  });

  it('a stopped holder allows recovery after the 30-second lease', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    const holder = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    expect(holder.acquire(KEY).status).toBe('acquired');
    const successor = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 11, startedAt: 's11', live: { '10@s10': false } }),
      machineConfigRoot: root,
    });
    // Before expiry: still busy — a dead PID with time left is not yet reclaimable evidence.
    clock.advance(LEASE_MS - 1);
    expect(successor.acquire(KEY).status).toBe('busy');
    // At 30s the lease has run out and the holder is provably gone: reclaim.
    clock.advance(2);
    expect(successor.acquire(KEY).status).toBe('acquired');
    expect(LEASE_MS).toBe(30_000);
    expect(RENEW_MS).toBe(10_000);
  });

  it('an invalid or torn lock record blocks nothing forever: it reports busy until expiry semantics cannot apply, then a reclaim requires manual repair', () => {
    const fs = memoryFs();
    const clock = fakeClock();
    fs.writeFile(lockPath(root, KEY), '{ torn', 0o600);
    const locks = createHarnessLocks({
      fs,
      clock,
      proc: fakeProc({ pid: 10, startedAt: 's10' }),
      machineConfigRoot: root,
    });
    const got = locks.acquire(KEY);
    // Conservative: an unreadable record is unknown ownership — busy, never adopt/overwrite.
    expect(got.status).toBe('busy');
  });
});
