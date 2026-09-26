import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Binding, TRACE_CONTENT_MAX_BYTES, TRACE_POLICY_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../client.js';
import { sessionDigest } from '../session/digest.js';
import {
  buildHookOutcomeEvent,
  buildTraceEvent,
  emitTraceEvents,
  extractTraceContent,
  inferTraceHarness,
  parseTraceHook,
  readTraceContentMode,
  tapHook,
  traceContentEnabled,
  traceDepth,
  tracedLine,
  traceTapEnabled,
  writeTraceContentMode,
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

  it('keeps the first of two ids Cursor joins with a newline (ADR 453 §2, the tap fix)', () => {
    const parsed = parseTraceHook(
      JSON.stringify({
        conversation_id: 'c1',
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_use_id:
          'call-8f3a9c1d-0000-4000-8000-000000000000-01\nfc_8f3a9c1d000040008000000000000000_1',
      }),
    )!;
    expect(parsed.tool_use_id).toBe('call-8f3a9c1d-0000-4000-8000-000000000000-01');
    expect(parsed.tool_use_id).not.toContain('\n');
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

describe('tracedLine — sized by the daemon (ADR 445 increment 3a)', () => {
  it('appends trace.db size when /health reports it, and stays bare otherwise', () => {
    expect(tracedLine('structural', { trace_db_bytes: 8_396_800 })).toBe(
      'traced: structural · trace.db 8 MiB',
    );
    expect(tracedLine('structural+content', { trace_db_bytes: 300_000 })).toBe(
      'traced: structural+content · trace.db 293 KiB',
    );
    expect(tracedLine('structural', {})).toBe('traced: structural');
    expect(tracedLine('structural', null)).toBe('traced: structural');
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

describe('increment 1b — the content part', () => {
  const secret = 'mskey_Zq7xK2mNvB9pLw4R';
  const payload = post({
    tool_input: { command: `cat .musterd/binding.json` },
    tool_response: { stdout: `{"agent_key":"${secret}"}` },
  });

  it('is extracted only when asked, scrubbed before it leaves the process', () => {
    expect(parseTraceHook(payload)).not.toHaveProperty('content');
    const c = parseTraceHook(payload, undefined, { content: true })!.content!;
    expect(c.tool_input).toBe('{"command":"cat .musterd/binding.json"}');
    expect(c.tool_response).toContain('<redacted:agent_key>');
    expect(JSON.stringify(c)).not.toContain(secret);
    expect(c).toMatchObject({ redactions: 1, truncated: false });
  });

  it('reads Cursor shell events and Claude Code prompts / assistant messages', () => {
    expect(extractTraceContent({ command: 'ls', output: 'a\nb', conversation_id: 'c' })).toEqual({
      tool_input: 'ls',
      tool_response: 'a\nb',
      redactions: 0,
      truncated: false,
    });
    expect(extractTraceContent({ prompt: 'hi', last_assistant_message: 'done' })).toEqual({
      prompt: 'hi',
      assistant: 'done',
      redactions: 0,
      truncated: false,
    });
    expect(extractTraceContent({ session_id: 's' })).toBeUndefined();
  });

  it('bounds the whole part to 256 KiB, scrubbing before the cut', () => {
    // A secret right at the bound: scrubbed whole first, so the cut can never leave a fragment.
    const big = 'x'.repeat(TRACE_CONTENT_MAX_BYTES - 10) + secret + 'y'.repeat(1000);
    const c = extractTraceContent({ tool_response: big, error: 'boom' })!;
    const total = Buffer.byteLength(c.tool_response!, 'utf8') + Buffer.byteLength(c.error ?? '');
    expect(total).toBeLessThanOrEqual(TRACE_CONTENT_MAX_BYTES);
    expect(c.truncated).toBe(true);
    expect(c.redactions).toBe(1);
    expect(c.tool_response).not.toContain('mskey_Zq7');
    // A 5 MB response is pre-cut, not regex-scanned whole.
    const huge = extractTraceContent({ tool_response: 'z'.repeat(5_000_000) })!;
    expect(Buffer.byteLength(huge.tool_response!)).toBe(TRACE_CONTENT_MAX_BYTES);
  });

  it('never leaves half a UTF-8 character at the cut', () => {
    const c = extractTraceContent({ tool_response: '€'.repeat(TRACE_CONTENT_MAX_BYTES) })!;
    expect(c.tool_response!.endsWith('€')).toBe(true);
    expect(c.tool_response).not.toContain('�');
  });
});

describe('the content mode cache and its gates', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-trace-mode-'));
    mkdirSync(join(dir, '.musterd'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads off until a daemon said on; an unreadable file is off', () => {
    expect(readTraceContentMode(dir)).toBe('off');
    writeTraceContentMode(dir, 'on');
    expect(readTraceContentMode(dir)).toBe('on');
    writeFileSync(join(dir, '.musterd', TRACE_POLICY_FILE), '{not json');
    expect(readTraceContentMode(dir)).toBe('off');
  });

  it('sends content only when the cache says on AND the daemon is loopback', () => {
    writeTraceContentMode(dir, 'on');
    expect(traceContentEnabled({ server: 'http://localhost:4849' }, dir)).toBe(true);
    expect(traceContentEnabled({ server: 'http://127.0.0.1:4849' }, dir)).toBe(true);
    expect(traceContentEnabled({ server: 'http://[::1]:4849' }, dir)).toBe(true);
    expect(traceContentEnabled({ server: 'https://musterd.example.com' }, dir)).toBe(false);
    expect(traceContentEnabled({ server: 'http://100.64.1.2:4849' }, dir)).toBe(false);
    writeTraceContentMode(dir, 'off');
    expect(traceContentEnabled({ server: 'http://localhost:4849' }, dir)).toBe(false);
  });

  it('tapHook learns the mode from the reply, and sends content from the next hook on', async () => {
    const local = { ...binding, server: 'http://127.0.0.1:4849' } as Binding;
    const posted = vi
      .spyOn(HttpClient.prototype, 'postTraceEvents')
      .mockResolvedValue({ accepted: 1, content: 'on' });
    const raw = post({ tool_response: { stdout: 'hello' } });
    await tapHook(raw, { binding: local, dir, env: {} });
    expect(posted.mock.calls[0]![1].events[0]).not.toHaveProperty('content');
    expect(readTraceContentMode(dir)).toBe('on');
    await tapHook(raw, {
      binding: local,
      dir,
      env: {},
      outcome: { hook: 'interrupt' },
    });
    const [observed, outcome] = posted.mock.calls[1]![1].events;
    expect(observed!.content).toMatchObject({ tool_response: '{"stdout":"hello"}' });
    expect(outcome).not.toHaveProperty('content'); // a HookOutcome never carries content
    // A pre-1b daemon omits the mode: that reads as off, and the next hook sends none.
    posted.mockResolvedValue({ accepted: 1 });
    await tapHook(raw, { binding: local, dir, env: {} });
    expect(readTraceContentMode(dir)).toBe('off');
  });

  it('traceDepth says structural+content only where the hooks would send it', () => {
    const local = { ...binding, server: 'http://localhost:4849' } as Binding;
    expect(traceDepth(local, { trace_schema: 1 }, {}, dir)).toBe('structural');
    writeTraceContentMode(dir, 'on');
    expect(traceDepth(local, { trace_schema: 1 }, {}, dir)).toBe('structural+content');
    expect(traceDepth(local, { trace_schema: 1 }, {})).toBe('structural');
    expect(traceDepth(local, { trace_schema: 1 }, { MUSTERD_NO_TRACE: '1' }, dir)).toBeNull();
  });
});
