import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContinuityBinding, SessionCapture } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindThread,
  continuityPath,
  pruneOnDisk,
  readRegistry,
  writeRegistry,
} from './continuity.js';
import { RESUME_GC_HORIZON_MS } from './liveness.js';

const OWNER = { team: 'revive', seat: 'stanley' } as const;

const capture = (over: Partial<SessionCapture> = {}): SessionCapture => ({
  harness: 'claude-code',
  id: 'sess-1',
  transcript_path: '/tmp/t1.jsonl',
  started_at: 1_000,
  ...over,
});

describe('the continuity registry on disk (ADR 210)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-continuity-'));
  });

  it('reads an empty registry when the file does not exist', () => {
    expect(readRegistry(dir, OWNER)).toEqual({ version: 1, ...OWNER, bindings: [] });
  });

  it('round-trips a written registry', () => {
    const reg = {
      version: 1 as const,
      ...OWNER,
      bindings: [
        {
          thread_id: 'T1',
          harness: 'claude-code',
          session_id: 'sess-1',
          transcript_path: '/tmp/t1.jsonl',
          bound_at: 5,
          captured_at: 1_000,
        },
      ],
    };
    writeRegistry(dir, reg);
    expect(readRegistry(dir, OWNER)).toEqual(reg);
  });

  it('writes the registry 0600 — it holds local session identity', () => {
    writeRegistry(dir, { version: 1, ...OWNER, bindings: [] });
    const mode = statSync(continuityPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('discards a registry belonging to another seat rather than adopting it (ADR 143)', () => {
    writeRegistry(dir, {
      version: 1,
      team: 'revive',
      seat: 'izzo',
      bindings: [
        {
          thread_id: 'T1',
          harness: 'claude-code',
          session_id: 'not-mine',
          bound_at: 5,
          captured_at: 5,
        },
      ],
    });
    expect(readRegistry(dir, OWNER)).toEqual({ version: 1, ...OWNER, bindings: [] });
  });

  it('discards a registry belonging to another team', () => {
    writeRegistry(dir, { version: 1, team: 'dawn', seat: 'stanley', bindings: [] });
    expect(readRegistry(dir, OWNER)).toEqual({ version: 1, ...OWNER, bindings: [] });
  });

  it('discards an unparseable registry instead of throwing — it is a cache, not a source', () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(continuityPath(dir), '{ this is not json', 'utf8');
    expect(readRegistry(dir, OWNER)).toEqual({ version: 1, ...OWNER, bindings: [] });
  });

  it('discards a registry carrying an unknown field rather than half-trusting it', () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      continuityPath(dir),
      JSON.stringify({ version: 1, ...OWNER, bindings: [], workspace_path: '/Users/nick' }),
      'utf8',
    );
    expect(readRegistry(dir, OWNER)).toEqual({ version: 1, ...OWNER, bindings: [] });
  });
});

describe('bindThread (ADR 210)', () => {
  let dir: string;
  let transcript: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-continuity-'));
    // A REAL transcript file: bindThread prunes as it writes, so a binding pointing at a path that
    // does not exist is correctly dropped. The fixture has to be as real as the check.
    transcript = join(dir, 't1.jsonl');
    writeFileSync(transcript, 'x', 'utf8');
  });

  it('binds the current capture to a thread', () => {
    const bound = bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ transcript_path: transcript }),
      now: 42,
    });
    expect(bound).toBe(true);
    expect(readRegistry(dir, OWNER).bindings).toEqual([
      {
        thread_id: 'T1',
        harness: 'claude-code',
        session_id: 'sess-1',
        transcript_path: transcript,
        bound_at: 42,
        captured_at: 1_000,
      },
    ]);
  });

  it('keeps both bindings when a second thread is bound — one Member is not one session', () => {
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ transcript_path: transcript }),
      now: 42,
    });
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T2',
      capture: capture({ id: 'sess-2', started_at: 2_000, transcript_path: transcript }),
      now: 43,
    });
    const bindings = readRegistry(dir, OWNER).bindings;
    expect(bindings).toHaveLength(2);
    expect(bindings.map((b) => [b.thread_id, b.session_id])).toEqual([
      ['T1', 'sess-1'],
      ['T2', 'sess-2'],
    ]);
  });

  it('updates in place when the same thread is re-bound to a newer session', () => {
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ transcript_path: transcript }),
      now: 42,
    });
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ id: 'sess-9', started_at: 9_000, transcript_path: transcript }),
      now: 99,
    });
    expect(readRegistry(dir, OWNER).bindings).toEqual([
      {
        thread_id: 'T1',
        harness: 'claude-code',
        session_id: 'sess-9',
        transcript_path: transcript,
        bound_at: 99,
        captured_at: 9_000,
      },
    ]);
  });

  it('binds nothing when the workspace has no capture — it never invents a resume target', () => {
    const bound = bindThread(dir, { ...OWNER, thread_id: 'T1', capture: undefined, now: 42 });
    expect(bound).toBe(false);
    expect(existsSync(continuityPath(dir))).toBe(false);
  });

  it('binds nothing for a harness whose capture has no transcript path', () => {
    // A Codex seat writes no capture at all today; a capture with no transcript is equally
    // unusable, and an unusable binding is a resume attempt that will fail and cost a fallback.
    const bound = bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ transcript_path: undefined }),
      now: 42,
    });
    expect(bound).toBe(false);
  });

  it('never lets a foreign registry survive a bind — the file is rewritten under this seat', () => {
    writeRegistry(dir, { version: 1, team: 'revive', seat: 'izzo', bindings: [] });
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T1',
      capture: capture({ transcript_path: transcript }),
      now: 42,
    });
    const raw = JSON.parse(readFileSync(continuityPath(dir), 'utf8')) as { seat: string };
    expect(raw.seat).toBe('stanley');
  });
});

describe('the registry never reaches git (ADR 210)', () => {
  it('is covered by .gitignore in any folder', () => {
    // The privacy claim is a file-layout fact, so it is asserted, not asked for in review.
    const ignore = readFileSync(new URL('../../../../.gitignore', import.meta.url), 'utf8');
    expect(ignore).toMatch(/^\*\*\/\.musterd\/continuity\.json$/m);
  });

  it('is actually ignored by git, not merely pattern-matched', () => {
    const repoRoot = new URL('../../../../', import.meta.url).pathname;
    const checked = execFileSync(
      'git',
      ['check-ignore', '-q', join(repoRoot, '.musterd', 'continuity.json')],
      { cwd: repoRoot },
    );
    expect(checked.toString()).toBe('');
  });
});

describe('pruning on disk (ADR 210)', () => {
  let dir: string;
  let live: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-continuity-'));
    live = join(dir, 'live.jsonl');
    writeFileSync(live, 'x', 'utf8');
  });

  const reg = (bindings: ContinuityBinding[]) => ({ version: 1 as const, ...OWNER, bindings });
  const b = (over: Partial<ContinuityBinding>): ContinuityBinding => ({
    thread_id: 'T1',
    harness: 'claude-code',
    session_id: 'sess-1',
    transcript_path: live,
    bound_at: Date.now(),
    captured_at: Date.now(),
    ...over,
  });

  it('drops a binding whose transcript no longer exists', () => {
    writeRegistry(dir, reg([b({ transcript_path: join(dir, 'gone.jsonl') })]));
    pruneOnDisk(dir, OWNER, { now: Date.now() });
    expect(readRegistry(dir, OWNER).bindings).toEqual([]);
  });

  it('drops a binding past the harness GC horizon — a resume there would fail anyway', () => {
    const old = Date.now() - RESUME_GC_HORIZON_MS - 1_000;
    writeRegistry(dir, reg([b({ bound_at: old, captured_at: old })]));
    pruneOnDisk(dir, OWNER, { now: Date.now() });
    expect(readRegistry(dir, OWNER).bindings).toEqual([]);
  });

  it('drops a binding for a thread the caller knows has resolved', () => {
    writeRegistry(dir, reg([b({})]));
    pruneOnDisk(dir, OWNER, { now: Date.now(), resolvedThreads: new Set(['T1']) });
    expect(readRegistry(dir, OWNER).bindings).toEqual([]);
  });

  it('keeps a usable binding', () => {
    writeRegistry(dir, reg([b({})]));
    pruneOnDisk(dir, OWNER, { now: Date.now() });
    expect(readRegistry(dir, OWNER).bindings).toHaveLength(1);
  });

  it('prunes as a side effect of binding, so the file cannot grow unusable entries forever', () => {
    const old = Date.now() - RESUME_GC_HORIZON_MS - 1_000;
    writeRegistry(dir, reg([b({ thread_id: 'T-old', bound_at: old, captured_at: old })]));
    bindThread(dir, {
      ...OWNER,
      thread_id: 'T-new',
      capture: { harness: 'claude-code', id: 's', transcript_path: live, started_at: Date.now() },
      now: Date.now(),
    });
    expect(readRegistry(dir, OWNER).bindings.map((x) => x.thread_id)).toEqual(['T-new']);
  });

  it('is a no-op on a workspace with no registry file', () => {
    expect(() => pruneOnDisk(dir, OWNER, { now: Date.now() })).not.toThrow();
    expect(existsSync(continuityPath(dir))).toBe(false);
  });
});
