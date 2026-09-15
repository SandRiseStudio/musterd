import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    await expect(
      handleCodexHook(parseArgs(['start', '--stdin']), event(), { start }),
    ).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledWith({
      event: 'start',
      session_id: 'codex-session',
      cwd: '/workspace',
      transcript_path: '/workspace/rollout.jsonl',
    });
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
    ).resolves.toBeUndefined();

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

  it('captures and closes only the matching Codex session, then stores direct model evidence', async () => {
    await handleCodexHook(
      parseArgs(['start', '--stdin']),
      event({ cwd: workspace, session_id: 'first' }),
    );
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
});
