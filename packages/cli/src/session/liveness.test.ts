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
 * ADR 166 increment 2 — THE FLIP. When the harness can enumerate, the enumerated judgement decides
 * and the slot is demoted to resume material plus a recorded counter-verdict. The guardrail from the
 * ADR: no workspace whose transcript is being written may be judged not-live, regardless of what the
 * slot holds — including an ended foreign capture (the agents-stanley shape exactly).
 */
describe('the flip (ADR 166 increment 2)', () => {
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

  it("falls back to the slot when the harness cannot enumerate — unchanged, with today's risk", () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => undefined);
    expect(out.state).toBe('resumable');
    expect(out.source).toBe('slot');
    expect(out.enumerated).toBeUndefined();
    expect(out.slotState).toBeUndefined();
  });

  it('GUARDRAIL: a transcript being written reads live, whatever the slot holds (agents-stanley shape)', () => {
    phantomSlot(); // ended foreign capture, transcript never written — the slot says resumable
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'real-079ec165', path: '/t/real.jsonl', mtime: NOW - 5_000, bytes: 100 },
    ]);
    expect(out.state).toBe('live'); // the enumerated judgement DECIDES now
    expect(out.source).toBe('enumerated');
    expect(out.enumerated).toMatchObject({ state: 'live', id: 'real-079ec165', count: 1 });
    expect(out.slotState).toBe('resumable');
    expect(out.disagreed).toBe(true);
    expect(out.session?.id).toBe('foreign-4aea2026'); // resume material still rides along
  });

  it('liveness is ANY session still being written, not merely the newest', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'newer-but-dead', path: '/t/a.jsonl', mtime: NOW - 40 * 60_000, bytes: 10 },
      { id: 'older-but-live', path: '/t/b.jsonl', mtime: NOW - 5_000, bytes: 10 },
    ]);
    expect(out.state).toBe('live');
    expect(out.enumerated?.count).toBe(2);
  });

  it('agreement records no disagreement and no demotion', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'quiet', path: '/t/q.jsonl', mtime: NOW - 40 * 60_000, bytes: 10 },
    ]);
    expect(out).toMatchObject({ state: 'resumable', source: 'enumerated', disagreed: false });
    expect(out.demoted).toBeUndefined();
  });

  it('an empty directory is evidence (none), not ignorance (undefined)', () => {
    phantomSlot();
    const out = localSessionLiveness(ws, NOW, () => []);
    expect(out).toMatchObject({ state: 'none', source: 'enumerated', disagreed: true });
    expect(out.enumerated).toMatchObject({ state: 'none', count: 0 });
  });

  it('flags demotion — slot says live, enumeration disagrees (the flip-blocking direction, watched)', () => {
    // A live-by-slot capture whose transcript is fresh, but enumeration sees only a stale session:
    // enumeration would demote a session the slot believes is live. Target zero in the fleet; the
    // flag exists so the sweep can see any instance.
    const p = join(ws, 'slot.jsonl');
    writeFileSync(p, '{"type":"turn"}\n');
    const t = (NOW - 1_000) / 1000;
    utimesSync(p, t, t);
    const binding: Binding = {
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      session: { harness: 'claude-code', id: 's1', transcript_path: p, started_at: NOW - 60_000 },
    };
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 'stale', path: '/t/s.jsonl', mtime: NOW - 40 * 60_000, bytes: 10 },
    ]);
    expect(out).toMatchObject({ state: 'resumable', slotState: 'live', demoted: true });
  });

  it('ADR 199: clean ended_at outranks warm mtime when enumeration names the same session', () => {
    const binding: Binding = {
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      session: {
        harness: 'claude-code',
        id: 's1',
        transcript_path: join(ws, 't.jsonl'),
        started_at: NOW - 60_000,
        ended_at: NOW - 1_000,
      },
    };
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
    const out = localSessionLiveness(ws, NOW, () => [
      { id: 's1', path: '/t/s1.jsonl', mtime: NOW - 5_000, bytes: 100 },
    ]);
    expect(out.state).toBe('resumable');
    expect(out.source).toBe('enumerated');
    expect(out.enumerated?.state).toBe('live'); // raw enum still saw warm mtime
    expect(out.slotState).toBe('resumable');
  });

  it('ADR 265: a live CLI transcript via enumeration beats a stale desktop slot', () => {
    const NOW = Date.now();
    const p = join(ws, 'desktop.jsonl');
    writeFileSync(p, '{"role":"user"}\n');
    const stale = (NOW - LOCAL_SESSION_LIVE_MS - 60_000) / 1000;
    utimesSync(p, stale, stale);
    const binding: Binding = {
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      surface: 'cursor',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      session: {
        harness: 'cursor',
        id: 'desktop',
        transcript_path: p,
        started_at: NOW - 3_600_000,
      },
    };
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding) + '\n');
    const out = localSessionLiveness(
      ws,
      NOW,
      () => [{ id: 'cli', path: '/t/cli.txt', mtime: NOW - 1_000, bytes: 80 }],
      'cursor',
    );
    expect(out.state).toBe('live');
    expect(out.source).toBe('enumerated');
    expect(out.enumerated?.id).toBe('cli');
    expect(out.slotState).toBe('resumable');
  });
});
