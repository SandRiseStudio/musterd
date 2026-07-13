import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, SessionCapture } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_SESSION_LIVE_MS, localSessionLiveness, RESUME_GC_HORIZON_MS } from './liveness.js';

/**
 * The local-session judgement (ADR 131 §5, inc 4): liveness comes from the transcript's mtime
 * (the only signal that survives a crash — SessionEnd is advisory), staleness from the capture's
 * age vs the harness GC horizon. Everything unreadable degrades to `none` (fresh-first).
 */
describe('localSessionLiveness', () => {
  let ws: string;

  const write = (session?: SessionCapture): void => {
    const binding: Binding = {
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      ...(session ? { session } : {}),
    };
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
  };
  const transcript = (ageMs: number): string => {
    const p = join(ws, 'transcript.jsonl');
    writeFileSync(p, '{"type":"turn"}\n');
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
    return p;
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-liveness-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('no binding / no capture ⇒ none (the pre-capture world)', () => {
    expect(localSessionLiveness(ws).state).toBe('none');
    write();
    expect(localSessionLiveness(ws).state).toBe('none');
  });

  it('no ended_at + freshly-touched transcript ⇒ live (a crash never wrote ended_at either)', () => {
    const p = transcript(1_000);
    write({ harness: 'claude-code', id: 's1', transcript_path: p, started_at: Date.now() });
    const v = localSessionLiveness(ws);
    expect(v.state).toBe('live');
    expect(v.transcriptBytes).toBeGreaterThan(0);
  });

  it('cleanly ended ⇒ resumable, even with a fresh transcript', () => {
    const p = transcript(1_000);
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: p,
      started_at: Date.now() - 60_000,
      ended_at: Date.now(),
    });
    expect(localSessionLiveness(ws).state).toBe('resumable');
  });

  it('no ended_at + stale transcript ⇒ resumable (crashed or idle, not live)', () => {
    const p = transcript(LOCAL_SESSION_LIVE_MS + 60_000);
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: p,
      started_at: Date.now() - 3_600_000,
    });
    expect(localSessionLiveness(ws).state).toBe('resumable');
  });

  it('capture past the GC horizon ⇒ gc-expired (resume would fail; go fresh)', () => {
    const p = transcript(LOCAL_SESSION_LIVE_MS + 60_000);
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: p,
      started_at: Date.now() - RESUME_GC_HORIZON_MS - 1_000,
    });
    expect(localSessionLiveness(ws).state).toBe('gc-expired');
  });

  it('a missing transcript file is never live; the capture stays resumable for the ladder to judge', () => {
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: join(ws, 'gone.jsonl'),
      started_at: Date.now(),
    });
    const v = localSessionLiveness(ws);
    expect(v.state).toBe('resumable');
    expect(v.transcriptBytes).toBeUndefined();
  });
});
