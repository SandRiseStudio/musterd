import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingSchema, type Binding } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { LOCAL_SESSION_LIVE_MS } from '../session/liveness.js';
import {
  attestSlotIfUnattested,
  captureSession,
  LABEL_SWEEP_STALE_MS,
  labelSweepDue,
  lookupCcdMeta,
  observeCursorSession,
  OBSERVATION_REFRESH_MS,
  refreshModelObservation,
  resolveLabels,
  scanCcd,
  sessionCommand,
  stampLabelSweep,
} from './session.js';

/**
 * Session capture (ADR 131 §5, inc 4) — the workspace-anchoring and never-fail contracts. All
 * writes land in temp workspaces (spied cwd + no MUSTERD_BINDING), never a real binding.json:
 * the ambient-cwd clobber (ADR 018) is the incident class this command exists to avoid repeating.
 */
describe('musterd session (capture)', () => {
  let wsA: string; // the workspace the hook payload names
  let wsB: string; // a sibling worktree the process cwd wanders into
  const savedBindingEnv = process.env['MUSTERD_BINDING'];

  const bindingOf = (over: Partial<Binding> = {}): Binding => ({
    version: 2,
    server: 'http://127.0.0.1:1', // nothing listens — the attestation push must fail silently
    team: 'dawn',
    claim: { mode: 'seat', name: 'scout' },
    agent_key: 'mskey_test',
    grant: 'msgr_standing',
    model: 'claude-test-1',
    ...over,
  });

  const writeBinding = (ws: string, binding: Binding): void => {
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  };
  const readBinding = (ws: string): Binding =>
    JSON.parse(readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8')) as Binding;

  beforeEach(() => {
    wsA = mkdtempSync(join(tmpdir(), 'musterd-session-a-'));
    wsB = mkdtempSync(join(tmpdir(), 'musterd-session-b-'));
    writeBinding(wsA, bindingOf());
    writeBinding(wsB, bindingOf({ claim: { mode: 'seat', name: 'other' } }));
    vi.spyOn(process, 'cwd').mockReturnValue(wsB);
    delete process.env['MUSTERD_BINDING'];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedBindingEnv === undefined) delete process.env['MUSTERD_BINDING'];
    else process.env['MUSTERD_BINDING'] = savedBindingEnv;
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  it('start anchors to the payload cwd walk-up, NEVER the process cwd (the ADR 018 regression)', async () => {
    const sub = join(wsA, 'deep', 'sub');
    mkdirSync(sub, { recursive: true });
    await captureSession('start', {
      session_id: 'sid-1',
      transcript_path: join(wsA, 't.jsonl'),
      cwd: sub,
    });
    // The named workspace got the capture, with the secrets and model carried through…
    const a = readBinding(wsA);
    expect(a.session).toMatchObject({
      harness: 'claude-code',
      id: 'sid-1',
      transcript_path: join(wsA, 't.jsonl'),
    });
    expect(a.session!.started_at).toBeGreaterThan(0);
    expect(a.session!.ended_at).toBeUndefined();
    expect(a.agent_key).toBe('mskey_test');
    expect(a.grant).toBe('msgr_standing');
    expect(a.model).toBe('claude-test-1');
    // …and the sibling the process cwd pointed at is untouched.
    expect(readBinding(wsB).session).toBeUndefined();
  });

  it('an explicit MUSTERD_BINDING wins over the payload cwd', async () => {
    process.env['MUSTERD_BINDING'] = join(wsB, '.musterd', 'binding.json');
    await captureSession('start', { session_id: 'sid-env', cwd: wsA });
    expect(readBinding(wsB).session?.id).toBe('sid-env');
    expect(readBinding(wsA).session).toBeUndefined();
  });

  it('end stamps ended_at on the matching capture only; a mismatched id is a no-op', async () => {
    await captureSession('start', { session_id: 'sid-1', cwd: wsA });
    await captureSession('end', { session_id: 'sid-other', cwd: wsA });
    expect(readBinding(wsA).session?.ended_at).toBeUndefined();
    await captureSession('end', { session_id: 'sid-1', cwd: wsA });
    const s = readBinding(wsA).session!;
    expect(s.id).toBe('sid-1');
    expect(s.ended_at).toBeGreaterThan(0);
  });

  it('a new start overwrites a previous (ended) capture — newest session wins', async () => {
    await captureSession('start', { session_id: 'sid-1', cwd: wsA });
    await captureSession('end', { session_id: 'sid-1', cwd: wsA });
    await captureSession('start', { session_id: 'sid-2', cwd: wsA });
    const s = readBinding(wsA).session!;
    expect(s.id).toBe('sid-2');
    expect(s.ended_at).toBeUndefined();
  });

  // ADR 252: the wake token the actuator stamps on a woken child rides the attestation, so an
  // expired lease can still be known to have PAID for a session. Never defaulted — an ordinary
  // session attests nothing rather than claiming a lease it knows nothing about (ADR 236).
  describe('the wake lease travels with the capture', () => {
    const savedLease = process.env['MUSTERD_WAKE_LEASE'];
    afterEach(() => {
      if (savedLease === undefined) delete process.env['MUSTERD_WAKE_LEASE'];
      else process.env['MUSTERD_WAKE_LEASE'] = savedLease;
    });

    it('attests MUSTERD_WAKE_LEASE when the session was spawned by a wake', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      process.env['MUSTERD_WAKE_LEASE'] = 'lease-abc';
      await captureSession('start', { session_id: 'woken-1', cwd: wsA });
      expect(attest).toHaveBeenCalledWith(
        'dawn',
        expect.objectContaining({ wake_lease: 'lease-abc' }),
      );
    });

    it('omits the field entirely when unset — an unwoken session claims no lease', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      delete process.env['MUSTERD_WAKE_LEASE'];
      await captureSession('start', { session_id: 'ordinary-1', cwd: wsA });
      expect(attest).toHaveBeenCalledTimes(1);
      expect(attest.mock.calls[0]![1]).not.toHaveProperty('wake_lease');
    });
  });

  // ── The interloper gate (lane 01KZAEGF2K step 3) ─────────────────────────────────────────────
  // Measured 2026-08-06: empty ~4s claude-code processes fired real SessionStart/SessionEnd hooks
  // in seat folders, captured the slot on start, and their honest `ended` demoted the LIVE session
  // mid-work (same-digest pairs, no transcript, no marker — the ADR 108 probe-displacement shape,
  // applied to capture). The gate: a newcomer may not TAKE a live-looking slot until its own
  // transcript shows a turn. Empty slot / ended slot / stale slot keep today's newest-wins.
  describe('the interloper gate — an empty newcomer cannot steal a live slot', () => {
    /** A transcript with one real user turn, mtime = now (a live working session's). */
    const liveTranscript = (ws: string, name: string): string => {
      const p = join(ws, `${name}.jsonl`);
      writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
      return p;
    };

    it('gates an empty newcomer: live un-ended slot survives, nothing is attested', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      const t = liveTranscript(wsA, 'live-1');
      await captureSession('start', { session_id: 'live-1', cwd: wsA, transcript_path: t });
      attest.mockClear();
      // The interloper: fresh id, transcript path that does not exist (it never wrote one).
      await captureSession('start', {
        session_id: 'ghost-1',
        cwd: wsA,
        transcript_path: join(wsA, 'ghost-1.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('live-1'); // slot untouched
      expect(attest).not.toHaveBeenCalled(); // no captured row → its later `ended` cannot demote
      // …and its `end` is already a no-op (mismatched id), so the pair vanishes entirely.
      await captureSession('end', { session_id: 'ghost-1', cwd: wsA });
      expect(readBinding(wsA).session?.ended_at).toBeUndefined();
    });

    it('a newcomer WITH a turn in its transcript still takes a live slot (genuine turnover)', async () => {
      const t1 = liveTranscript(wsA, 'live-1');
      await captureSession('start', { session_id: 'live-1', cwd: wsA, transcript_path: t1 });
      const t2 = liveTranscript(wsA, 'live-2'); // resumed/real session: has a user turn already
      await captureSession('start', { session_id: 'live-2', cwd: wsA, transcript_path: t2 });
      expect(readBinding(wsA).session?.id).toBe('live-2');
    });

    it('an empty newcomer takes an ENDED slot — quit→reopen keeps newest-wins', async () => {
      const t = liveTranscript(wsA, 'live-1');
      await captureSession('start', { session_id: 'live-1', cwd: wsA, transcript_path: t });
      await captureSession('end', { session_id: 'live-1', cwd: wsA });
      await captureSession('start', {
        session_id: 'fresh-2',
        cwd: wsA,
        transcript_path: join(wsA, 'fresh-2.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('fresh-2');
    });

    it('an empty newcomer takes a STALE slot — the crashed-predecessor residual is bounded', async () => {
      const t = liveTranscript(wsA, 'live-1');
      utimesSync(t, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
      await captureSession('start', { session_id: 'live-1', cwd: wsA, transcript_path: t });
      // Slot un-ended, but its transcript went quiet past LOCAL_SESSION_LIVE_MS — not live-looking.
      const slot = readBinding(wsA).session!;
      writeBinding(wsA, { ...readBinding(wsA), session: slot });
      await captureSession('start', {
        session_id: 'fresh-2',
        cwd: wsA,
        transcript_path: join(wsA, 'fresh-2.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('fresh-2');
    });

    it('a slot with NO transcript path is not live-looking — newcomer takes it', async () => {
      await captureSession('start', { session_id: 'live-1', cwd: wsA }); // no transcript_path
      await captureSession('start', {
        session_id: 'fresh-2',
        cwd: wsA,
        transcript_path: join(wsA, 'fresh-2.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('fresh-2');
    });

    it('gates an empty newcomer when the occupant named a transcript that is not on disk yet', async () => {
      // Measured 2026-08-12 (/clear): SessionStart names transcript_path, but the file appears at
      // first turn, not at start. slotLooksLive's stat threw, the live occupant read as not-live,
      // and interloper 1261e672 took the slot 4s later. An occupant captured just now is live by
      // construction — started_at is already in the slot and needs no filesystem.
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      const namedButMissing = join(wsA, 'newborn.jsonl'); // do not write the file
      await captureSession('start', {
        session_id: 'live-1',
        cwd: wsA,
        transcript_path: namedButMissing,
      });
      attest.mockClear();
      await captureSession('start', {
        session_id: 'ghost-1',
        cwd: wsA,
        transcript_path: join(wsA, 'ghost-1.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('live-1');
      expect(attest).not.toHaveBeenCalled();
      await captureSession('end', { session_id: 'ghost-1', cwd: wsA });
      expect(readBinding(wsA).session?.ended_at).toBeUndefined();
    });

    it('an empty newcomer takes a named-but-missing occupant past LOCAL_SESSION_LIVE_MS', async () => {
      // The crashed-predecessor residual: SessionStart named a path that never appeared, and
      // the clock has run out. Newest-wins resumes — same bound as a quiet transcript.
      const namedButMissing = join(wsA, 'vanished.jsonl');
      await captureSession('start', {
        session_id: 'live-1',
        cwd: wsA,
        transcript_path: namedButMissing,
      });
      const binding = readBinding(wsA);
      writeBinding(wsA, {
        ...binding,
        session: { ...binding.session!, started_at: Date.now() - LOCAL_SESSION_LIVE_MS - 1 },
      });
      await captureSession('start', {
        session_id: 'fresh-2',
        cwd: wsA,
        transcript_path: join(wsA, 'fresh-2.jsonl'),
      });
      expect(readBinding(wsA).session?.id).toBe('fresh-2');
    });
  });

  it('never fails, never writes: no session_id / no workspace on the walk-up', async () => {
    await captureSession('start', { cwd: wsA }); // hook fired with no id
    expect(readBinding(wsA).session).toBeUndefined();
    const bare = mkdtempSync(join(tmpdir(), 'musterd-session-bare-'));
    try {
      await captureSession('start', { session_id: 'sid-1', cwd: bare }); // not a musterd workspace
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('the attestation push failing (dead daemon) leaves the local capture intact and exits clean', async () => {
    // binding.server points at a closed port — captureSession already awaited it silently above,
    // but assert the ordering contract explicitly: local write survives the failed push.
    await captureSession('start', { session_id: 'sid-1', cwd: wsA });
    expect(readBinding(wsA).session?.id).toBe('sid-1');
  });

  it('start/end without --stdin is a usage error (exit 2), pointing humans at show', async () => {
    await expect(sessionCommand(parseArgs(['start']))).rejects.toMatchObject({ exitCode: 2 });
    await expect(sessionCommand(parseArgs(['end']))).rejects.toMatchObject({ exitCode: 2 });
    await expect(sessionCommand(parseArgs(['bogus']))).rejects.toMatchObject({ exitCode: 2 });
  });

  describe('model observation', () => {
    const transcript = (ws: string, model: string): string => {
      const p = join(ws, 't.jsonl');
      writeFileSync(p, JSON.stringify({ message: { role: 'assistant', model } }) + '\n', 'utf8');
      return p;
    };

    it('records what the harness is running, WITHOUT touching the declaration', async () => {
      // The incident shape: binding declares one model, the harness runs another.
      writeBinding(wsA, bindingOf({ model: 'grok-4.5' }));
      await captureSession('start', {
        session_id: 'sid-1',
        transcript_path: transcript(wsA, 'claude-opus-4-8'),
        cwd: wsA,
      });
      const a = readBinding(wsA);
      expect(a.model_observed).toMatchObject({
        model: 'claude-opus-4-8',
        harness: 'claude-code',
      });
      expect(a.model_observed!.observed_at).toBeGreaterThan(0);
      // The declaration survives untouched — that is what leaves the tripwire something to compare.
      expect(a.model).toBe('grok-4.5');
    });

    it('leaves no observation when the transcript yields nothing, and still captures', async () => {
      await captureSession('start', {
        session_id: 'sid-1',
        transcript_path: join(wsA, 'nope.jsonl'),
        cwd: wsA,
      });
      const a = readBinding(wsA);
      expect(a.model_observed).toBeUndefined();
      expect(a.session?.id).toBe('sid-1'); // the capture itself still succeeded
    });

    it('KEEPS a prior observation when a later session observes nothing', async () => {
      // Losing a good observation to an unreadable transcript would re-open the lie.
      await captureSession('start', {
        session_id: 'sid-1',
        transcript_path: transcript(wsA, 'claude-opus-4-8'),
        cwd: wsA,
      });
      await captureSession('start', {
        session_id: 'sid-2',
        transcript_path: join(wsA, 'gone.jsonl'),
        cwd: wsA,
      });
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-4-8');
    });

    it('a newer observation replaces an older one (newest-wins)', async () => {
      await captureSession('start', {
        session_id: 'sid-1',
        transcript_path: transcript(wsA, 'claude-sonnet-5'),
        cwd: wsA,
      });
      await captureSession('start', {
        session_id: 'sid-2',
        transcript_path: transcript(wsA, 'claude-opus-4-8'),
        cwd: wsA,
      });
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-4-8');
    });

    it('observes only the workspace the payload names, never the process cwd sibling', async () => {
      await captureSession('start', {
        session_id: 'sid-1',
        transcript_path: transcript(wsA, 'claude-opus-4-8'),
        cwd: wsA,
      });
      expect(readBinding(wsB).model_observed).toBeUndefined();
    });

    it('SessionEnd does not write an observation (start is the observing event)', async () => {
      const t = transcript(wsA, 'claude-opus-4-8');
      await captureSession('start', { session_id: 'sid-1', cwd: wsA }); // no transcript on start
      await captureSession('end', { session_id: 'sid-1', transcript_path: t, cwd: wsA });
      expect(readBinding(wsA).model_observed).toBeUndefined();
    });
  });

  describe('observeCursorSession (ADR 198)', () => {
    it('stamps harness:cursor and observes model_id without a transcript', async () => {
      writeBinding(wsA, bindingOf({ model: 'grok-4.5' }));
      const got = await observeCursorSession({
        session_id: 'conv-1',
        model_id: 'claude-opus-4-7',
        model: 'thinking-slug',
        cwd: wsA,
      });
      expect(got).toBe('claude-opus-4-7');
      const a = readBinding(wsA);
      expect(a.session).toMatchObject({ harness: 'cursor', id: 'conv-1' });
      expect(a.model_observed).toMatchObject({ model: 'claude-opus-4-7', harness: 'cursor' });
      expect(a.model).toBe('grok-4.5'); // declaration untouched
    });

    it('prefers model_id over model, and falls back to model', async () => {
      await observeCursorSession({ session_id: 'c1', model: 'gpt-5.6-sol', cwd: wsA });
      expect(readBinding(wsA).model_observed?.model).toBe('gpt-5.6-sol');
    });

    it('throttles identical observations within OBSERVATION_REFRESH_MS', async () => {
      await observeCursorSession({
        session_id: 'c1',
        model_id: 'claude-opus-4-7',
        cwd: wsA,
      });
      const firstAt = readBinding(wsA).model_observed!.observed_at;
      const again = await observeCursorSession({
        session_id: 'c1',
        model_id: 'claude-opus-4-7',
        cwd: wsA,
      });
      expect(again).toBeUndefined();
      expect(readBinding(wsA).model_observed!.observed_at).toBe(firstAt);
    });

    it('re-observes when the dropdown switches to a new model_id', async () => {
      await observeCursorSession({ session_id: 'c1', model_id: 'claude-opus-4-7', cwd: wsA });
      const got = await observeCursorSession({
        session_id: 'c1',
        model_id: 'gpt-5.6-sol',
        cwd: wsA,
      });
      expect(got).toBe('gpt-5.6-sol');
      expect(readBinding(wsA).model_observed?.model).toBe('gpt-5.6-sol');
    });

    it('a new conversation_id replaces a leftover desktop capture (ADR 265)', async () => {
      await observeCursorSession({
        session_id: 'a3fb8a1c-desktop',
        model_id: 'grok-4.6',
        cwd: wsA,
      });
      const got = await observeCursorSession({
        session_id: '365e3420-cli',
        model_id: 'cursor-grok-4.6-high',
        cwd: wsA,
      });
      expect(got).toBe('cursor-grok-4.6-high');
      expect(readBinding(wsA).session).toMatchObject({
        harness: 'cursor',
        id: '365e3420-cli',
      });
      expect(readBinding(wsA).model_observed?.model).toBe('cursor-grok-4.6-high');
    });

    it('a new conversation_id with no model_id DROPS the leftover observation (ADR 268)', async () => {
      // cursor-agent's afterMCPExecution payload often carries conversation_id and omits model_id.
      // Keeping grok-4.6 from the desktop session is a stopped clock (miley's #826 residual).
      await observeCursorSession({
        session_id: 'a3fb8a1c-desktop',
        model_id: 'grok-4.6',
        cwd: wsA,
      });
      const got = await observeCursorSession({
        session_id: '365e3420-cli',
        cwd: wsA,
      });
      expect(got).toBeUndefined();
      expect(readBinding(wsA).session).toMatchObject({
        harness: 'cursor',
        id: '365e3420-cli',
      });
      expect(readBinding(wsA).model_observed).toBeUndefined();
    });

    it('the same conversation_id without a model KEEPS the observation (never-erase within a session)', async () => {
      await observeCursorSession({
        session_id: 'c1',
        model_id: 'gpt-5.6-sol',
        cwd: wsA,
      });
      await observeCursorSession({ session_id: 'c1', cwd: wsA });
      expect(readBinding(wsA).model_observed?.model).toBe('gpt-5.6-sol');
    });

    it('a hook payload with no conversation_id still reconciles from enumeration (ADR 268)', async () => {
      // cursor-agent's afterMCPExecution often omits conversation_id. Returning before any write
      // left observed_at unmoved (ADR 265 residual). Enumeration is how we learn the live id.
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'cursor',
            id: 'a3fb8a1c-desktop',
            transcript_path: join(wsA, 'desktop.jsonl'),
            started_at: startedAt,
          },
          model_observed: {
            model: 'grok-4.6',
            harness: 'cursor',
            observed_at: startedAt,
          },
        }),
      );
      const livePath = join(wsA, '365e3420.txt');
      writeFileSync(livePath, 'cursor-agent session\n');
      await observeCursorSession({ cwd: wsA }, () => [
        { id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 },
      ]);
      expect(readBinding(wsA).session?.id).toBe('365e3420-cli');
      expect(readBinding(wsA).model_observed).toBeUndefined();
    });
  });

  /**
   * The refresh (ADR 158 follow-up). The shipped defect: SessionStart observes a transcript that has
   * no assistant turn yet, so the observation never lands and the never-erase fallback pins a
   * carry-forward that cannot self-correct. These pin the moment the observation is actually made.
   */
  describe('model observation — refresh at the tool boundary', () => {
    const transcript = (ws: string, model: string, name = 't.jsonl'): string => {
      const p = join(ws, name);
      writeFileSync(p, JSON.stringify({ message: { role: 'assistant', model } }) + '\n', 'utf8');
      return p;
    };

    /**
     * The stale-slot corpse, measured live on 2026-07-29: 3 of 5 active seats carried a PREDECESSOR's
     * session block — one 16 days old — because `binding.session` is only ever replaced by a
     * SessionStart hook, and when that hook does not write for a new session the old block survives
     * with its `ended_at` intact.
     *
     * The cost is specific and silent: this refresh bailed on `ended_at`, so a live seat stopped
     * observing its model for the rest of its life and attestation fell back to the stale
     * declaration — ADR 163's named failure, "worse, because it looks trustworthy". ADR 166 already
     * settled who wins when the slot and the session files disagree; this reader had not been told.
     */
    const enumStub =
      (rows: { id: string; path: string; mtime: number; bytes: number }[] | undefined) => () =>
        rows;

    it('keeps observing when the ended slot is a corpse and a live session says otherwise', () => {
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          // A predecessor that genuinely ended an hour ago…
          session: {
            harness: 'claude-code',
            id: 'dead-sid',
            transcript_path: join(wsA, 'dead.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );
      // …while THIS session is live and running a different model.
      const livePath = transcript(wsA, 'claude-opus-5', 'live.jsonl');

      const observed = refreshModelObservation(
        wsA,
        enumStub([{ id: 'live-sid', path: livePath, mtime: Date.now(), bytes: 10 }]),
      );

      expect(observed).toBe('claude-opus-5');
      expect(readBinding(wsA).model_observed).toMatchObject({ model: 'claude-opus-5' });
    });

    it('heals the slot to the live session when a corpse contradicts it (the wake-blip clobber)', () => {
      // The measured 2026-07-29 shape, timestamps and all: the seat's real session began at 22:55;
      // a short wake wrote the slot at 23:49 and ended at 23:50. The writer never missed — it was
      // OUTVOTED, and nothing ever gives the slot back because a long-lived session fires
      // SessionStart exactly once. The tool boundary is the boundary that always happens.
      const liveBegan = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'blip-sid',
            transcript_path: join(wsA, 'blip.jsonl'),
            started_at: liveBegan + 3_240_000,
            ended_at: liveBegan + 3_300_000,
          },
        }),
      );
      const livePath = transcript(wsA, 'claude-opus-5', 'live.jsonl');

      refreshModelObservation(
        wsA,
        enumStub([{ id: 'live-sid', path: livePath, mtime: Date.now(), bytes: 10 }]),
      );

      const healed = readBinding(wsA).session!;
      expect(healed.id).toBe('live-sid');
      expect(healed.transcript_path).toBe(livePath);
      expect(healed.ended_at).toBeUndefined();
      expect(typeof healed.started_at).toBe('number');
    });

    it('writes a binding that can still be READ — the heal must not brick its own workspace', () => {
      // The regression that shipped with the heal: `started_at` came from `statSync().birthtimeMs`,
      // which is fractional, while SessionCaptureSchema declares `z.number().int()`. `readBinding`
      // parses inside a try/catch and returns null on a throw, so ONE heal made `findBinding` return
      // null for that workspace forever — and every CLI path that resolves identity through it
      // (including this very refresh, at its first guard) died silently for the rest of the seat's
      // life. Measured on izzo, 2026-07-29: started_at 1785352706039.4507, byte-identical to the
      // transcript's birthtimeMs.
      //
      // `typeof started_at === 'number'` is what the case above asserts, and a float passes it. Only
      // a round-trip through the real schema catches this, so that is what this pins.
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'blip-sid',
            transcript_path: join(wsA, 'blip.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );
      const livePath = transcript(wsA, 'claude-opus-5', 'live-int.jsonl');

      refreshModelObservation(
        wsA,
        enumStub([{ id: 'live-sid', path: livePath, mtime: Date.now(), bytes: 10 }]),
      );

      const raw = JSON.parse(readFileSync(join(wsA, '.musterd', 'binding.json'), 'utf8'));
      const parsed = BindingSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      expect(Number.isInteger(raw.session.started_at)).toBe(true);
    });

    it('heals the slot even when the live transcript is not yet readable for a model', () => {
      // The heal is about the slot, not the observation: an unreadable/turnless live transcript
      // must not leave the corpse in place — the next wake would resume the blip's transcript.
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'blip-sid',
            transcript_path: join(wsA, 'blip.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );
      const livePath = join(wsA, 'live-empty.jsonl');
      writeFileSync(livePath, '', 'utf8'); // exists, but carries no assistant turn yet

      expect(
        refreshModelObservation(
          wsA,
          enumStub([{ id: 'live-sid', path: livePath, mtime: Date.now(), bytes: 0 }]),
        ),
      ).toBeUndefined();

      const healed = readBinding(wsA).session!;
      expect(healed.id).toBe('live-sid');
      expect(healed.ended_at).toBeUndefined();
    });

    it('still stops when the slot ended and nothing contradicts it', () => {
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'dead-sid',
            transcript_path: transcript(wsA, 'claude-opus-5', 'dead.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );

      // No live session in this workspace — the seat really has ended.
      expect(refreshModelObservation(wsA, enumStub([]))).toBeUndefined();
      expect(readBinding(wsA).model_observed).toBeUndefined();
    });

    it('does not treat the captured session itself as a contradiction', () => {
      // The live session IS the captured one, and it ended. Same id ⇒ no corpse, no override.
      const startedAt = Date.now() - 3_600_000;
      const p = transcript(wsA, 'claude-opus-5', 'same.jsonl');
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'same-sid',
            transcript_path: p,
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );

      expect(
        refreshModelObservation(
          wsA,
          enumStub([{ id: 'same-sid', path: p, mtime: Date.now(), bytes: 10 }]),
        ),
      ).toBeUndefined();
    });

    it('reads the SLOT, not a live neighbour, when the slot has not ended', () => {
      // Measured live on izzo, 2026-07-29: `model_observed` said claude-sonnet-5 four seconds into a
      // session whose transcript is claude-opus-5 end to end. The heal is gated on
      // `ended_at !== undefined && live`, but the transcript the model is read FROM was not — so any
      // neighbour inside the 10-minute live window outranked a perfectly healthy slot. A seat closing
      // one session and opening another minutes later is the ordinary case, not an edge one, and the
      // predecessor it reads is exactly where a different model is most likely to be found.
      const startedAt = Date.now() - 60_000;
      const mine = transcript(wsA, 'claude-opus-5', 'mine.jsonl');
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'live-sid',
            transcript_path: mine,
            started_at: startedAt, // no ended_at — this slot is healthy
          },
        }),
      );
      // The predecessor, closed minutes ago and still inside LOCAL_SESSION_LIVE_MS.
      const neighbour = transcript(wsA, 'claude-sonnet-5', 'neighbour.jsonl');

      expect(
        refreshModelObservation(
          wsA,
          enumStub([{ id: 'other-sid', path: neighbour, mtime: Date.now(), bytes: 10 }]),
        ),
      ).toBe('claude-opus-5');
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-5');
      // …and a healthy slot is never rewritten by a neighbour.
      expect(readBinding(wsA).session?.id).toBe('live-sid');
    });

    it('falls back to the slot when the harness cannot enumerate at all', () => {
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'dead-sid',
            transcript_path: transcript(wsA, 'claude-opus-5', 'dead2.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );

      // undefined ⇒ no enumeration available; the slot stays the only witness (ADR 166 §weaker).
      expect(refreshModelObservation(wsA, enumStub(undefined))).toBeUndefined();
    });

    it('lands the observation SessionStart could not make (the shipped defect)', async () => {
      // Exactly the live shape: capture names a transcript that does not exist yet…
      const t = join(wsA, 't.jsonl');
      await captureSession('start', { session_id: 'sid-1', transcript_path: t, cwd: wsA });
      expect(readBinding(wsA).model_observed).toBeUndefined();

      // …then the harness writes its first assistant turn, and the next tool boundary sees it.
      transcript(wsA, 'claude-opus-5');
      expect(refreshModelObservation(wsA)).toBe('claude-opus-5');
      const a = readBinding(wsA);
      expect(a.model_observed).toMatchObject({ model: 'claude-opus-5', harness: 'claude-code' });
      expect(a.model_observed!.observed_at).toBeGreaterThanOrEqual(a.session!.started_at);
      expect(a.model).toBe('claude-test-1'); // the declaration is still untouched
    });

    it('replaces a carry-forward observed BEFORE this session began (the live incident)', () => {
      // Seat ryder, verbatim: attesting claude-opus-4-8 from an hour-old observation while the
      // transcript of the running session is 100% claude-opus-5.
      const startedAt = Date.now() - 60_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: join(wsA, 't.jsonl'),
            started_at: startedAt,
          },
          model_observed: {
            model: 'claude-opus-4-8',
            harness: 'claude-code',
            observed_at: startedAt - 3_600_000,
          },
        }),
      );
      transcript(wsA, 'claude-opus-5');
      expect(refreshModelObservation(wsA)).toBe('claude-opus-5');
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-5');
    });

    it('is a no-op while the observation is current — no re-read, no rewrite', () => {
      const observedAt = Date.now() - 1_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: join(wsA, 't.jsonl'),
            started_at: observedAt - 1,
          },
          model_observed: {
            model: 'claude-opus-5',
            harness: 'claude-code',
            observed_at: observedAt,
          },
        }),
      );
      transcript(wsA, 'a-model-it-must-not-read');
      expect(refreshModelObservation(wsA)).toBeUndefined();
      expect(readBinding(wsA).model_observed?.observed_at).toBe(observedAt); // untouched
    });

    it('catches a mid-session model switch once the observation ages out', () => {
      const startedAt = Date.now() - OBSERVATION_REFRESH_MS - 60_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: join(wsA, 't.jsonl'),
            started_at: startedAt,
          },
          model_observed: {
            model: 'claude-opus-5',
            harness: 'claude-code',
            // observed within this session, but longer ago than the refresh interval
            observed_at: Date.now() - OBSERVATION_REFRESH_MS - 1,
          },
        }),
      );
      transcript(wsA, 'claude-sonnet-5'); // the human ran /model mid-run
      expect(refreshModelObservation(wsA)).toBe('claude-sonnet-5');
      expect(readBinding(wsA).model_observed?.model).toBe('claude-sonnet-5');
    });

    it('KEEPS a prior observation when the transcript yields nothing', () => {
      const startedAt = Date.now() - 60_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: join(wsA, 'gone.jsonl'),
            started_at: startedAt,
          },
          model_observed: {
            model: 'claude-opus-5',
            harness: 'claude-code',
            observed_at: startedAt - 1_000,
          },
        }),
      );
      expect(refreshModelObservation(wsA)).toBeUndefined();
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-5'); // never erased
    });

    it('leaves an ENDED session alone — what it last attested is the truth about it', () => {
      const startedAt = Date.now() - 60_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: join(wsA, 't.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 1_000,
          },
          model_observed: {
            model: 'claude-opus-5',
            harness: 'claude-code',
            observed_at: startedAt - 1_000,
          },
        }),
      );
      transcript(wsA, 'claude-sonnet-5');
      expect(refreshModelObservation(wsA)).toBeUndefined();
      expect(readBinding(wsA).model_observed?.model).toBe('claude-opus-5');
    });

    it('never touches a sibling worktree, and never throws on a bare/unbound folder', () => {
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'sid-1',
            transcript_path: transcript(wsA, 'claude-opus-5'),
            started_at: Date.now() - 60_000,
          },
        }),
      );
      expect(refreshModelObservation(wsA)).toBe('claude-opus-5');
      expect(readBinding(wsB).model_observed).toBeUndefined(); // the ADR 018 clobber, again

      const bare = mkdtempSync(join(tmpdir(), 'musterd-session-bare-'));
      expect(() => refreshModelObservation(bare)).not.toThrow();
      expect(refreshModelObservation(bare)).toBeUndefined();
      rmSync(bare, { recursive: true, force: true });
    });

    it('does not observe a session with no captured transcript path', () => {
      writeBinding(
        wsA,
        bindingOf({
          session: { harness: 'claude-code', id: 'sid-1', started_at: Date.now() - 60_000 },
        }),
      );
      expect(refreshModelObservation(wsA)).toBeUndefined();
      expect(readBinding(wsA).model_observed).toBeUndefined();
    });

    it('heals an unended Cursor slot to a live CLI transcript and DROPS the leftover model (ADR 268)', () => {
      // Measured specimen: slot still names the morning desktop session (no ended_at), roster
      // attests grok-4.6, while cursor-agent is writing a sibling .txt. Enumeration already
      // outranks the slot for liveness (ADR 265); the observation must not ride along.
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'cursor',
            id: 'a3fb8a1c-desktop',
            transcript_path: join(wsA, 'desktop.jsonl'),
            started_at: startedAt,
          },
          model_observed: {
            model: 'grok-4.6',
            harness: 'cursor',
            observed_at: startedAt,
          },
        }),
      );
      const livePath = join(wsA, '365e3420.txt');
      writeFileSync(livePath, 'cursor-agent session\n');

      expect(
        refreshModelObservation(
          wsA,
          enumStub([{ id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 }]),
        ),
      ).toBeUndefined();

      const a = readBinding(wsA);
      expect(a.session).toMatchObject({
        harness: 'cursor',
        id: '365e3420-cli',
        transcript_path: livePath,
      });
      expect(a.model_observed).toBeUndefined();
    });
  });

  /**
   * Attestation belongs to HOLDING the slot, not to SessionStart (lane 01M159BHJK).
   *
   * Measured on seat ryder 2026-08-28. A wake-spawned session held the slot; an interactive session
   * started beside it, was turned away by the interloper gate — which is documented to mean "no slot
   * write AND no daemon attestation" — and then took the slot back legitimately at its first tool
   * boundary, via the heal. The heal writes the slot and nothing else, and `captureSession` is the
   * only caller of `attestSession`, so nothing ever told the daemon. That session then ran for two
   * hours, claimed a lane and closed one, and never existed on the ledger: its correlation digest
   * `982f768adf12` returned zero audit rows for its whole life, while the last session the daemon
   * knew about was the wake child that had ended 90 minutes earlier.
   *
   * The gate's own note says "the slot self-corrects at the next SessionStart". Locally, yes. The
   * LEDGER never self-corrects, because the only moment that attests has already passed.
   *
   * So the boundary that always happens is the one that reconciles: an un-ended slot the daemon has
   * not been told about gets attested there, exactly once.
   */
  describe('the tool boundary attests a slot SessionStart never did', () => {
    const transcript = (ws: string, name: string): string => {
      const p = join(ws, name);
      writeFileSync(p, JSON.stringify({ message: { role: 'assistant', model: 'm' } }) + '\n');
      return p;
    };
    const enumStub =
      (rows: { id: string; path: string; mtime: number; bytes: number }[]) => () => rows;

    it('attests the healed slot, and stamps it so the boundary is idempotent', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'wake-child',
            transcript_path: join(wsA, 'wake.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );
      const livePath = transcript(wsA, 'live.jsonl');
      refreshModelObservation(
        wsA,
        enumStub([{ id: 'gated-live', path: livePath, mtime: Date.now(), bytes: 10 }]),
      );
      expect(readBinding(wsA).session!.id).toBe('gated-live'); // the heal took the slot
      expect(attest).not.toHaveBeenCalled(); // …and told nobody, which is the defect

      await attestSlotIfUnattested(wsA);
      expect(attest).toHaveBeenCalledTimes(1);
      expect(attest.mock.calls[0]![1]).toMatchObject({ seat: 'scout', event: 'start' });
      const stamped = readBinding(wsA).session!;
      expect(stamped.attested_at).toBeGreaterThan(0);

      // The boundary runs on every tool call — a second pass must not re-announce the session.
      await attestSlotIfUnattested(wsA);
      expect(attest).toHaveBeenCalledTimes(1);
    });

    it('does not stamp when the daemon could not be told — the retry must survive', async () => {
      // A hook may never fail, so the push is swallowed; stamping regardless would convert one
      // unreachable daemon into a permanently unattested session, which is the bug this closes.
      vi.spyOn(HttpClient.prototype, 'attestSession').mockRejectedValue(new Error('unreachable'));
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'live-1',
            transcript_path: transcript(wsA, 'live1.jsonl'),
            started_at: Date.now() - 60_000,
          },
        }),
      );
      await expect(attestSlotIfUnattested(wsA)).resolves.toBeUndefined();
      expect(readBinding(wsA).session!.attested_at).toBeUndefined();
    });

    it('leaves an ended slot alone — a corpse is not a session to announce', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      const startedAt = Date.now() - 3_600_000;
      writeBinding(
        wsA,
        bindingOf({
          session: {
            harness: 'claude-code',
            id: 'dead-1',
            transcript_path: transcript(wsA, 'dead1.jsonl'),
            started_at: startedAt,
            ended_at: startedAt + 15_000,
          },
        }),
      );
      await attestSlotIfUnattested(wsA);
      expect(attest).not.toHaveBeenCalled();
    });

    it('captureSession stamps its own attestation, so the boundary stays quiet', async () => {
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      await captureSession('start', { session_id: 'sid-1', cwd: wsA });
      expect(attest).toHaveBeenCalledTimes(1);
      expect(readBinding(wsA).session!.attested_at).toBeGreaterThan(0);

      await attestSlotIfUnattested(wsA);
      expect(attest).toHaveBeenCalledTimes(1); // the ordinary path is unchanged
    });

    it('says nothing when the gate turned the newcomer away and the slot is still the occupant', async () => {
      // The gated newcomer wrote no slot, so there is nothing of ITS to announce — the live
      // occupant's slot is already attested and stays that way. Pins that this fix does not hand
      // the interloper the announcement the gate exists to deny it.
      const attest = vi
        .spyOn(HttpClient.prototype, 'attestSession')
        .mockResolvedValue(undefined as never);
      const t = transcript(wsA, 'occupant.jsonl');
      await captureSession('start', { session_id: 'occupant', cwd: wsA, transcript_path: t });
      attest.mockClear();
      await captureSession('start', {
        session_id: 'ghost',
        cwd: wsA,
        transcript_path: join(wsA, 'ghost.jsonl'),
      });
      expect(readBinding(wsA).session!.id).toBe('occupant');
      await attestSlotIfUnattested(wsA);
      expect(attest).not.toHaveBeenCalled();
    });
  });
});

/**
 * The sidebar-sweep decision engine (ADR 160 surface 2). Hermetic: seat workspaces and the desktop
 * app's session-record dir are both temp fixtures (MUSTERD_CCD_SESSIONS_DIR); nothing touches the
 * real ~/Library path. The caller applies renames — resolveLabels itself must never write.
 */
describe('musterd session resolve-labels (ADR 160)', () => {
  const CHIP = '\u{1F536}';
  const NOW = Date.UTC(2026, 6, 25, 19, 0);
  let seatWs: string; // a seat worktree (workspace.json claim seat:miley)
  let plainWs: string; // a non-seat repo
  let ccdDir: string; // fixture stand-in for the app's session-record dir
  const dirs: string[] = [];

  const spec = (name: string) => ({
    version: 2,
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    claim: { mode: 'seat', name },
  });

  /** Write the app-side record the enrichment path reads: <dir>/<org>/<proj>/<id>.json. */
  const writeCcdRecord = (id: string, rec: object): void => {
    const proj = join(ccdDir, 'org', 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${id}.json`), JSON.stringify(rec));
  };

  const makeDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    seatWs = makeDir('musterd-labels-seat-');
    mkdirSync(join(seatWs, '.musterd'), { recursive: true });
    writeFileSync(join(seatWs, '.musterd', 'workspace.json'), JSON.stringify(spec('miley')));
    plainWs = makeDir('musterd-labels-plain-');
    ccdDir = makeDir('musterd-labels-ccd-');
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const run = (rows: object[]) =>
    resolveLabels(rows as never, { now: NOW, env: { MUSTERD_CCD_SESSIONS_DIR: ccdDir } });

  it('labels an untouched seat session from the app record createdAt', () => {
    writeCcdRecord('s1', { createdAt: NOW - 3_600_000, titleSource: 'auto' });
    const res = run([{ sessionId: 's1', title: 'Daemon refresh', cwd: seatWs }]);
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0]!.title.startsWith(`${CHIP} Miley (`)).toBe(true);
    expect(res.apply[0]!.title.endsWith(') - Daemon refresh')).toBe(true);
    expect(res.skipped).toEqual({});
  });

  it('covers every skip reason', () => {
    writeCcdRecord('hand', { createdAt: NOW - 3_600_000, titleSource: 'user' });
    writeCcdRecord('done', { createdAt: NOW - 3_600_000, titleSource: 'auto' });
    writeCcdRecord('fresh', { createdAt: NOW - 30_000, titleSource: 'auto' });
    const res = run([
      { sessionId: 'a', title: 'x', cwd: seatWs, isArchived: true },
      { sessionId: 'b', title: '   ', cwd: seatWs },
      { sessionId: 'c', title: 'x', cwd: plainWs },
      { sessionId: 'hand', title: 'My own words', cwd: seatWs },
      { sessionId: 'done', title: `${CHIP} Miley (Fri 3p) - x`, cwd: seatWs },
      { sessionId: 'fresh', title: 'First guess', cwd: seatWs },
      { sessionId: 'nometa', title: 'No timestamps anywhere', cwd: seatWs },
    ]);
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({
      archived: 1,
      'no-title-yet': 1,
      'not-a-seat': 1,
      'hand-named': 1,
      'already-labeled': 1,
      'too-fresh': 1,
      'no-timestamp': 1,
    });
  });

  it('skips hand-named rows when list_sessions hands the cliSessionId (≠ file stem)', () => {
    // Desktop files are named local_<uuid>; list_sessions often returns cliSessionId, a *different*
    // uuid. A miss left titleSource unset and the forever-loop proposed user titles (ADR 186).
    const proj = join(ccdDir, 'org', 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'local_file-stem.json'),
      JSON.stringify({
        sessionId: 'local_file-stem',
        cliSessionId: 'cli-uuid-other',
        createdAt: NOW - 3_600_000,
        titleSource: 'user',
      }),
    );
    const res = run([{ sessionId: 'cli-uuid-other', title: 'Miley - hand typed', cwd: seatWs }]);
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({ 'hand-named': 1 });
  });

  // Measured 2026-07-30 (lane 01KYSY7JNB): proposing seat-form user titles forever-looped the
  // nudge — Desktop soft-refuses them with a success reply. Skip ALL titleSource:user.
  it('skips a hand-named title even when it is already in seat form (Desktop soft-refuses)', () => {
    writeCcdRecord('s', { createdAt: NOW - 3_600_000, titleSource: 'user' });
    const res = run([
      { sessionId: 's', title: 'Miley - fix(broadcast): three things', cwd: seatWs },
    ]);
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({ 'hand-named': 1 });
  });

  it('skips a hand-named seat title that already carries a stamp (same soft-refuse)', () => {
    writeCcdRecord('s', { createdAt: NOW - 3_600_000, titleSource: 'user' });
    const res = run([{ sessionId: 's', title: 'Miley (Mon 2p) - MCP list', cwd: seatWs }]);
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({ 'hand-named': 1 });
  });

  // The other half: everything NOT in seat form stays inviolable (unchanged).
  it('still never touches a hand-named title written in the human OWN terms', () => {
    writeCcdRecord('a', { createdAt: NOW - 3_600_000, titleSource: 'user' });
    writeCcdRecord('b', { createdAt: NOW - 3_600_000, titleSource: 'user' });
    const res = run([
      { sessionId: 'a', title: 'Do not rename this', cwd: seatWs },
      // mentions the seat, but not as a prefix — not the sweep's sentence to finish
      { sessionId: 'b', title: "Reviewing Miley's PR", cwd: seatWs },
    ]);
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({ 'hand-named': 2 });
  });

  it('upgrades a pre-chip AUTO label by prepending the chip, KEEPING the original timestamp text', () => {
    writeCcdRecord('s', { createdAt: NOW - 3_600_000, titleSource: 'auto' });
    const res = run([{ sessionId: 's', title: 'Miley (Mon 2p) - MCP list', cwd: seatWs }]);
    expect(res.apply).toEqual([
      { session_id: 's', seat: 'Miley', title: `${CHIP} Miley (Mon 2p) - MCP list` },
    ]);
  });

  it('degrades to lastActivityAt when the app record is unreadable — and STILL freshness-gates it (the python original skipped the gate here)', () => {
    const res = run([
      {
        sessionId: 'old',
        title: 'Old enough',
        cwd: seatWs,
        lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
      },
      {
        sessionId: 'young',
        title: 'Too new',
        cwd: seatWs,
        lastActivityAt: new Date(NOW - 30_000).toISOString(),
      },
    ]);
    expect(res.apply.map((a) => a.session_id)).toEqual(['old']);
    expect(res.skipped).toEqual({ 'too-fresh': 1 });
  });

  it('falls back to the agents-<name> folder suffix when the workspace has no seat claim', () => {
    const parent = makeDir('musterd-labels-parent-');
    const suffixWs = join(parent, 'agents-izzo');
    mkdirSync(suffixWs, { recursive: true });
    writeCcdRecord('s', { createdAt: NOW - 3_600_000, titleSource: 'auto' });
    const res = run([{ sessionId: 's', title: 'Check messages', cwd: suffixWs }]);
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0]!.title).toContain('Izzo (');
  });

  it('a chip for a DIFFERENT seat is relabeled for the owning seat, not skipped', () => {
    writeCcdRecord('s', { createdAt: NOW - 3_600_000, titleSource: 'auto' });
    const res = run([{ sessionId: 's', title: `${CHIP} Ryder (Thu 9a) - x`, cwd: seatWs }]);
    // chipped-but-not-seated: falls through to a full relabel under the cwd's real seat.
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0]!.title).toContain('Miley (');
  });
});

/**
 * The label-sweep nudge rail. Due keys off evidence (CCD + resolveLabels.apply) when the desktop
 * session records are readable; stamp age is only the fallback when they are not (ADR 173).
 */
describe('musterd session label-nudge (evidence-based due)', () => {
  const NOW = Date.UTC(2026, 6, 29, 22, 0);
  let stampPath: string;
  let ccdDir: string;
  let seatWs: string;
  const dirs: string[] = [];

  beforeEach(() => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-label-stamp-'));
    dirs.push(d);
    stampPath = join(d, 'nested', 'label-sweep.json'); // nested: the stamp write must mkdir -p
    ccdDir = mkdtempSync(join(tmpdir(), 'musterd-label-ccd-'));
    dirs.push(ccdDir);
    seatWs = mkdtempSync(join(tmpdir(), 'musterd-label-seat-'));
    dirs.push(seatWs);
    mkdirSync(join(seatWs, '.musterd'), { recursive: true });
    writeFileSync(
      join(seatWs, '.musterd', 'workspace.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'dawn',
        claim: { mode: 'seat', name: 'miley' },
      }),
    );
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const env = (over: Record<string, string> = {}) => ({
    MUSTERD_LABEL_STAMP: stampPath,
    MUSTERD_CCD_SESSIONS_DIR: ccdDir,
    ...over,
  });

  const writeCcd = (id: string, rec: object): void => {
    const proj = join(ccdDir, 'org', 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${id}.json`), JSON.stringify(rec));
  };

  it('is due when CCD shows an unlabeled auto seat session — even with a fresh stamp', () => {
    stampLabelSweep(NOW, env());
    writeCcd('s1', {
      sessionId: 's1',
      cliSessionId: 's1',
      title: 'Daemon refresh',
      cwd: seatWs,
      createdAt: NOW - 3_600_000,
      titleSource: 'auto',
      isArchived: false,
    });
    expect(labelSweepDue(NOW + 60_000, env())).toBe(true);
  });

  it('is quiet when CCD shows only hand-named / already-labeled rows — even with a stale stamp', () => {
    writeCcd('hand', {
      sessionId: 'hand',
      cliSessionId: 'hand',
      title: 'Miley - my words',
      cwd: seatWs,
      createdAt: NOW - 3_600_000,
      titleSource: 'user',
      isArchived: false,
    });
    writeCcd('done', {
      sessionId: 'done',
      cliSessionId: 'done',
      title: '\u{1F536} Miley (Fri 3p) - x',
      cwd: seatWs,
      createdAt: NOW - 3_600_000,
      titleSource: 'auto',
      isArchived: false,
    });
    // no stamp at all — still quiet, because apply would be empty
    expect(labelSweepDue(NOW, env())).toBe(false);
  });

  it('falls back to stamp age when CCD dir is missing (ADR 173: absent ≠ nothing-to-do)', () => {
    const missing = join(ccdDir, 'does-not-exist');
    expect(labelSweepDue(NOW, env({ MUSTERD_CCD_SESSIONS_DIR: missing }))).toBe(true);
    stampLabelSweep(NOW, env({ MUSTERD_CCD_SESSIONS_DIR: missing }));
    expect(labelSweepDue(NOW + 60_000, env({ MUSTERD_CCD_SESSIONS_DIR: missing }))).toBe(false);
    expect(
      labelSweepDue(NOW + LABEL_SWEEP_STALE_MS + 1, env({ MUSTERD_CCD_SESSIONS_DIR: missing })),
    ).toBe(true);
  });

  it('an unreadable stamp file means due on the fallback path — never a crash', () => {
    const missing = join(ccdDir, 'gone');
    mkdirSync(join(stampPath, '..'), { recursive: true });
    writeFileSync(stampPath, 'not json');
    expect(labelSweepDue(NOW, env({ MUSTERD_CCD_SESSIONS_DIR: missing }))).toBe(true);
  });

  it('the command prints the nudge when due and NOTHING when quiet, exiting 0 both times', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = () => sessionCommand(parseArgs(['label-nudge']));
    const withEnv = async (e: Record<string, string>): Promise<number> => {
      const prev: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(e)) {
        prev[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        return await run();
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };
    writeCcd('s1', {
      sessionId: 's1',
      cliSessionId: 's1',
      title: 'Needs chip',
      cwd: seatWs,
      createdAt: NOW - 3_600_000,
      titleSource: 'auto',
      isArchived: false,
    });
    expect(await withEnv(env())).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain('musterd-label-sessions');
    out.mockClear();
    // clear the unlabeled row → quiet
    writeFileSync(
      join(ccdDir, 'org', 'proj', 's1.json'),
      JSON.stringify({
        sessionId: 's1',
        cliSessionId: 's1',
        title: '\u{1F536} Miley (Fri 3p) - Needs chip',
        cwd: seatWs,
        createdAt: NOW - 3_600_000,
        titleSource: 'auto',
        isArchived: false,
      }),
    );
    expect(await withEnv(env())).toBe(0);
    expect(out.mock.calls.join('')).toBe('');
    out.mockRestore();
  });

  it('resolve-labels stamps the sweep even when nothing needed labeling', () => {
    stampLabelSweep(NOW, env());
    const rec = JSON.parse(readFileSync(stampPath, 'utf8')) as { swept_at: number };
    expect(rec.swept_at).toBe(NOW);
  });

  // #538 review / lane 01KYWGMXYY: labelSweepDue walked+parsed the CCD tree twice.
  it('resolveLabels reuses a handed ccdIndex (does not re-read the CCD dir)', () => {
    const index = new Map([['s1', { titleSource: 'user' as const, createdAt: NOW - 3_600_000 }]]);
    const res = resolveLabels([{ sessionId: 's1', title: 'hand words', cwd: seatWs }], {
      now: NOW,
      env: { MUSTERD_CCD_SESSIONS_DIR: join(ccdDir, 'absent') },
      ccdIndex: index,
    });
    expect(res.apply).toEqual([]);
    expect(res.skipped).toEqual({ 'hand-named': 1 });
  });

  it('scanCcd returns rows and index from one walk', () => {
    writeCcd('s1', {
      sessionId: 'local_s1',
      cliSessionId: 'cli-s1',
      title: 'Needs chip',
      cwd: seatWs,
      createdAt: NOW - 3_600_000,
      titleSource: 'auto',
      isArchived: false,
    });
    const scan = scanCcd(ccdDir);
    expect(scan).not.toBeNull();
    expect(scan!.rows).toHaveLength(1);
    expect(scan!.rows[0]!.sessionId).toBe('cli-s1');
    expect(scan!.index.get('cli-s1')?.titleSource).toBe('auto');
    expect(scan!.index.get('local_s1')?.titleSource).toBe('auto');
    expect(labelSweepDue(NOW, env())).toBe(true);
  });

  // Latent forever-loop: no-index lookup used to skip the local_ fallback.
  it('lookupCcdMeta without an index still finds via local_ prefix fallback', () => {
    const proj = join(ccdDir, 'org', 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'local_file-stem.json'),
      JSON.stringify({
        sessionId: 'local_file-stem',
        cliSessionId: 'cli-other',
        createdAt: NOW - 3_600_000,
        titleSource: 'user',
      }),
    );
    // Look up by stem without the local_ prefix — index branch and no-index branch must agree.
    expect(lookupCcdMeta(ccdDir, 'file-stem').titleSource).toBe('user');
    expect(lookupCcdMeta(ccdDir, 'cli-other').titleSource).toBe('user');
  });
});
