import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { listAudit } from '../store/audit.js';
import { createTeam } from '../store/teams.js';
import type { ProcSample } from './classify.js';
import { reapOrphans } from './reap.js';

const sidecarOrphan = (pid: number): ProcSample => ({
  pid,
  ppid: 1,
  rssKb: 10_000,
  command: 'npm exec chrome-devtools-mcp@1.6.0',
});

describe('reapOrphans', () => {
  let db: Database;
  let teamId: string;
  let kills: [number, string][];
  const deps = (procs: ProcSample[]) => ({
    scanProcs: () => procs,
    kill: (pid: number, sig: NodeJS.Signals) => {
      kills.push([pid, sig]);
    },
    graceMs: 0,
    sleep: () => Promise.resolve(),
  });

  beforeEach(() => {
    db = openDb(':memory:');
    teamId = createTeam(db, { slug: 'revive' }).id;
    kills = [];
  });

  it('kills a re-verified orphan (SIGTERM then SIGKILL) and writes the audit row', async () => {
    const res = await reapOrphans(db, teamId, 'kimi', [20], deps([sidecarOrphan(20)]));
    expect(res).toEqual({ killed: [20], refused: [] });
    expect(kills).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL'],
    ]);
    const rows = listAudit(db, teamId, {});
    expect(rows.some((r) => r.action === 'footprint.reaped')).toBe(true);
  });

  it('refuses a pid that no longer exists — a stale sample must never kill a recycled pid', async () => {
    const res = await reapOrphans(db, teamId, 'kimi', [99], deps([sidecarOrphan(20)]));
    expect(res).toEqual({ killed: [], refused: [{ pid: 99, reason: 'not_found' }] });
    expect(kills).toEqual([]);
  });

  it('refuses a pid outside the sidecar allowlist even when asked', async () => {
    const shell: ProcSample = { pid: 30, ppid: 1, rssKb: 100, command: '/bin/zsh' };
    const res = await reapOrphans(db, teamId, 'kimi', [30], deps([shell]));
    expect(res.refused).toEqual([{ pid: 30, reason: 'not_sidecar' }]);
    expect(kills).toEqual([]);
  });

  it('refuses a sidecar that is no longer orphaned (its app respawned it live)', async () => {
    const harness: ProcSample = {
      pid: 10,
      ppid: 1,
      rssKb: 1,
      command: '/Users/n/.local/bin/claude',
    };
    const liveSidecar: ProcSample = {
      pid: 11,
      ppid: 10,
      rssKb: 1,
      command: 'npm exec chrome-devtools-mcp@1.6.0',
    };
    const res = await reapOrphans(db, teamId, 'kimi', [11], deps([harness, liveSidecar]));
    expect(res.refused).toEqual([{ pid: 11, reason: 'not_orphaned' }]);
    expect(kills).toEqual([]);
  });

  it('an unreadable process table refuses everything as unverifiable — no scan, no kill', async () => {
    const res = await reapOrphans(db, teamId, 'kimi', [20, 21], {
      scanProcs: () => {
        throw new Error('unsupported platform');
      },
      kill: (pid: number, sig: NodeJS.Signals) => {
        kills.push([pid, sig]);
      },
      graceMs: 0,
      sleep: () => Promise.resolve(),
    });
    expect(res).toEqual({
      killed: [],
      refused: [
        { pid: 20, reason: 'unverifiable' },
        { pid: 21, reason: 'unverifiable' },
      ],
    });
    expect(kills).toEqual([]);
  });

  it('an all-refused request kills nothing and audits nothing', async () => {
    await reapOrphans(db, teamId, 'kimi', [99], deps([]));
    expect(listAudit(db, teamId, {}).some((r) => r.action === 'footprint.reaped')).toBe(false);
  });
});
