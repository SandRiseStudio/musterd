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
  /** These test the SLOT. A null enumerator keeps them hermetic — no real ~/.claude scan, no
   *  dependence on what sessions happen to exist on the machine running the suite. */
  const noEnum = () => undefined;

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
    expect(localSessionLiveness(ws, Date.now(), noEnum).state).toBe('none');
    write();
    expect(localSessionLiveness(ws, Date.now(), noEnum).state).toBe('none');
  });

  it('no ended_at + freshly-touched transcript ⇒ live (a crash never wrote ended_at either)', () => {
    const p = transcript(1_000);
    write({ harness: 'claude-code', id: 's1', transcript_path: p, started_at: Date.now() });
    const v = localSessionLiveness(ws, Date.now(), noEnum);
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
    expect(localSessionLiveness(ws, Date.now(), noEnum).state).toBe('resumable');
  });

  it('no ended_at + stale transcript ⇒ resumable (crashed or idle, not live)', () => {
    const p = transcript(LOCAL_SESSION_LIVE_MS + 60_000);
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: p,
      started_at: Date.now() - 3_600_000,
    });
    expect(localSessionLiveness(ws, Date.now(), noEnum).state).toBe('resumable');
  });

  it('capture past the GC horizon ⇒ gc-expired (resume would fail; go fresh)', () => {
    const p = transcript(LOCAL_SESSION_LIVE_MS + 60_000);
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: p,
      started_at: Date.now() - RESUME_GC_HORIZON_MS - 1_000,
    });
    expect(localSessionLiveness(ws, Date.now(), noEnum).state).toBe('gc-expired');
  });

  it('a missing transcript file is never live; the capture stays resumable for the ladder to judge', () => {
    write({
      harness: 'claude-code',
      id: 's1',
      transcript_path: join(ws, 'gone.jsonl'),
      started_at: Date.now(),
    });
    const v = localSessionLiveness(ws, Date.now(), noEnum);
    expect(v.state).toBe('resumable');
    expect(v.transcriptBytes).toBeUndefined();
  });
});

/**
 * ADR 166 increment 1. The challenger is computed and recorded; the incumbent still decides. These
 * tests exist to prove the shadow is INERT as much as to prove it is right.
 */
describe('shadow judgement (ADR 166 increment 1)', () => {
  let ws: string;
  const NOW = 1_700_000_000_000;

  /** The agents-stanley shape: a foreign, already-ended capture whose transcript was never written. */
  const phantomSlot = (): void => {
    const binding: Binding = {
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      session: {
        harness: 'claude-code',
        id: 'foreign-4aea2026',
        transcript_path: join(ws, 'never-written.jsonl'),
        started_at: NOW - 60_000,
        ended_at: NOW - 30_000,
      },
    };
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-shadow-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('is absent when the harness cannot enumerate — nothing to compare, nothing to learn', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => undefined);
    expect(out.shadow).toBeUndefined();
    expect(out.state).toBe('resumable');
  });

  it('flags the DANGEROUS disagreement: slot says not-live while a transcript is being written', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'real-079ec165', path: '/t/real.jsonl', mtime: NOW - 5_000, bytes: 100 },
    ]);
    expect(out.state).toBe('resumable'); // the INCUMBENT still decides — the shadow decides nothing
    expect(out.shadow).toMatchObject({
      state: 'live',
      id: 'real-079ec165',
      disagreed: true,
      dangerous: true,
      count: 1,
    });
  });

  it('liveness is ANY session still being written, not merely the newest', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'newer-but-dead', path: '/t/a.jsonl', mtime: NOW - 40 * 60_000, bytes: 10 },
      { id: 'older-but-live', path: '/t/b.jsonl', mtime: NOW - 5_000, bytes: 10 },
    ]);
    expect(out.shadow?.state).toBe('live');
    expect(out.shadow?.count).toBe(2);
  });

  it('agreement carries no dangerous flag', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'quiet', path: '/t/q.jsonl', mtime: NOW - 40 * 60_000, bytes: 10 },
    ]);
    expect(out.shadow).toMatchObject({ state: 'resumable', disagreed: false });
    expect(out.shadow?.dangerous).toBeUndefined();
  });

  it('an empty directory is evidence (none), not ignorance (undefined)', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => []);
    expect(out.shadow).toMatchObject({ state: 'none', count: 0, disagreed: true });
    expect(out.shadow?.dangerous).toBeUndefined();
  });
});
