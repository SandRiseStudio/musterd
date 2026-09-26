import type { TraceSessionEvent } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHookStdin } from '../hookStdin.js';
import { setColorEnabled } from '../render/theme.js';
import { tailTranscript } from '../trace/tail.js';
import { renderTraceSession, traceCommand, traceEventSummary } from './trace.js';

vi.mock('../trace/tail.js', () => ({ tailTranscript: vi.fn().mockResolvedValue(true) }));
vi.mock('../trace/hook.js', () => ({ tapHook: vi.fn().mockResolvedValue(true) }));
vi.mock('../hookStdin.js', () => ({ readHookStdin: vi.fn() }));

const event = (over: Partial<TraceSessionEvent>): TraceSessionEvent => ({
  seq: 0,
  ts: Date.UTC(2026, 8, 25, 12, 0, 0),
  received_at: Date.UTC(2026, 8, 25, 12, 0, 1),
  seat: 'ryder',
  harness: 'claude-code',
  kind: 'PreToolUse',
  truncated: false,
  ...over,
});

beforeEach(() => setColorEnabled(false));
afterEach(() => vi.clearAllMocks());

describe('traceEventSummary', () => {
  it('speaks each kind’s own vocabulary', () => {
    expect(
      traceEventSummary(event({ kind: 'PostToolUse', tool_name: 'Bash', duration_ms: 42 })),
    ).toBe('Bash · 42ms');
    expect(
      traceEventSummary(
        event({ kind: 'usage', detail: { input_tokens: 10, output_tokens: 2, model: 'm-1' } }),
      ),
    ).toBe('in 10 · out 2  m-1');
    expect(
      traceEventSummary(event({ kind: 'reasoning', content: { reasoning: 'first line\nsecond' } })),
    ).toBe('first line');
    expect(traceEventSummary(event({ kind: 'reasoning', detail: { reasoning_bytes: 99 } }))).toBe(
      '99 bytes (structural)',
    );
    // increment 3a: content past its window says it was pruned, not that it was never captured
    expect(
      traceEventSummary(
        event({ kind: 'reasoning', detail: { reasoning_bytes: 99 }, content_pruned_at: 1 }),
      ),
    ).toBe('99 bytes (content pruned)');
    expect(traceEventSummary(event({ kind: 'assistant_text', content_pruned_at: 1 }))).toBe(
      '(content pruned)',
    );
    expect(
      traceEventSummary(
        event({ kind: 'unknown', detail: { downgraded: true, reason: 'transcript truncated' } }),
      ),
    ).toBe('DOWNGRADED — transcript truncated');
    expect(traceEventSummary(event({ kind: 'unknown', detail: { type: 'novel' } }))).toBe('novel');
    expect(
      traceEventSummary(event({ kind: 'HookOutcome', outcome: 'ok', detail: { hook: 'gate' } })),
    ).toBe('gate · ok');
  });
});

describe('renderTraceSession', () => {
  it('renders a header and one seq-ordered line per event; an empty session says so', () => {
    const out = renderTraceSession('abcdef012345', [
      event({ seq: 0, kind: 'PreToolUse', tool_name: 'Bash' }),
      event({ seq: 1, kind: 'reasoning', content: { reasoning: 'hm' } }),
    ]);
    expect(out).toContain('session abcdef012345');
    expect(out).toContain('claude-code · seat ryder · 2 events');
    expect(out.split('\n')).toHaveLength(3);
    expect(renderTraceSession('abcdef012345', [])).toContain('no trace events');
  });
});

describe('trace hook → the transcript tail (increment 2)', () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      hook_event_name: 'Stop',
      ...over,
    });

  const hook = (flags: Record<string, string | boolean> = { stdin: true }) =>
    traceCommand({ positionals: ['hook'], flags } as never);

  it('runs the tail on Stop and SessionEnd, not on other events, and exits 0 regardless', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(payload());
    expect(await hook()).toBe(0);
    expect(tailTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', transcriptPath: '/tmp/t.jsonl' }),
    );

    vi.mocked(readHookStdin).mockResolvedValue(payload({ hook_event_name: 'UserPromptSubmit' }));
    await hook();
    expect(tailTranscript).toHaveBeenCalledTimes(1);

    vi.mocked(readHookStdin).mockResolvedValue(payload({ transcript_path: undefined }));
    await hook();
    expect(tailTranscript).toHaveBeenCalledTimes(1); // no path, nothing to tail — still exit 0
  });
});
