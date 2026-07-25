import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import {
  captureSession,
  OBSERVATION_REFRESH_MS,
  refreshModelObservation,
  resolveLabels,
  sessionCommand,
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
    server: 'http://127.0.0.1:1', // nothing listens — the attestation push must fail silently
    team: 'dawn',
    surface: 'claude-code',
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
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    surface: 'claude-code',
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

  it('upgrades a pre-chip label by prepending the chip, KEEPING the original timestamp text', () => {
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
