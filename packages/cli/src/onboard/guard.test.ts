import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  bindingRefusal,
  borrowedGitRoot,
  liveBindingClobber,
  nameBoundElsewhere,
} from './guard.js';

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

describe('bindingRefusal — a binding never sits above a Workspace (reach spec §6, ADR 442; layout ADR 447)', () => {
  /** A fake `~` with the ADR 447 layout under it: ~/musterd/revive/agents/{dolly,nick} bound; ~/musterd/other an empty team root. */
  const layout = () => {
    const home = mkdtempSync(join(tmpdir(), 'musterd-home-'));
    const bind = (dir: string) => {
      mkdirSync(join(dir, '.musterd'), { recursive: true });
      writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    };
    bind(join(home, 'musterd', 'revive', 'agents', 'dolly'));
    bind(join(home, 'musterd', 'revive', 'agents', 'nick'));
    mkdirSync(join(home, 'musterd', 'other'), { recursive: true });
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

  it('refuses `~/musterd/<team>` and `~/musterd/<team>/<repo>` as roofs — even an empty team root', () => {
    const home = layout();
    // With members beneath, the refusal names one (the more useful reason); empty, the roof rule holds.
    expect(bindingRefusal(join(home, 'musterd', 'revive'), home)?.workspace).toBe(
      realpathSync(join(home, 'musterd', 'revive', 'agents', 'dolly')),
    );
    expect(bindingRefusal(join(home, 'musterd', 'other'), home)?.reason).toMatch(/team root/);
    mkdirSync(join(home, 'musterd', 'other', 'site'), { recursive: true });
    expect(bindingRefusal(join(home, 'musterd', 'other', 'site'), home)?.reason).toMatch(
      /repo group/,
    );
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses any folder with member worktrees beneath it, naming one', () => {
    const home = layout();
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    renameSync(join(home, 'musterd', 'revive', 'agents'), join(home, 'elsewhere', 'agents'));
    const got = bindingRefusal(join(home, 'elsewhere', 'agents'), home);
    expect(got?.workspace).toBe(realpathSync(join(home, 'elsewhere', 'agents', 'dolly')));
    expect(got?.reason).toMatch(/musterd\/<team>\/<repo>\/<member>/);
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

  it('allows a member worktree; ignores node_modules', () => {
    const home = layout();
    expect(bindingRefusal(join(home, 'musterd', 'revive', 'agents', 'dolly'), home)).toBeNull();
    expect(bindingRefusal(join(home, 'proj'), home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a symlinked alias of a refused parent exactly like the real path', () => {
    const home = layout();
    symlinkSync(join(home, 'musterd', 'revive', 'agents'), join(home, 'alias'));
    expect(bindingRefusal(join(home, 'alias'), home)?.workspace).toBe(
      realpathSync(join(home, 'musterd', 'revive', 'agents', 'dolly')),
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

describe('borrowedGitRoot — a member Workspace is its own git root (ADR 447)', () => {
  const layout = () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'borrow-')));
    const teamRoot = join(home, 'musterd', 'revive');
    const member = join(teamRoot, 'agents', 'fifty');
    mkdirSync(member, { recursive: true });
    return { home, teamRoot, member };
  };
  const initRepo = (dir: string) => execFileSync('git', ['init', '-q'], { cwd: dir });

  it('names the repo above a plain member folder — fifty inside the team-home repo', () => {
    const { home, teamRoot, member } = layout();
    try {
      initRepo(teamRoot);
      expect(borrowedGitRoot(member, home)).toBe(teamRoot);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is quiet when the member folder is its own git root', () => {
    const { home, teamRoot, member } = layout();
    try {
      initRepo(teamRoot);
      initRepo(member);
      expect(borrowedGitRoot(member, home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is quiet for a plain folder in no repo, and for folders off the layout', () => {
    const { home, member } = layout();
    const elsewhere = join(home, 'code', 'app', 'sub');
    mkdirSync(elsewhere, { recursive: true });
    try {
      expect(borrowedGitRoot(member, home)).toBeNull();
      initRepo(join(home, 'code', 'app'));
      expect(borrowedGitRoot(elsewhere, home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
