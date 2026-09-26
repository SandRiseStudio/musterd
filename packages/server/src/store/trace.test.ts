import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openTraceDb, TRACE_MIGRATIONS, traceDbBytes, traceSchemaVersion } from '../db/traceDb.js';
import {
  contentCapturedThrough,
  countTraceEvents,
  ingestTraceEvents,
  listSessionTrace,
  pruneTraceContent,
  TRACE_CONTENT_MAX_AGE_MS,
} from './trace.js';

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
      normalized: 0,
    });
    const withPart = {
      content: { tool_input: 'x', redactions: 0, truncated: false },
    } as unknown as Record<string, unknown>;
    // A content part with writeContent unset (the team policy off) is dropped, not stored.
    expect(ingestTraceEvents(db, 't1', 'ryder', [ev({ kind: 'Stop', ...withPart })])).toEqual({
      accepted: 1,
      content: 0,
      normalized: 0,
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
      ev({ kind: 'HookOutcome', detail: { hook: 'gate', exit_code: 0 }, duration_ms: 42 }),
      ev({ kind: 'PostToolUse' }),
    ]);
    ingestTraceEvents(db, 't1', 'dolly', [ev({ session_digest: '0123456789ab' })]);
    const row = listSessionTrace(db, 't1', 'abcdef012345')[0]!;
    expect(JSON.parse(row.detail!)).toEqual({ hook: 'gate', exit_code: 0 });
    // ADR 453 §2 rule 3: local ingest normalizes to the structural shape, never rejects — a hook
    // name off the producer list lands as `other`, a prose key is dropped, and the count says so.
    const odd = ingestTraceEvents(db, 't1', 'ryder', [
      ev({
        kind: 'HookOutcome',
        tool_name: 'customer-project-summary',
        detail: { hook: 'gate check', exit_code: 0, note: 'see /Users/x/.env' },
      }),
    ]);
    expect(odd).toMatchObject({ accepted: 1, normalized: 3 });
    const last = listSessionTrace(db, 't1', 'abcdef012345').at(-1)!;
    expect(last.tool_name).toBe('other');
    expect(JSON.parse(last.detail!)).toEqual({ hook: 'other', exit_code: 0 });
    expect(row.duration_ms).toBe(42);
    expect(countTraceEvents(db, 't1')).toEqual([
      { kind: 'HookOutcome', count: 2 },
      { kind: 'PostToolUse', count: 2 },
    ]);
    expect(countTraceEvents(db, 't1', 'dolly')).toEqual([{ kind: 'PostToolUse', count: 1 }]);
  });
});

describe('content lifecycle (ADR 445 increment 3a)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_790_400_000_000;
  const part = {
    content: { tool_input: 'ls', redactions: 0, truncated: false },
  } as unknown as Record<string, unknown>;

  /** Four content rows aged 40, 35, 10 and 1 days, plus one structural-only row aged 40 days. */
  function seeded() {
    const db = openTraceDb(':memory:');
    ingestTraceEvents(
      db,
      't1',
      'ryder',
      [40, 35, 10, 1].map(() => ev(part)),
      { writeContent: true },
    );
    ingestTraceEvents(db, 't1', 'ryder', [ev({ kind: 'Stop' })]);
    const ages = [40, 35, 10, 1, 40];
    const rows = listSessionTrace(db, 't1', 'abcdef012345');
    const set = db.prepare('UPDATE trace_events SET received_at = ? WHERE id = ?');
    rows.forEach((r, i) => set.run(NOW - ages[i]! * DAY, r.id));
    return db;
  }
  const state = (db: ReturnType<typeof openTraceDb>) =>
    listSessionTrace(db, 't1', 'abcdef012345').map((r) => [
      r.content === null ? null : 'content',
      r.content_pruned_at,
    ]);

  it('with no capture watermark, nulls content past 30 days and keeps every structural row', () => {
    const db = seeded();
    expect(contentCapturedThrough(db)).toBeNull();
    expect(pruneTraceContent(db, NOW)).toEqual({
      pruned: 2,
      cutoff: NOW - TRACE_CONTENT_MAX_AGE_MS,
      capturedThrough: null,
    });
    expect(state(db)).toEqual([
      [null, NOW],
      [null, NOW],
      ['content', null],
      ['content', null],
      [null, null], // structural-only: never had content, so nothing to prune and no stamp
    ]);
    expect(listSessionTrace(db, 't1', 'abcdef012345')).toHaveLength(5);
    // idempotent: the pruned rows are out of the partial index, a second pass finds nothing
    expect(pruneTraceContent(db, NOW).pruned).toBe(0);
  });

  it('on an archiving machine, never prunes content above the snapshot watermark', () => {
    const db = seeded();
    // A snapshot captured through day -38: the -35 row is past the window but NOT archived.
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('content_captured_through', ?)").run(
      String(NOW - 38 * DAY),
    );
    const r = pruneTraceContent(db, NOW);
    expect(r).toMatchObject({ pruned: 1, capturedThrough: NOW - 38 * DAY, cutoff: NOW - 38 * DAY });
    expect(state(db).slice(0, 2)).toEqual([
      [null, NOW],
      ['content', null],
    ]);
    // A later snapshot moves the watermark past it; the next pass takes it — and never the -10 row.
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'content_captured_through'").run(
      String(NOW - 2 * DAY),
    );
    expect(pruneTraceContent(db, NOW).pruned).toBe(1);
    expect(state(db).slice(1, 4)).toEqual([
      [null, NOW],
      ['content', null],
      ['content', null],
    ]);
  });

  it('prunes in bounded batches and stops at the per-pass cap', () => {
    const db = seeded();
    expect(pruneTraceContent(db, NOW, { batch: 1, maxBatches: 1 }).pruned).toBe(1);
    expect(pruneTraceContent(db, NOW, { batch: 1, maxBatches: 5 }).pruned).toBe(1);
  });

  it('the prune scan rides the partial content-age index', () => {
    const db = seeded();
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT rowid FROM trace_events WHERE content IS NOT NULL AND received_at < ? ORDER BY received_at LIMIT ?',
      )
      .all(NOW, 10) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_trace_events_content_age');
  });
});

describe('traceDbBytes (ADR 445 increment 3a)', () => {
  it('sums the file and its WAL; absent for :memory: or a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-bytes-'));
    try {
      const p = join(dir, 'trace.db');
      expect(traceDbBytes(p)).toBeUndefined();
      writeFileSync(p, Buffer.alloc(4096));
      expect(traceDbBytes(p)).toBe(4096);
      writeFileSync(p + '-wal', Buffer.alloc(100));
      expect(traceDbBytes(p)).toBe(4196);
      expect(traceDbBytes(':memory:')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
