import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enumerateClaudeSessions,
  enumerateCodexSessions,
  enumerateCursorSessions,
  resetSessionScan,
} from './enumerate.js';

/**
 * ADR 166. Attribution is by the transcript's RECORDED `cwd` walked up to a workspace — never by
 * decoding the projects directory name, which the fleet sweep proved is an inconsistent encoding.
 */
describe('enumerateClaudeSessions (ADR 166)', () => {
  let home: string;
  let ws: string;

  /** A workspace is anything with a .musterd/binding.json on the walk-up — the same rule the hook used. */
  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'adr166-ws-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    return dir;
  };

  /** Write a transcript into an ARBITRARY projects directory — the name is deliberately not derived
   *  from the cwd, because production's naming is not derivable either. */
  const transcript = (
    projectDirName: string,
    id: string,
    opts: { cwd?: string; ageMin?: number; padFirstLine?: boolean } = {},
  ): void => {
    const dir = join(home, '.claude', 'projects', projectDirName);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${id}.jsonl`);
    const first = opts.padFirstLine
      ? JSON.stringify({ type: 'summary', pad: 'x'.repeat(200_000) })
      : JSON.stringify({ type: 'summary' });
    const second = opts.cwd ? JSON.stringify({ type: 'user', cwd: opts.cwd }) : '';
    writeFileSync(p, `${first}\n${second}\n`);
    const t = new Date(Date.now() - (opts.ageMin ?? 0) * 60_000);
    utimesSync(p, t, t);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adr166-home-'));
    ws = workspace();
    resetSessionScan();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    resetSessionScan();
  });

  it('returns undefined — "cannot tell" — when there is no projects tree', () => {
    // Load-bearing: never laundered into "no sessions". The guard's safe answer when unsure is live.
    expect(enumerateClaudeSessions(ws, join(home, 'nope'))).toBeUndefined();
  });

  it('returns [] when the tree exists but holds nothing for this workspace', () => {
    transcript('some-other-project', 's1', { cwd: '/elsewhere' });
    expect(enumerateClaudeSessions(ws, home)).toEqual([]);
  });

  it('attributes by recorded cwd, NOT by the directory name', () => {
    // The directory name is deliberate nonsense; only the recorded cwd should matter.
    transcript('totally-unrelated-name', 'mine', { cwd: ws });
    expect(enumerateClaudeSessions(ws, home)?.map((f) => f.id)).toEqual(['mine']);
  });

  it('finds a session running in a SUBDIRECTORY of the workspace — the bug the sweep caught', () => {
    // The live /Users/nick/agents session ran in .claude-worktrees/<name>; walk-up says it belongs
    // to the workspace, so enumeration must see it or it demotes a live session.
    const sub = join(ws, '.claude-worktrees', 'inspiring-swartz-922195');
    mkdirSync(sub, { recursive: true });
    transcript('-slug-that-does-not-decode', 'worktree-session', { cwd: sub });
    expect(enumerateClaudeSessions(ws, home)?.map((f) => f.id)).toEqual(['worktree-session']);
  });

  it('does not claim a transcript whose cwd belongs to a different workspace', () => {
    const other = workspace();
    transcript('d1', 'theirs', { cwd: other });
    transcript('d2', 'ours', { cwd: ws });
    expect(enumerateClaudeSessions(ws, home)?.map((f) => f.id)).toEqual(['ours']);
    rmSync(other, { recursive: true, force: true });
  });

  it('leaves a transcript with no recorded cwd unattributed rather than guessing', () => {
    transcript('d1', 'no-cwd', {});
    expect(enumerateClaudeSessions(ws, home)).toEqual([]);
  });

  it('leaves a transcript unattributed when cwd is past the probe window', () => {
    // 200 KB of first line pushes cwd beyond the 64 KiB probe: unattributable, not misattributed.
    transcript('d1', 'buried', { cwd: ws, padFirstLine: true });
    expect(enumerateClaudeSessions(ws, home)).toEqual([]);
  });

  it('sorts newest write first', () => {
    transcript('d1', 'old', { cwd: ws, ageMin: 600 });
    transcript('d2', 'fresh', { cwd: ws, ageMin: 1 });
    transcript('d3', 'middle', { cwd: ws, ageMin: 60 });
    expect(enumerateClaudeSessions(ws, home)?.map((f) => f.id)).toEqual(['fresh', 'middle', 'old']);
  });

  it('ignores non-transcript files', () => {
    transcript('d1', 'a', { cwd: ws });
    writeFileSync(join(home, '.claude', 'projects', 'd1', 'notes.txt'), 'x');
    expect(enumerateClaudeSessions(ws, home)?.map((f) => f.id)).toEqual(['a']);
  });
});

describe('enumerateCodexSessions (ADR 216)', () => {
  let home: string;
  let ws: string;

  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'adr204-ws-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    return dir;
  };

  const rollout = (
    id: string,
    opts: { cwd?: string; ageMin?: number; sessionId?: string; padFirstLine?: boolean } = {},
  ): void => {
    const dir = join(home, '.codex', 'sessions', '2026', '08', '03');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-08-03T00-00-00-${id}.jsonl`);
    const first = opts.padFirstLine
      ? JSON.stringify({ type: 'event_msg', payload: { pad: 'x'.repeat(200_000) } })
      : JSON.stringify({
          type: 'session_meta',
          payload: { session_id: opts.sessionId ?? id, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
        });
    const second = opts.padFirstLine
      ? JSON.stringify({
          type: 'session_meta',
          payload: { session_id: opts.sessionId ?? id, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
        })
      : '';
    writeFileSync(path, `${first}\n${second}\n`);
    const t = new Date(Date.now() - (opts.ageMin ?? 0) * 60_000);
    utimesSync(path, t, t);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adr204-home-'));
    ws = workspace();
    resetSessionScan();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    resetSessionScan();
  });

  it('returns undefined when the Codex rollout tree is unavailable', () => {
    expect(enumerateCodexSessions(ws, join(home, 'nope'))).toBeUndefined();
  });

  it('attributes a rollout by the recorded session_meta cwd and session_id', () => {
    rollout('file-name-is-not-the-thread', { cwd: ws, sessionId: 'thread-to-resume' });
    const found = enumerateCodexSessions(ws, home);
    expect(found?.map((f) => f.id)).toEqual(['thread-to-resume']);
    expect(found?.[0]?.path).toContain('rollout-2026-08-03T00-00-00-file-name-is-not-the-thread');
  });

  it('includes a rollout from a subdirectory but never guesses an absent cwd', () => {
    const sub = join(ws, 'packages', 'cli');
    mkdirSync(sub, { recursive: true });
    rollout('subdirectory', { cwd: sub });
    rollout('unknown');
    expect(enumerateCodexSessions(ws, home)?.map((f) => f.id)).toEqual(['subdirectory']);
  });

  it('keeps a rollout whose session_meta falls outside the probe window unattributed', () => {
    rollout('buried', { cwd: ws, padFirstLine: true });
    expect(enumerateCodexSessions(ws, home)).toEqual([]);
  });
});

describe('enumerateCursorSessions (ADR 265)', () => {
  let home: string;
  let ws: string;

  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'adr265-ws-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    return dir;
  };

  const project = (
    dirName: string,
    opts: {
      workspacePath?: string;
      sessions?: { id: string; kind: 'jsonl' | 'txt'; ageMin?: number }[];
    } = {},
  ): void => {
    const root = join(home, '.cursor', 'projects', dirName);
    mkdirSync(join(root, 'agent-transcripts'), { recursive: true });
    if (opts.workspacePath) {
      writeFileSync(
        join(root, '.workspace-trusted'),
        JSON.stringify({ workspacePath: opts.workspacePath }) + '\n',
      );
    }
    for (const s of opts.sessions ?? []) {
      const p =
        s.kind === 'txt'
          ? join(root, 'agent-transcripts', `${s.id}.txt`)
          : join(root, 'agent-transcripts', s.id, `${s.id}.jsonl`);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, s.kind === 'txt' ? 'user:\nhello\n' : '{"role":"user"}\n');
      const t = new Date(Date.now() - (s.ageMin ?? 0) * 60_000);
      utimesSync(p, t, t);
    }
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adr265-home-'));
    ws = workspace();
    resetSessionScan();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    resetSessionScan();
  });

  it('returns undefined when the Cursor projects tree is unavailable', () => {
    expect(enumerateCursorSessions(ws, join(home, 'nope'))).toBeUndefined();
  });

  it('attributes by .workspace-trusted workspacePath, not the folder name', () => {
    project('totally-unrelated-name', {
      workspacePath: ws,
      sessions: [{ id: 'cli-session', kind: 'txt' }],
    });
    expect(enumerateCursorSessions(ws, home)?.map((f) => f.id)).toEqual(['cli-session']);
  });

  it('sees both a desktop jsonl and a CLI txt in the same project', () => {
    project('slug-is-not-evidence', {
      workspacePath: ws,
      sessions: [
        { id: 'desktop', kind: 'jsonl', ageMin: 60 },
        { id: 'cli', kind: 'txt', ageMin: 1 },
      ],
    });
    expect(enumerateCursorSessions(ws, home)?.map((f) => f.id)).toEqual(['cli', 'desktop']);
  });

  it('leaves a project with no .workspace-trusted unattributed rather than slug-decoding', () => {
    project('Users-nick-agents-wanderer', {
      sessions: [{ id: 'orphan', kind: 'txt' }],
    });
    expect(enumerateCursorSessions(ws, home)).toEqual([]);
  });

  it('does not claim a project whose workspacePath belongs elsewhere', () => {
    const other = workspace();
    project('theirs', { workspacePath: other, sessions: [{ id: 'theirs', kind: 'txt' }] });
    project('ours', { workspacePath: ws, sessions: [{ id: 'ours', kind: 'txt' }] });
    expect(enumerateCursorSessions(ws, home)?.map((f) => f.id)).toEqual(['ours']);
    rmSync(other, { recursive: true, force: true });
  });
});
