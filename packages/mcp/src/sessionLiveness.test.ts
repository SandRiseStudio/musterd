import type { SessionCapture } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { SESSION_STALE_MS, SessionAttestation } from './sessionLiveness.js';

const T0 = 1_700_000_000_000;

function make(
  session: SessionCapture | undefined,
  opts: { mtime?: number; ppid?: number; processStart?: number } = {},
) {
  return new SessionAttestation({
    bindingDir: '/ws',
    readSession: () => session,
    statMtime: () => opts.mtime,
    ppid: () => opts.ppid ?? 4242,
    processStart: opts.processStart ?? T0,
  });
}

const ours: SessionCapture = {
  harness: 'claude-code',
  id: 'sess-ours',
  transcript_path: '/t/ours.jsonl',
  started_at: T0 + 1_000,
};

describe('SessionAttestation (ADR 164)', () => {
  it('re-parenting to init is definitive, even before any session is adopted', () => {
    const a = make(undefined, { ppid: 1 });
    expect(a.check(T0)).toEqual({ verdict: 'orphan', rung: 'ppid' });
    expect(a.adoptedSession).toBeNull();
  });

  it('fails open when there is no capture at all', () => {
    expect(make(undefined).check(T0)).toEqual({ verdict: 'live' });
  });

  it('adopts a session that started no earlier than this process', () => {
    const a = make(ours, { mtime: T0 + 2_000 });
    expect(a.check(T0 + 3_000).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-ours');
  });

  it('never adopts a predecessor session, and judges nothing while un-adopted', () => {
    const older: SessionCapture = { ...ours, id: 'sess-old', started_at: T0 - 60_000 };
    // The boot race: SessionStart has not written yet, so we see the PREVIOUS session — which is
    // already ended and long stale. Judging it would make us exit ourselves, exactly backwards.
    const a = make({ ...older, ended_at: T0 - 30_000 }, { mtime: T0 - 10 * SESSION_STALE_MS });
    expect(a.check(T0)).toEqual({ verdict: 'live' });
    expect(a.adoptedSession).toBeNull();
  });

  it('a successor session in the workspace means we are a reload orphan', () => {
    let session = ours;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => session,
      statMtime: () => T0 + 2_000,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(T0 + 3_000).verdict).toBe('live');
    session = { ...ours, id: 'sess-next', started_at: T0 + 10_000 };
    expect(a.check(T0 + 11_000)).toEqual({
      verdict: 'orphan',
      rung: 'successor',
      session_id: 'sess-ours',
    });
  });

  it('SessionEnd on our own session exits', () => {
    const a = make({ ...ours, ended_at: T0 + 5_000 }, { mtime: T0 + 2_000 });
    expect(a.check(T0 + 6_000)).toEqual({
      verdict: 'orphan',
      rung: 'ended',
      session_id: 'sess-ours',
    });
  });

  it('a transcript quiet past the horizon goes stale — the izzo case', () => {
    const a = make(ours, { mtime: T0 + 2_000 });
    const now = T0 + 2_000 + 12 * 3_600_000; // 12h of silence
    expect(a.check(now)).toMatchObject({
      verdict: 'stale',
      rung: 'stale',
      session_id: 'sess-ours',
    });
  });

  it('does not trip one tick under the horizon', () => {
    const a = make(ours, { mtime: T0 + 2_000 });
    expect(a.check(T0 + 2_000 + SESSION_STALE_MS).verdict).toBe('live');
  });

  it('a missing transcript path never demotes — harnesses that keep no transcript', () => {
    const a = make({ ...ours, transcript_path: undefined });
    expect(a.check(T0 + 10 * SESSION_STALE_MS).verdict).toBe('live');
  });

  it('an unstattable transcript never demotes — the measured miley case', () => {
    const a = make(ours, { mtime: undefined });
    expect(a.check(T0 + 10 * SESSION_STALE_MS).verdict).toBe('live');
  });

  it('guardrail: a seat whose transcript is written every tick never leaves', () => {
    const a = make(ours, { mtime: T0 });
    let now = T0 + 1_000;
    for (let i = 0; i < 500; i++) {
      now += 15_000;
      const live = new SessionAttestation({
        bindingDir: '/ws',
        readSession: () => ours,
        statMtime: () => now - 1_000,
        ppid: () => 4242,
        processStart: T0,
      });
      expect(live.check(now).verdict).toBe('live');
    }
    expect(a.check(T0 + 1_000).verdict).toBe('live');
  });
});
