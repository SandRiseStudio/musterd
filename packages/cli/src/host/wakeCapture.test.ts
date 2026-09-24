import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, SessionCapture } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enumerateGrokSessions, resetSessionScan } from '../session/enumerate.js';
import { localSessionLiveness } from '../session/liveness.js';
import { findGrokWakeSessionId } from './backends/grokUsage.js';
import { endWakeCapture } from './wakeCapture.js';

/**
 * ADR 436 clause 4 — liveness: a wake that settled is over. The evidence was grokbot's handoff wake,
 * deferred `local-session-live` twice on 2026-09-21 with no grok process running: the finished
 * wake's summary.json read live for LOCAL_SESSION_LIVE_MS because nothing marked it ended, and the
 * capture named a `wake-<lease>` placeholder that enumeration could never match.
 */
let ws: string;
let home: string;

const write = (session?: SessionCapture): void => {
  const binding: Binding = {
    version: 2,
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    claim: { mode: 'seat', name: 'grokbot' },
    agent_key: 'mskey_test',
    ...(session ? { session } : {}),
  };
  mkdirSync(join(ws, '.musterd'), { recursive: true });
  writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
};
const captured = (): SessionCapture | undefined =>
  (JSON.parse(readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8')) as Binding).session;

/** A Grok session as the CLI writes it: `sessions/<encoded cwd>/<id>/summary.json`. */
const grokSession = (
  id: string,
  kind: 'headless' | 'interactive',
  created: number,
  active: number,
) => {
  const dir = join(home, 'sessions', encodeURIComponent(ws), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id, cwd: ws },
      session_kind: kind,
      created_at: new Date(created).toISOString(),
      last_active_at: new Date(active).toISOString(),
    }),
  );
};
const grokLiveness = () => {
  resetSessionScan();
  return localSessionLiveness(ws, Date.now(), (dir) => enumerateGrokSessions(dir, home), 'grok');
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'musterd-wake-capture-ws-'));
  home = mkdtempSync(join(tmpdir(), 'musterd-wake-capture-grok-'));
});
afterEach(() => {
  resetSessionScan();
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('endWakeCapture (ADR 436 clause 4)', () => {
  it('a settled Grok wake reads ended, not live — the next wake is not deferred', () => {
    const spawnedAt = Date.now() - 120_000;
    write({ harness: 'grok', id: 'wake-L1', started_at: spawnedAt });
    grokSession('grok-real', 'headless', spawnedAt + 2_000, Date.now() - 5_000);
    // The bug: the finished wake's summary reads live for the whole window.
    expect(grokLiveness().state).toBe('live');

    const stamped = endWakeCapture(ws, {
      harness: 'grok',
      ids: ['wake-L1'],
      id: findGrokWakeSessionId(ws, spawnedAt, home),
    });

    expect(stamped).toBe(true);
    expect(captured()).toMatchObject({ harness: 'grok', id: 'grok-real' });
    expect(captured()?.ended_at).toBeTypeOf('number');
    const after = grokLiveness();
    expect(after.state).toBe('resumable');
    expect(after.slotState).not.toBe('live');
  });

  it('GUARDRAIL (ADR 166): a different live session beside the ended capture stays live', () => {
    const spawnedAt = Date.now() - 120_000;
    write({ harness: 'grok', id: 'wake-L1', started_at: spawnedAt });
    grokSession('grok-real', 'headless', spawnedAt + 2_000, Date.now() - 20_000);
    grokSession('human', 'interactive', spawnedAt + 30_000, Date.now() - 1_000);

    endWakeCapture(ws, {
      harness: 'grok',
      ids: ['wake-L1'],
      id: findGrokWakeSessionId(ws, spawnedAt, home),
    });

    // The wake's id is the headless one — never the human's newer interactive session.
    expect(captured()?.id).toBe('grok-real');
    expect(grokLiveness().state).toBe('live');
  });

  it("never stamps a session that took the slot mid-wake — it is someone else's", () => {
    write({ harness: 'claude-code', id: 'human-opened', started_at: Date.now() });
    expect(endWakeCapture(ws, { harness: 'claude-code', ids: ['wake-minted'] })).toBe(false);
    expect(captured()?.ended_at).toBeUndefined();
  });

  it('leaves an already-ended capture alone (the SessionEnd hook got there first)', () => {
    write({ harness: 'codex', id: 't1', started_at: 1, ended_at: 42 });
    expect(endWakeCapture(ws, { harness: 'codex', ids: ['t1'], endedAt: 99 })).toBe(false);
    expect(captured()?.ended_at).toBe(42);
  });

  it('is idempotent and never throws on a workspace with no binding', () => {
    expect(endWakeCapture(ws, { harness: 'grok', ids: ['x'] })).toBe(false);
    write({ harness: 'opencode', id: 's1', started_at: 1 });
    expect(endWakeCapture(ws, { harness: 'opencode', ids: ['s1', undefined], endedAt: 7 })).toBe(
      true,
    );
    expect(endWakeCapture(ws, { harness: 'opencode', ids: ['s1'], endedAt: 8 })).toBe(false);
    expect(captured()?.ended_at).toBe(7);
  });
});

describe('findGrokWakeSessionId', () => {
  it('names the newest headless session created at-or-after the spawn', () => {
    const t = Date.now();
    grokSession('before', 'headless', t - 60_000, t - 60_000);
    grokSession('wake', 'headless', t + 1_000, t + 5_000);
    grokSession('human', 'interactive', t + 2_000, t + 6_000);
    expect(findGrokWakeSessionId(ws, t, home)).toBe('wake');
  });

  it('is undefined ("cannot tell") when nothing qualifies or the directory is missing', () => {
    expect(findGrokWakeSessionId(ws, Date.now(), home)).toBeUndefined();
    grokSession('old', 'headless', Date.now() - 60_000, Date.now());
    expect(findGrokWakeSessionId(ws, Date.now(), home)).toBeUndefined();
  });
});
