import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { loadConfig } from '../config.js';
import { laneCommand, lanesCommand } from './lane.js';
import { teamCommand } from './team.js';

describe('lane commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-lane-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // `team create` mints nick as creator-admin and auto-binds this folder, so lane commands
    // resolve nick from the binding without an explicit --as (the acting-identity requirement).
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  /** Open a lane and return its id (parsed out of the `--json` payload). */
  async function openLane(args: string[]): Promise<string> {
    const res = await capture(() => laneCommand(parseArgs(['open', ...args, '--json'])));
    // `lane open` doesn't honour --json (it always renders), so read the board back instead.
    void res;
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  it('opens a lane and renders it with a checkmark', async () => {
    const res = await capture(() =>
      laneCommand(parseArgs(['open', 'wire the thing', '--surface', 'src/a.ts,src/b.ts'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane opened');
    expect(res.out).toContain('wire the thing');
    expect(res.out).toContain('src/a.ts');
  });

  /**
   * The derivation (design doc §7): `project` is stamped client-side, because the daemon's cwd is
   * the daemon's. A non-git folder — every other test here — stays on the `'default'` floor.
   */
  it('open derives project from the repo, MUSTERD_PROJECT overrides, --project wins', async () => {
    const board = async () => {
      const out = await capture(() => lanesCommand(parseArgs(['--json'])));
      const { lanes } = JSON.parse(out.out) as { lanes: { title: string; project: string }[] };
      return (t: string) => lanes.find((l) => l.title === t)!.project;
    };

    await capture(() => laneCommand(parseArgs(['open', 'no-git'])));
    expect((await board())('no-git')).toBe('default');

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    await capture(() => laneCommand(parseArgs(['open', 'in-repo'])));
    expect((await board())('in-repo')).toBe(basename(dir));

    process.env['MUSTERD_PROJECT'] = 'declared';
    await capture(() => laneCommand(parseArgs(['open', 'via-env'])));
    await capture(() => laneCommand(parseArgs(['open', 'via-flag', '--project', 'explicit'])));
    delete process.env['MUSTERD_PROJECT'];
    const at = await board();
    expect(at('via-env')).toBe('declared');
    expect(at('via-flag')).toBe('explicit');
  });

  it('open --claim assigns the lane to the caller', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; owner_seat: string }[] };
    expect(lanes.find((l) => l.title === 'mine')?.owner_seat).toBe('nick');
  });

  it('open threads goal/branch/depends/detail/project/role through', async () => {
    const res = await capture(() =>
      laneCommand(
        parseArgs([
          'open',
          'rich',
          '--goal',
          'g1',
          '--branch',
          'feat/x',
          '--depends',
          'a,b',
          '--detail',
          'notes',
          '--project',
          'p',
          '--role',
          'dev',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('feat/x');
    expect(res.out).toContain('g1');
  });

  it('claim then resolve moves a lane to done', async () => {
    const id = await openLane(['claimable']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).toContain('lane claimed');
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).toContain('done');
  });

  it('submit moves a lane to awaiting_acceptance, keeps the attestation, and reports the routing (ADR 192)', async () => {
    const id = await openLane(['reviewable', '--claim', '--branch', 'feat/review']);
    const ready = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '7', '--sha', 'deadbeef'])),
    );
    expect(ready.code).toBe(0);
    expect(ready.out).toContain('lane submitted for acceptance');
    expect(ready.out).toContain('awaiting_acceptance');
    // Solo team: no eligible acceptor → self-close sanctioned, spelled out.
    expect(ready.out).toContain('self-close sanctioned');
    // The degradation path stays open: the owner can still resolve, nudged as unconfirmed.
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).toContain('unconfirmed close recorded');
  });

  // ADR 083: the acceptor should receive the work as an artifact, not a description. Submit hands
  // the lane over and was the one edge that could not name the branch — so a lane opened before the
  // branch existed (the common order: open, then cut the branch) reached its acceptor pointing at
  // nothing. Measured 2026-08-05: 184 of 362 terminal-or-awaiting lanes carried branch=null.
  it('submit records the branch the work landed on, for a lane opened without one', async () => {
    const id = await openLane(['no branch at open', '--claim']);
    const submitted = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '7', '--branch', 'izzo/the-work'])),
    );
    expect(submitted.code).toBe(0);
    expect(submitted.out).toContain('⎇ izzo/the-work');
    // And it PERSISTED, rather than only being echoed back: a later command reads it off the lane.
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('git branch -D izzo/the-work');
  });

  it('submit without --branch leaves the branch the lane already carried', async () => {
    // Never clears: a repeat submit recording a merge SHA must not blank the pointer.
    const id = await openLane(['already pointed', '--claim', '--branch', 'feat/kept']);
    const submitted = await capture(() => laneCommand(parseArgs(['submit', id, '--pr', '8'])));
    expect(submitted.out).toContain('⎇ feat/kept');
  });

  it('resolve prints the local-branch cleanup hint when the lane carries a branch', async () => {
    const id = await openLane(['landed', '--claim', '--branch', 'feat/landed']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('clear the local branch');
    expect(resolved.out).toContain('git branch -D feat/landed');
    expect(resolved.out).toContain('git switch --detach origin/main');
  });

  it('resolve omits the cleanup hint for a lane with no branch', async () => {
    const id = await openLane(['branchless']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).not.toContain('clear the local branch');
  });

  it('resolve --pr/--sha/--authorized-by attests the merge to the audit log (ADR 109)', async () => {
    const id = await openLane(['attested', '--claim', '--branch', 'feat/attested']);
    const resolved = await capture(() =>
      laneCommand(
        parseArgs(['resolve', id, '--pr', '167', '--sha', 'abc123', '--authorized-by', 'nick']),
      ),
    );
    expect(resolved.code).toBe(0);
    expect(resolved.out).toContain('lane done');
    const { auditCommand } = await import('./audit.js');
    const audit = await capture(() => auditCommand(parseArgs(['--json'])));
    const rows = JSON.parse(audit.out) as { action: string; detail: unknown }[];
    const row = rows.find((r) => r.action === 'git.pr_merged');
    expect(row).toBeDefined();
    expect(row!.detail).toMatchObject({ pr: 167, sha: 'abc123', authorized_by: 'nick' });
  });

  it('resolve rejects a non-integer --pr with usage', async () => {
    const id = await openLane(['badpr', '--claim']);
    await expect(laneCommand(parseArgs(['resolve', id, '--pr', 'nope']))).rejects.toThrow(/usage/);
  });

  it('claim does not print the branch-cleanup hint', async () => {
    const id = await openLane(['nohint', '--branch', 'feat/nohint']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).not.toContain('clear the local branch');
  });

  it('release hands a claimed lane back to the board as unowned', async () => {
    const id = await openLane(['parkme', '--claim']);
    const res = await capture(() => laneCommand(parseArgs(['release', id])));
    expect(res.out).toContain('lane released');
    expect(res.out).toContain('open');
    expect(res.out).toContain('unowned'); // renderLane's null-owner rendering
  });

  it('handoff reassigns to another seat with a branch', async () => {
    await new (await import('../client.js')).HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).addMember('dawn', { name: 'Ada', kind: 'agent' });
    const id = await openLane(['handme', '--claim']);
    const res = await capture(() =>
      laneCommand(parseArgs(['handoff', id, '--to', 'Ada', '--branch', 'feat/y'])),
    );
    expect(res.out).toContain('handed to Ada');
    expect(res.out).toContain('feat/y');
  });

  it('update sets state/detail/surface', async () => {
    const id = await openLane(['upd']);
    const res = await capture(() =>
      laneCommand(parseArgs(['update', id, '--state', 'active', '--surface', 'src/c.ts'])),
    );
    expect(res.out).toContain('lane updated');
    expect(res.out).toContain('active');
    expect(res.out).toContain('src/c.ts');
  });

  // ADR 256's no_goal warning names `lane_update {goal_id}` / `musterd lane update --goal`.
  // Open already takes --goal; update did not, so a goal-less lane had no CLI repair.
  it('update --goal links a goal-less lane', async () => {
    const id = await openLane(['unlinked']);
    const res = await capture(() =>
      laneCommand(parseArgs(['update', id, '--goal', 'goals-front-door'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane updated');
    expect(res.out).toContain('goals-front-door');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; goal_id: string | null }[] };
    expect(lanes.find((l) => l.id === id)?.goal_id).toBe('goals-front-door');
  });

  it('lanes renders an empty board hint', async () => {
    const res = await capture(() => lanesCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no lanes');
  });

  it('lanes lists lanes and honours --mine/--open filters', async () => {
    await openLane(['a', '--claim']);
    await openLane(['b']);
    const all = await capture(() => lanesCommand(parseArgs([])));
    expect(all.out).toContain('lanes — dawn');
    expect(all.out).toContain('"a"');
    const open = await capture(() => lanesCommand(parseArgs(['--open', '--json'])));
    const { lanes } = JSON.parse(open.out) as { lanes: { title: string }[] };
    expect(lanes.some((l) => l.title === 'b')).toBe(true);
    expect(lanes.some((l) => l.title === 'a')).toBe(false);
  });

  // ADR 234 increment 1. A typo in --stakes must FAIL rather than fall back to the default: the
  // phase exists to measure declarations, and a misspelling that quietly recorded `normal` would
  // put a lane the worker meant to mark `low` into the very bucket it was being distinguished from
  // — corrupting the measurement in the direction that HIDES the effect being tested.
  it('refuses an unrecognised --stakes instead of silently defaulting it', async () => {
    await expect(
      laneCommand(parseArgs(['open', 'typo lane', '--stakes', 'trivial'])),
    ).rejects.toThrow(/--stakes must be one of low \| normal \| high/);
    // Nothing was opened — the refusal is before the write, not after it.
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string }[] };
    expect(lanes.some((l) => l.title === 'typo lane')).toBe(false);
  });

  it('carries a declared --stakes through open and update', async () => {
    const id = await openLane(['staked', '--stakes', 'low', '--claim']);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; stakes: string }[] };
    expect(lanes.find((l) => l.id === id)?.stakes).toBe('low');

    await capture(() => laneCommand(parseArgs(['update', id, '--stakes', 'high'])));
    const after = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes: l2 } = JSON.parse(after.out) as { lanes: { id: string; stakes: string }[] };
    expect(l2.find((l) => l.id === id)?.stakes).toBe('high');
  });

  it('rejects malformed subcommands and missing args with usage', async () => {
    await expect(laneCommand(parseArgs([]))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['open']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['claim']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['release']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['handoff', 'x']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['update']))).rejects.toThrow(/usage/);
  });
});
