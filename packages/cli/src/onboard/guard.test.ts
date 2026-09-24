import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { bindingRefusal, liveBindingClobber, nameBoundElsewhere } from './guard.js';

/** A folder binding whose seat is `name`. */
const boundTo = (name: string): Binding => ({
  server: 'http://127.0.0.1:4849',
  team: 'dawn',
  surface: 'cli',
  agent_key: 'mskey_x',
  claim: { mode: 'seat', name },
});

/** A roster summary; offline + no presences by default. */
const member = (over: Partial<MemberSummary> & { name: string }): MemberSummary => ({
  id: over.name,
  team: 'dawn',
  kind: 'agent',
  role: '',
  lifecycle: 'forever',
  created_at: 0,
  presence: 'offline',
  presences: [],
  ...over,
});

describe('liveBindingClobber (ADR 066/105)', () => {
  it('does not clobber a plain-offline bound seat (a stale seat is safe to reclaim)', () => {
    const roster = [member({ name: 'Ada', presence: 'offline', activity: 'offline' })];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toBeNull();
  });

  it('clobbers a live bound seat, naming where it is live', () => {
    const roster = [
      member({
        name: 'Ada',
        presence: 'online',
        activity: 'active',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 1, workspace: 'repo@main' }],
      }),
    ];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toEqual({
      member: 'Ada',
      workspace: 'repo@main',
    });
  });

  it('clobbers a seat held within its reclaim grace even though it reads offline (ADR 105)', () => {
    // A reservation: presence/activity are offline (grace is hidden from display) but reclaimable is set.
    const roster = [
      member({ name: 'Ada', presence: 'offline', activity: 'offline', reclaimable: true }),
    ];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toEqual({
      member: 'Ada',
      reclaimable: true,
    });
  });

  it('never clobbers when re-occupying our own seat, even if reclaimable', () => {
    const roster = [member({ name: 'Ada', reclaimable: true })];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Ada')).toBeNull();
  });

  it('does not clobber when the bound seat is not on the roster', () => {
    expect(liveBindingClobber(boundTo('Ghost'), [member({ name: 'Ada' })], 'Bob')).toBeNull();
  });
});

describe('nameBoundElsewhere — a vanished folder is not a collision (ADR 162)', () => {
  it('ignores a registry entry whose folder no longer exists', () => {
    const gone = join(tmpdir(), 'musterd-guard-gone-does-not-exist');
    expect(
      nameBoundElsewhere('scout', tmpdir(), {
        [gone]: { team: 'dawn', seat: 'scout', surface: 'claude-code' },
      }),
    ).toBeNull();
  });

  it('still reports a real collision in a folder that IS there', () => {
    const live = mkdtempSync(join(tmpdir(), 'musterd-guard-live-'));
    try {
      expect(
        nameBoundElsewhere('scout', tmpdir(), {
          [live]: { team: 'revive', seat: 'scout', surface: 'claude-code' },
        }),
      ).toEqual({ folder: live, team: 'revive' });
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });
});

describe('bindingRefusal — a binding never sits above a Workspace (reach spec §6, ADR 442)', () => {
  /** A fake `~` with the §6 layout under it: ~/musterd/agents/{dolly,nick} bound, ~/musterd/revive a leaf. */
  const layout = () => {
    const home = mkdtempSync(join(tmpdir(), 'musterd-home-'));
    const bind = (dir: string) => {
      mkdirSync(join(dir, '.musterd'), { recursive: true });
      writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    };
    bind(join(home, 'musterd', 'agents', 'dolly'));
    bind(join(home, 'musterd', 'agents', 'nick'));
    mkdirSync(join(home, 'musterd', 'revive'), { recursive: true });
    mkdirSync(join(home, 'proj', 'node_modules', 'dep'), { recursive: true });
    bind(join(home, 'proj', 'node_modules', 'dep'));
    return home;
  };

  it('refuses `~` itself', () => {
    const home = layout();
    expect(bindingRefusal(home, home)?.reason).toMatch(/every folder beneath/);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses `~/musterd` — the roof over every project', () => {
    const home = layout();
    expect(bindingRefusal(join(home, 'musterd'), home)?.reason).toMatch(/never holds a binding/);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses `~/musterd/<repo>` because member worktrees lie beneath it, naming one', () => {
    const home = layout();
    const got = bindingRefusal(join(home, 'musterd', 'agents'), home);
    expect(got?.workspace).toBe(realpathSync(join(home, 'musterd', 'agents', 'dolly')));
    expect(got?.reason).toMatch(/musterd\/<repo>\/<member>/);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses any folder with a Workspace up to two levels beneath it (nested worktrees)', () => {
    const home = layout();
    mkdirSync(join(home, 'proj', '.worktrees', 'x', '.musterd'), { recursive: true });
    writeFileSync(join(home, 'proj', '.worktrees', 'x', '.musterd', 'binding.json'), '{}');
    expect(bindingRefusal(join(home, 'proj'), home)?.workspace).toBe(
      realpathSync(join(home, 'proj', '.worktrees', 'x')),
    );
    rmSync(home, { recursive: true, force: true });
  });

  it('allows a member worktree and a leaf team home; ignores node_modules', () => {
    const home = layout();
    expect(bindingRefusal(join(home, 'musterd', 'agents', 'dolly'), home)).toBeNull();
    expect(bindingRefusal(join(home, 'musterd', 'revive'), home)).toBeNull();
    expect(bindingRefusal(join(home, 'proj'), home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a symlinked alias of a refused parent exactly like the real path', () => {
    const home = layout();
    symlinkSync(join(home, 'musterd', 'agents'), join(home, 'alias'));
    expect(bindingRefusal(join(home, 'alias'), home)?.workspace).toBe(
      realpathSync(join(home, 'musterd', 'agents', 'dolly')),
    );
    symlinkSync(home, join(home, 'proj', 'home-alias'));
    expect(bindingRefusal(join(home, 'proj', 'home-alias'), home)?.reason).toMatch(
      /every folder beneath/,
    );
    rmSync(home, { recursive: true, force: true });
  });

  it('never throws: a folder that does not exist is simply not refused', () => {
    const home = layout();
    expect(bindingRefusal(join(home, 'nope', 'nor'), home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
