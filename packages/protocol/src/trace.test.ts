import { describe, expect, it } from 'vitest';
import {
  TRACE_EVENT_KINDS,
  TRACE_MAX_BATCH,
  TraceEventBatchSchema,
  TraceEventSchema,
  TraceIngestResponseSchema,
} from './trace.js';

const minimal = {
  harness: 'claude-code',
  session_digest: 'deadbeef0123',
  ts: 1_790_000_000_000,
  kind: 'PostToolUse',
};

describe('TraceEvent (ADR 445 R1, structural)', () => {
  it('accepts a minimal structural event and every kind the ADR names', () => {
    expect(TraceEventSchema.parse(minimal)).toEqual(minimal);
    for (const kind of TRACE_EVENT_KINDS) {
      expect(TraceEventSchema.safeParse({ ...minimal, kind }).success).toBe(true);
    }
    expect(TRACE_EVENT_KINDS).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'SessionEnd',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'PreCompact',
        'HookOutcome',
        // Rail R2 (increment 2): transcript records, lowercase to keep the rails apart.
        'reasoning',
        'assistant_text',
        'usage',
        'unknown',
      ]),
    );
  });

  it('accepts an R2 event with a reasoning content part (increment 2)', () => {
    const event = {
      ...minimal,
      kind: 'reasoning',
      tool_use_id: 'toolu_01ABC',
      detail: { parser: 'claude-code@1', reasoning_bytes: 42 },
      content: { reasoning: 'weigh the options', redactions: 0, truncated: false },
    };
    expect(TraceEventSchema.parse(event)).toEqual(event);
  });

  it('carries the structural columns and nothing else — no content field exists in 1a', () => {
    const full = {
      ...minimal,
      kind: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01ABC',
      agent_id: 'a1',
      parent_agent_id: 'p1',
      duration_ms: 1234,
      outcome: 'ok',
      detail: { hook: 'gate check', exit_code: 0 },
    };
    expect(TraceEventSchema.parse(full)).toEqual(full);
    // A content part (tool_input / tool_response / prompt) is 1b; a client that sends one today is
    // not silently stored — the schema strips it, so the row structurally cannot carry it.
    const withContent = TraceEventSchema.parse({ ...minimal, tool_input: { command: 'cat key' } });
    expect('tool_input' in withContent).toBe(false);
  });

  it('rejects a raw session id shape, an unknown kind, and an unbounded harness', () => {
    expect(
      TraceEventSchema.safeParse({ ...minimal, session_digest: 'not-hex-at-all-!' }).success,
    ).toBe(false);
    expect(TraceEventSchema.safeParse({ ...minimal, kind: 'Reasoning' }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...minimal, harness: 'Claude Code' }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...minimal, outcome: 'meh' }).success).toBe(false);
  });

  it('bounds the detail part so a hook cannot smuggle a payload through it', () => {
    const big = { ...minimal, detail: { blob: 'x'.repeat(5000) } };
    expect(TraceEventSchema.safeParse(big).success).toBe(false);
  });

  it('batches are bounded and non-empty; the response is counts only', () => {
    expect(TraceEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      TraceEventBatchSchema.safeParse({ events: Array(TRACE_MAX_BATCH + 1).fill(minimal) }).success,
    ).toBe(false);
    expect(TraceEventBatchSchema.parse({ events: [minimal] }).events).toHaveLength(1);
    expect(TraceIngestResponseSchema.parse({ accepted: 1 })).toEqual({ accepted: 1 });
  });
});
