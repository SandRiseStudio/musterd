import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { handleCodexHook } from './codexHook.js';

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'codex-session',
    cwd: '/workspace',
    transcript_path: '/workspace/rollout.jsonl',
    ...overrides,
  });

describe('musterd codex-hook', () => {
  it('records only the SessionStart capture selected by its command', async () => {
    const start = vi.fn();
    const probe = vi.fn();

    await expect(
      handleCodexHook(parseArgs(['start', '--stdin']), event(), { start, probe }),
    ).resolves.toBeNull();

    expect(start).toHaveBeenCalledWith({
      event: 'start',
      session_id: 'codex-session',
      cwd: '/workspace',
      transcript_path: '/workspace/rollout.jsonl',
    });
    expect(probe).toHaveBeenCalledWith('/workspace');
  });

  it('records direct PostToolUse model evidence without using a transcript', async () => {
    const observe = vi.fn();

    await handleCodexHook(
      parseArgs(['post-tool-use', '--stdin']),
      event({ hook_event_name: 'PostToolUse', model: 'gpt-5.6' }),
      { observe },
    );

    expect(observe).toHaveBeenCalledWith({
      event: 'post-tool-use',
      session_id: 'codex-session',
      cwd: '/workspace',
      model: 'gpt-5.6',
    });
  });

  it('does not write when the command and causal event disagree', async () => {
    const start = vi.fn();

    await expect(
      handleCodexHook(parseArgs(['start', '--stdin']), event({ hook_event_name: 'SessionEnd' }), {
        start,
      }),
    ).resolves.toBeNull();

    expect(start).not.toHaveBeenCalled();
  });
});

describe('Codex hook local evidence', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'musterd-codex-hook-'));
    mkdirSync(join(workspace, '.musterd'), { recursive: true });
    const binding: Binding = {
      version: 2,
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      claim: { mode: 'seat', name: 'Ada' },
      agent_key: 'mskey_test',
      model: 'declared-model',
    };
    writeFileSync(join(workspace, '.musterd', 'binding.json'), JSON.stringify(binding));
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('taps each Codex event as codex — named by the caller, never inferred (ADR 445 1a tail)', async () => {
    const tap = vi.fn().mockResolvedValue(true);
    await handleCodexHook(
      parseArgs(['start', '--stdin']),
      event({ cwd: workspace, session_id: 'first' }),
      { start: () => undefined, tap },
    );
    await handleCodexHook(
      parseArgs(['post-tool-use', '--stdin']),
      event({ cwd: workspace, session_id: 'first', hook_event_name: 'PostToolUse', model: 'm' }),
      { interrupt: () => 'Ada: stop', tap },
    );
    await handleCodexHook(
      parseArgs(['end', '--stdin']),
      event({ cwd: workspace, session_id: 'first', hook_event_name: 'SessionEnd' }),
      { end: () => undefined, tap },
    );
    const calls = tap.mock.calls.map(
      (c) => c[1] as { harness: string; kind: string; dir: string; outcome?: unknown },
    );
    expect(calls.map((c) => [c.kind, c.harness])).toEqual([
      ['SessionStart', 'codex'],
      ['PostToolUse', 'codex'],
      ['SessionEnd', 'codex'],
    ]);
    expect(calls.every((c) => c.dir === workspace)).toBe(true);
    expect(calls[1]!.outcome).toEqual({ hook: 'interrupt', detail: { raised: true } });
  });

  it('an unbound folder taps nothing', async () => {
    const tap = vi.fn();
    const bare = mkdtempSync(join(tmpdir(), 'musterd-codex-bare-'));
    try {
      await handleCodexHook(
        parseArgs(['end', '--stdin']),
        event({ cwd: bare, hook_event_name: 'SessionEnd' }),
        { end: () => undefined, tap },
      );
      expect(tap).not.toHaveBeenCalled();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('captures and closes only the matching Codex session, then stores direct model evidence', async () => {
    await handleCodexHook(
      parseArgs(['start', '--stdin']),
      event({ cwd: workspace, session_id: 'first' }),
    );
    expect(existsSync(join(workspace, '.musterd', 'drift.json'))).toBe(true);
    await handleCodexHook(
      parseArgs(['end', '--stdin']),
      event({ cwd: workspace, session_id: 'other', hook_event_name: 'SessionEnd' }),
    );
    await handleCodexHook(
      parseArgs(['post-tool-use', '--stdin']),
      event({
        cwd: workspace,
        session_id: 'first',
        hook_event_name: 'PostToolUse',
        model: 'gpt-5.6',
      }),
    );

    const binding = JSON.parse(
      readFileSync(join(workspace, '.musterd', 'binding.json'), 'utf8'),
    ) as Binding;
    expect(binding.session).toMatchObject({ harness: 'codex', id: 'first' });
    expect(binding.session).not.toHaveProperty('ended_at');
    expect(binding.model_observed).toMatchObject({ harness: 'codex', model: 'gpt-5.6' });
  });

  it('observes the model before returning a raised PostToolUse context response', async () => {
    const interrupt = vi.fn().mockResolvedValue('Ada: please review');

    await expect(
      handleCodexHook(
        parseArgs(['post-tool-use', '--stdin']),
        event({
          cwd: workspace,
          session_id: 'first',
          hook_event_name: 'PostToolUse',
          model: 'gpt-5.6',
        }),
        { interrupt },
      ),
    ).resolves.toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Ada: please review',
        },
      }),
    );

    expect(interrupt).toHaveBeenCalledWith(workspace);
    const binding = JSON.parse(
      readFileSync(join(workspace, '.musterd', 'binding.json'), 'utf8'),
    ) as Binding;
    expect(binding.model_observed).toMatchObject({ harness: 'codex', model: 'gpt-5.6' });
  });

  it('keeps PostToolUse quiet when the interrupt reader is quiet or fails', async () => {
    const payload = event({
      cwd: workspace,
      session_id: 'first',
      hook_event_name: 'PostToolUse',
      model: 'gpt-5.6',
    });

    await expect(
      handleCodexHook(parseArgs(['post-tool-use', '--stdin']), payload, {
        interrupt: () => null,
      }),
    ).resolves.toBeNull();
    await expect(
      handleCodexHook(parseArgs(['post-tool-use', '--stdin']), payload, {
        interrupt: () => Promise.reject(new Error('offline')),
      }),
    ).resolves.toBeNull();
  });
});
