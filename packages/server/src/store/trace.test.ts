import type { TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openTraceDb, TRACE_MIGRATIONS, traceSchemaVersion } from '../db/traceDb.js';
import { countTraceEvents, ingestTraceEvents, listSessionTrace } from './trace.js';

const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({
  harness: 'claude-code',
  session_digest: 'abcdef012345',
  ts: 1_790_000_000_000,
  kind: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  ...over,
});

describe('trace.db (ADR 445 §3)', () => {
  it('opens its own ladder with its own schema_meta — not the coordination store’s', () => {
    const db = openTraceDb(':memory:');
    expect(traceSchemaVersion(db)).toBe(TRACE_MIGRATIONS[TRACE_MIGRATIONS.length - 1]!.version);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['schema_meta', 'trace_events']);
    expect(tables).not.toContain('teams'); // no coordination table is created in this file
  });

  it('assigns a monotonic seq per (team, session) across batches; writes no content unless asked', () => {
    const db = openTraceDb(':memory:');
    expect(ingestTraceEvents(db, 't1', 'ryder', [ev(), ev({ kind: 'PreToolUse' })])).toEqual({
      accepted: 2,
      content: 0,
    });
    const withPart = {
      content: { tool_input: 'x', redactions: 0, truncated: false },
    } as unknown as Record<string, unknown>;
    // A content part with writeContent unset (the team policy off) is dropped, not stored.
    expect(ingestTraceEvents(db, 't1', 'ryder', [ev({ kind: 'Stop', ...withPart })])).toEqual({
      accepted: 1,
      content: 0,
    });
    // a different session on the same team starts its own sequence
    ingestTraceEvents(db, 't1', 'ryder', [ev({ session_digest: 'ffffffff0000' })]);
    // a different team with the same digest is a different sequence too
    ingestTraceEvents(db, 't2', 'other', [ev()]);

    const rows = listSessionTrace(db, 't1', 'abcdef012345');
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [0, 'PostToolUse'],
      [1, 'PreToolUse'],
      [2, 'Stop'],
    ]);
    expect(
      rows.every((r) => r.content === null && r.redactions === null && r.truncated === 0),
    ).toBe(true);
    expect(rows[0]!.seat).toBe('ryder');
    expect(rows[0]!.tool_use_id).toBe('toolu_1');
    expect(listSessionTrace(db, 't1', 'ffffffff0000').map((r) => r.seq)).toEqual([0]);
    expect(listSessionTrace(db, 't2', 'abcdef012345').map((r) => r.seq)).toEqual([0]);
  });

  it('stores detail as JSON and counts by kind, optionally per seat', () => {
    const db = openTraceDb(':memory:');
    ingestTraceEvents(db, 't1', 'ryder', [
      ev({ kind: 'HookOutcome', detail: { hook: 'gate check', exit_code: 0 }, duration_ms: 42 }),
      ev({ kind: 'PostToolUse' }),
    ]);
    ingestTraceEvents(db, 't1', 'dolly', [ev({ session_digest: '0123456789ab' })]);
    const row = listSessionTrace(db, 't1', 'abcdef012345')[0]!;
    expect(JSON.parse(row.detail!)).toEqual({ hook: 'gate check', exit_code: 0 });
    expect(row.duration_ms).toBe(42);
    expect(countTraceEvents(db, 't1')).toEqual([
      { kind: 'HookOutcome', count: 1 },
      { kind: 'PostToolUse', count: 2 },
    ]);
    expect(countTraceEvents(db, 't1', 'dolly')).toEqual([{ kind: 'PostToolUse', count: 1 }]);
  });
});
