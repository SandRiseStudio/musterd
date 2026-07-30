import type { SessionCapture } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_MS, shouldReleaseOnVerdict } from './client.js';
import { ADOPT_SETTLE_MS, SESSION_STALE_MS, SessionAttestation } from './sessionLiveness.js';

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

/** Any moment past the settle window — nothing is adopted before it. */
const SETTLED = T0 + ADOPT_SETTLE_MS + 1;

const ours: SessionCapture = {
  harness: 'claude-code',
  id: 'sess-ours',
  transcript_path: '/t/ours.jsonl',
  started_at: T0 + 1_000,
};

describe('SessionAttestation (ADR 164)', () => {
  it('re-parenting to init is the one rung that exits, even before adoption', () => {
    const a = make(undefined, { ppid: 1 });
    expect(a.check(T0)).toEqual({ verdict: 'exit', rung: 'ppid' });
    expect(a.adoptedSession).toBeNull();
  });

  it('fails open when there is no capture at all', () => {
    expect(make(undefined).check(SETTLED)).toEqual({ verdict: 'live' });
  });

  it('adopts nothing during the settle window — the hook may not have written yet', () => {
    const a = make(ours, { mtime: SETTLED });
    expect(a.check(T0 + ADOPT_SETTLE_MS - 1)).toEqual({ verdict: 'live' });
    expect(a.adoptedSession).toBeNull();
  });

  it('adopts a live-looking capture once settled — regardless of hook/adapter ordering', () => {
    // The capture predates this process, which happens whenever the harness runs SessionStart
    // before spawning us. A started_at fence would silently never adopt; the ladder would be inert.
    const early: SessionCapture = { ...ours, started_at: T0 - 30_000 };
    const a = make(early, { mtime: SETTLED - 1_000 });
    expect(a.check(SETTLED).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-ours');
  });

  it('never adopts a corpse: an already-ended capture is somebody else’s', () => {
    const dead: SessionCapture = { ...ours, id: 'sess-old', ended_at: T0 - 30_000 };
    const a = make(dead, { mtime: SETTLED });
    expect(a.check(SETTLED)).toEqual({ verdict: 'live' });
    expect(a.adoptedSession).toBeNull();
  });

  it('never adopts a corpse: an already-stale transcript is somebody else’s', () => {
    const a = make({ ...ours, id: 'sess-old' }, { mtime: T0 - 10 * SESSION_STALE_MS });
    expect(a.check(SETTLED)).toEqual({ verdict: 'live' });
    expect(a.adoptedSession).toBeNull();
  });

  it('picks up our own capture on a later tick, after refusing the predecessor', () => {
    let session: SessionCapture = { ...ours, id: 'sess-old', ended_at: T0 - 1_000 };
    let mtime = T0 - 10 * SESSION_STALE_MS;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => session,
      statMtime: () => mtime,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(SETTLED).verdict).toBe('live');
    expect(a.adoptedSession).toBeNull();
    // SessionStart finally writes ours.
    session = ours;
    mtime = SETTLED + 1_000;
    expect(a.check(SETTLED + 15_000).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-ours');
  });

  it('a different session id in the binding is RE-ADOPTED, never treated as a takeover', () => {
    // Measured on agents-miley: a foreign 2-second capture landed in the binding while that
    // workspace's real session, alive since the previous evening, kept working. Exiting on that
    // would kill a live session's adapter. The genuine reload-orphan case is the server's job.
    let session = ours;
    let mtime = SETTLED;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => session,
      statMtime: () => mtime,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(SETTLED).verdict).toBe('live');
    session = { ...ours, id: 'sess-foreign', started_at: SETTLED + 10_000 };
    mtime = SETTLED + 10_000;
    expect(a.check(SETTLED + 11_000).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-foreign');
  });

  it('a dead foreign capture is ignored outright — we keep the session we had', () => {
    let session = ours;
    let mtime = SETTLED;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => session,
      statMtime: () => mtime,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(SETTLED).verdict).toBe('live');
    // The agents-miley shape exactly: a foreign capture that is already ended.
    session = { ...ours, id: 'sess-foreign', ended_at: SETTLED + 1_000 };
    mtime = SETTLED;
    expect(a.check(SETTLED + 11_000).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-ours');
  });

  it('SessionEnd on our own adopted session goes dormant — recoverable, not an exit', () => {
    let session = ours;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => session,
      statMtime: () => SETTLED,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(SETTLED).verdict).toBe('live');
    session = { ...ours, ended_at: SETTLED + 5_000 };
    expect(a.check(SETTLED + 6_000)).toEqual({
      verdict: 'dormant',
      rung: 'ended',
      session_id: 'sess-ours',
    });
  });

  it('a transcript quiet past the horizon goes stale — the izzo case', () => {
    const mtime = SETTLED; // the transcript is written once and then stands still
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => ours,
      statMtime: () => mtime,
      ppid: () => 4242,
      processStart: T0,
    });
    expect(a.check(SETTLED).verdict).toBe('live'); // adopts while alive
    const now = SETTLED + 12 * 3_600_000; // 12h of silence, transcript never touched again
    expect(a.check(now)).toMatchObject({
      verdict: 'dormant',
      rung: 'stale',
      session_id: 'sess-ours',
    });
  });

  it('does not trip one tick under the horizon', () => {
    const a = make(ours, { mtime: SETTLED });
    expect(a.check(SETTLED).verdict).toBe('live');
    expect(a.check(SETTLED + SESSION_STALE_MS).verdict).toBe('live');
  });

  it('a missing transcript path never demotes — harnesses that keep no transcript', () => {
    const a = make({ ...ours, transcript_path: undefined });
    expect(a.check(SETTLED).verdict).toBe('live');
    expect(a.adoptedSession).toBe('sess-ours');
    expect(a.check(SETTLED + 10 * SESSION_STALE_MS).verdict).toBe('live');
  });

  it('an unstattable transcript never demotes — the measured miley case', () => {
    const a = make(ours, { mtime: undefined });
    expect(a.check(SETTLED).verdict).toBe('live');
    expect(a.check(SETTLED + 10 * SESSION_STALE_MS).verdict).toBe('live');
  });

  it('guardrail: a seat whose transcript is written every tick never leaves', () => {
    let now = SETTLED;
    let mtime = SETTLED;
    const a = new SessionAttestation({
      bindingDir: '/ws',
      readSession: () => ours,
      statMtime: () => mtime,
      ppid: () => 4242,
      processStart: T0,
    });
    for (let i = 0; i < 500; i++) {
      now += 15_000;
      mtime = now - 1_000;
      expect(a.check(now).verdict).toBe('live');
    }
  });
});

/**
 * Activity-outranks-inference (ADR 164, seat-drop fault B2). The ladder reads disk and infers; a
 * tool call is the harness speaking first-hand. When they disagree about a session that just acted,
 * the tool call wins — otherwise a working session gets released every heartbeat on the strength of
 * a stale transcript or a neighbour's `ended_at`.
 */
describe('shouldReleaseOnVerdict — a session that just acted is not dead', () => {
  const NOW = 1_000_000;

  it('refuses to release on an inference rung when a tool call landed within the heartbeat', () => {
    expect(shouldReleaseOnVerdict('stale', NOW - 1_000, NOW)).toBe(false);
    expect(shouldReleaseOnVerdict('ended', NOW - 14_999, NOW)).toBe(false);
  });

  it('releases on an inference rung once the session has genuinely gone quiet', () => {
    expect(shouldReleaseOnVerdict('stale', NOW - HEARTBEAT_MS, NOW)).toBe(true);
    expect(shouldReleaseOnVerdict('ended', NOW - 3_600_000, NOW)).toBe(true);
    // never acted at all — the pre-activity default must not read as "just acted"
    expect(shouldReleaseOnVerdict('stale', 0, NOW)).toBe(true);
  });

  it('ALWAYS releases on ppid — an orphaned process is fact, not inference', () => {
    expect(shouldReleaseOnVerdict('ppid', NOW, NOW)).toBe(true);
    expect(shouldReleaseOnVerdict('ppid', NOW - 1, NOW)).toBe(true);
  });
});
