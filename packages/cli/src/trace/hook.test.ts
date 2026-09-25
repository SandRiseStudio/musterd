import type { Binding } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../client.js';
import { sessionDigest } from '../session/digest.js';
import {
  buildHookOutcomeEvent,
  buildTraceEvent,
  emitTraceEvents,
  inferTraceHarness,
  parseTraceHook,
  tapHook,
  traceDepth,
  traceTapEnabled,
} from './hook.js';

const binding = {
  server: 'http://127.0.0.1:1',
  team: 'revive',
  claim: { mode: 'seat', name: 'ryder' },
  agent_key: 'mskey_test_key',
  seat_credential: 'msac_test',
} as unknown as Binding;

const post = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'sess-1234',
    transcript_path: '/Users/x/.claude/projects/p/sess-1234.jsonl',
    cwd: '/Users/x/p',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    tool_input: { command: 'cat .musterd/binding.json' },
    tool_response: { stdout: 'mskey_SECRET' },
    ...over,
  });

describe('parseTraceHook (ADR 445 R1 — structural only)', () => {
  it('reads names, ids and sizes; never the content, the transcript path, or the cwd', () => {
    const p = parseTraceHook(post())!;
    expect(p).toEqual({
      kind: 'PostToolUse',
      session_id: 'sess-1234',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      outcome: 'ok',
      detail: { tool_input_bytes: 39, tool_response_bytes: 25 },
    });
    const s = JSON.stringify(p);
    expect(s).not.toContain('binding.json');
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('transcript');
    expect(s).not.toContain('/Users/x');
  });

  it('maps each hook kind and its bounded enum facts', () => {
    expect(parseTraceHook(post({ hook_event_name: 'PostToolUseFailure', error: 'boom' }))).toEqual(
      expect.objectContaining({ kind: 'PostToolUseFailure', outcome: 'error' }),
    );
    expect(
      parseTraceHook(post({ hook_event_name: 'PostToolUseFailure', error: 'boom' }))!.detail,
    ).toMatchObject({ error_bytes: 4 });
    expect(
      parseTraceHook(
        JSON.stringify({
          session_id: 's',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'hi there',
        }),
      ),
    ).toEqual({ kind: 'UserPromptSubmit', session_id: 's', detail: { prompt_bytes: 8 } });
    expect(
      parseTraceHook(
        JSON.stringify({ session_id: 's', hook_event_name: 'PreCompact', trigger: 'auto' }),
      ),
    ).toEqual({ kind: 'PreCompact', session_id: 's', detail: { trigger: 'auto' } });
    expect(
      parseTraceHook(
        JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'resume' }),
      ),
    ).toEqual({ kind: 'SessionStart', session_id: 's', detail: { source: 'resume' } });
    expect(
      parseTraceHook(
        JSON.stringify({
          session_id: 's',
          hook_event_name: 'SubagentStart',
          agent_id: 'a1',
          agent_type: 'Explore',
        }),
      ),
    ).toEqual({
      kind: 'SubagentStart',
      session_id: 's',
      agent_id: 'a1',
      detail: { agent_type: 'Explore' },
    });
    expect(
      parseTraceHook(
        JSON.stringify({ session_id: 's', hook_event_name: 'Stop', stop_hook_active: false }),
      ),
    ).toEqual({ kind: 'Stop', session_id: 's', detail: { stop_hook_active: false } });
  });

  it('an explicit kind wins over the payload; unknown kinds and missing ids are nothing to record', () => {
    expect(parseTraceHook(post(), 'PreToolUse')!.kind).toBe('PreToolUse');
    expect(parseTraceHook(post({ hook_event_name: 'Weird' }))).toBeNull();
    expect(parseTraceHook(JSON.stringify({ hook_event_name: 'Stop' }))).toBeNull();
    expect(parseTraceHook('not json')).toBeNull();
    expect(parseTraceHook('42')).toBeNull();
  });

  it('accepts the Cursor and Grok id spellings so their adapters can reuse the parser', () => {
    expect(
      parseTraceHook(JSON.stringify({ conversation_id: 'c1', hook_event_name: 'Stop' }))!
        .session_id,
    ).toBe('c1');
    expect(
      parseTraceHook(JSON.stringify({ sessionId: 'g1', hookEventName: 'Stop' }))!.session_id,
    ).toBe('g1');
  });
});

describe('buildTraceEvent', () => {
  it('digests the session id with the agent key and drops the raw id', () => {
    const ev = buildTraceEvent(binding, parseTraceHook(post())!, 'claude-code', 1_790_000_000_000)!;
    expect(ev.session_digest).toBe(sessionDigest('mskey_test_key', 'sess-1234'));
    expect(ev.session_digest).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(ev)).not.toContain('sess-1234');
    expect(ev).toMatchObject({
      harness: 'claude-code',
      kind: 'PostToolUse',
      ts: 1_790_000_000_000,
    });
  });

  it('returns null for a folder with no agent key — nothing to attribute to', () => {
    expect(
      buildTraceEvent({ ...binding, agent_key: undefined }, parseTraceHook(post())!, 'claude-code'),
    ).toBeNull();
  });
});

describe('emitTraceEvents — fail-open and bounded', () => {
  const ev = buildTraceEvent(binding, parseTraceHook(post())!, 'claude-code')!;

  it('returns false within the budget when the daemon never answers', async () => {
    const http = {
      postTraceEvents: () => new Promise<never>(() => {}),
    } as unknown as import('../client.js').HttpClient;
    const t0 = Date.now();
    expect(await emitTraceEvents(http, 'revive', [ev], 50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('returns false on a refusal and true on a landing, never throws', async () => {
    const refused = {
      postTraceEvents: () => Promise.reject(new Error('401')),
    } as unknown as import('../client.js').HttpClient;
    expect(await emitTraceEvents(refused, 'revive', [ev])).toBe(false);
    const landed = {
      postTraceEvents: () => Promise.resolve({ accepted: 1 }),
    } as unknown as import('../client.js').HttpClient;
    expect(await emitTraceEvents(landed, 'revive', [ev])).toBe(true);
    expect(await emitTraceEvents(landed, 'revive', [])).toBe(false);
  });

  it('MUSTERD_NO_TRACE=1 is the seat’s kill switch', () => {
    expect(traceTapEnabled({})).toBe(true);
    expect(traceTapEnabled({ MUSTERD_NO_TRACE: '1' })).toBe(false);
  });
});

describe('the other harnesses (ADR 445 1a tail)', () => {
  it('names the harness from the payload spelling: Grok camelCase, Cursor conversation_id', () => {
    expect(inferTraceHarness({ sessionId: 'g', hookEventName: 'PreToolUse' })).toBe('grok');
    expect(inferTraceHarness({ conversation_id: 'c' })).toBe('cursor');
    // Claude Code and Codex share a spelling — only the caller can tell them apart.
    expect(inferTraceHarness({ session_id: 's', hook_event_name: 'PostToolUse' })).toBeUndefined();
    expect(
      parseTraceHook(JSON.stringify({ sessionId: 'g', hookEventName: 'PreToolUse' }))!.harness,
    ).toBe('grok');
    expect(parseTraceHook(post())).not.toHaveProperty('harness');
  });

  it("maps Cursor's event names onto the column's spelling and keeps the source name", () => {
    const cursor = (name: string, extra: Record<string, unknown> = {}) =>
      parseTraceHook(JSON.stringify({ conversation_id: 'c1', hook_event_name: name, ...extra }));
    expect(cursor('postToolUse', { tool_name: 'Read' })).toEqual({
      kind: 'PostToolUse',
      session_id: 'c1',
      harness: 'cursor',
      tool_name: 'Read',
      outcome: 'ok',
      detail: { hook_event: 'postToolUse' },
    });
    // afterShellExecution carries the command and its output — sizes are all that cross.
    const shell = cursor('afterShellExecution', { command: 'cat ~/.ssh/id_ed25519', output: 'x' })!;
    expect(shell.kind).toBe('PostToolUse');
    expect(shell.detail).toEqual({ hook_event: 'afterShellExecution' });
    expect(JSON.stringify(shell)).not.toContain('ssh');
    expect(cursor('afterMCPExecution')!.kind).toBe('PostToolUse');
    expect(cursor('sessionStart')!.kind).toBe('SessionStart');
    expect(cursor('beforeSubmitPrompt')!.kind).toBe('UserPromptSubmit');
    expect(cursor('notAnEvent')).toBeNull();
  });

  it('builds a HookOutcome joined to the observed call, and bounded like any detail', () => {
    const observed = buildTraceEvent(binding, parseTraceHook(post())!, 'claude-code')!;
    const out = buildHookOutcomeEvent(observed, {
      hook: 'gate',
      outcome: 'denied',
      duration_ms: 42,
      detail: { decision: 'deny' },
    })!;
    expect(out).toMatchObject({
      kind: 'HookOutcome',
      harness: 'claude-code',
      session_digest: observed.session_digest,
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      duration_ms: 42,
      outcome: 'denied',
      detail: { hook: 'gate', exit_code: 0, decision: 'deny' },
    });
    // No duration given → the hook process's own life so far, which is what the call paid.
    expect(buildHookOutcomeEvent(observed, { hook: 'interrupt' })!.duration_ms).toBeGreaterThan(0);
  });
});

describe('tapHook — one post per hook process', () => {
  afterEach(() => vi.restoreAllMocks());
  const spy = () =>
    vi.spyOn(HttpClient.prototype, 'postTraceEvents').mockResolvedValue({ accepted: 2 });

  it('posts the observed event and the HookOutcome together', async () => {
    const posted = spy();
    expect(
      await tapHook(post(), {
        binding,
        dir: '/tmp',
        harness: 'codex',
        env: {},
        outcome: { hook: 'interrupt', detail: { raised: false } },
      }),
    ).toBe(true);
    expect(posted).toHaveBeenCalledTimes(1);
    const { events } = posted.mock.calls[0]![1];
    expect(events.map((e) => [e.kind, e.harness])).toEqual([
      ['PostToolUse', 'codex'],
      ['HookOutcome', 'codex'],
    ]);
  });

  it("the payload's spelling decides when the caller cannot, then claude-code", async () => {
    const posted = spy();
    await tapHook(JSON.stringify({ sessionId: 'g', hookEventName: 'PreToolUse' }), {
      binding,
      dir: '/tmp',
      harness: undefined,
      env: {},
    });
    await tapHook(post(), { binding, dir: '/tmp', env: {} });
    expect(posted.mock.calls.map((c) => c[1].events[0]!.harness)).toEqual(['grok', 'claude-code']);
  });

  it('observed:false posts only the outcome; the kill switch posts nothing', async () => {
    const posted = spy();
    await tapHook(post(), {
      binding,
      dir: '/tmp',
      env: {},
      observed: false,
      outcome: { hook: 'interrupt' },
    });
    expect(posted.mock.calls[0]![1].events.map((e) => e.kind)).toEqual(['HookOutcome']);
    expect(await tapHook(post(), { binding, dir: '/tmp', env: { MUSTERD_NO_TRACE: '1' } })).toBe(
      false,
    );
    expect(posted).toHaveBeenCalledTimes(1);
  });
});

describe('traceDepth — the `traced:` line (ADR 445 §4)', () => {
  const health = { trace_schema: 1 };
  it('is structural only when the tap would actually record', () => {
    expect(traceDepth(binding, health, {})).toBe('structural');
    expect(traceDepth(binding, health, { MUSTERD_NO_TRACE: '1' })).toBeNull();
    expect(traceDepth({ ...binding, seat_credential: undefined }, health, {})).toBeNull();
    expect(traceDepth({ ...binding, agent_key: undefined }, health, {})).toBeNull();
    expect(traceDepth(null, health, {})).toBeNull();
    // A daemon before ADR 445 names no trace store — there is nowhere to post, so nothing is traced.
    expect(traceDepth(binding, {}, {})).toBeNull();
    expect(traceDepth(binding, undefined, {})).toBeNull();
  });
});
