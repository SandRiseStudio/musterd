import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { captureSession, sessionCommand } from './session.js';

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
});
