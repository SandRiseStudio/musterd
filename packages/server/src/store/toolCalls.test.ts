import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { listAudit } from './audit.js';
import { createTeam } from './teams.js';
import { deriveToolCallMetrics, recordSurfaceRender, recordToolCalls } from './toolCalls.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  return { db, team };
}

const HOUR = 60 * 60 * 1000;

describe('recordToolCalls (ADR 144 inc 1 — the hourly aggregate)', () => {
  it('upserts into one row per (seat, tool, outcome, hour) — never one row per call', () => {
    const { db, team } = seed();
    const now = 10 * HOUR + 5;
    recordToolCalls(
      db,
      team.id,
      'ada',
      'backend',
      [
        {
          tool: 'team_send',
          outcome: 'ok',
          calls: 3,
          total_duration_ms: 300,
          max_duration_ms: 200,
        },
      ],
      now,
    );
    // A second flush in the same hour folds in: calls add, durations add, max keeps the max.
    recordToolCalls(
      db,
      team.id,
      'ada',
      'backend',
      [
        {
          tool: 'team_send',
          outcome: 'ok',
          calls: 2,
          total_duration_ms: 500,
          max_duration_ms: 450,
        },
      ],
      now + 60_000,
    );
    const rows = db.prepare('SELECT * FROM tool_call_stats').all() as {
      calls: number;
      total_duration_ms: number;
      max_duration_ms: number;
      bucket_start: number;
      role: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(5);
    expect(rows[0]!.total_duration_ms).toBe(800);
    expect(rows[0]!.max_duration_ms).toBe(450);
    expect(rows[0]!.bucket_start).toBe(10 * HOUR);
    expect(rows[0]!.role).toBe('backend');
    // The next hour starts a new bucket.
    recordToolCalls(
      db,
      team.id,
      'ada',
      'backend',
      [{ tool: 'team_send', outcome: 'ok', calls: 1, total_duration_ms: 10, max_duration_ms: 10 }],
      now + HOUR,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_call_stats').get()).toEqual({ n: 2 });
  });

  it('a later flush with a role fills in a previously-unroled row (last write wins, never null-clobbers)', () => {
    const { db, team } = seed();
    const now = 10 * HOUR;
    const e = [
      {
        tool: 'team_status',
        outcome: 'ok' as const,
        calls: 1,
        total_duration_ms: 5,
        max_duration_ms: 5,
      },
    ];
    recordToolCalls(db, team.id, 'ada', 'backend', e, now);
    recordToolCalls(db, team.id, 'ada', null, e, now + 1);
    const row = db.prepare('SELECT role FROM tool_call_stats').get() as { role: string | null };
    expect(row.role).toBe('backend');
  });
});

describe('deriveToolCallMetrics', () => {
  it('aggregates per tool across seats/outcomes with bounce rate, latency, and the role split', () => {
    const { db, team } = seed();
    const now = 100 * HOUR;
    recordToolCalls(
      db,
      team.id,
      'ada',
      'backend',
      [
        {
          tool: 'team_send',
          outcome: 'ok',
          calls: 8,
          total_duration_ms: 800,
          max_duration_ms: 300,
        },
        {
          tool: 'team_send',
          outcome: 'invalid_input',
          calls: 2,
          total_duration_ms: 20,
          max_duration_ms: 15,
        },
      ],
      now - HOUR,
    );
    recordToolCalls(
      db,
      team.id,
      'billie',
      null,
      [
        {
          tool: 'team_send',
          outcome: 'error',
          calls: 1,
          total_duration_ms: 50,
          max_duration_ms: 50,
        },
      ],
      now - HOUR,
    );
    const m = deriveToolCallMetrics(db, team.id, now);
    expect(m.calls).toBe(11);
    expect(m.bounces).toBe(2);
    expect(m.tools).toHaveLength(1);
    const send = m.tools[0]!;
    expect(send.tool).toBe('team_send');
    expect(send.calls).toBe(11);
    expect(send.errors).toBe(1);
    expect(send.bounces).toBe(2);
    expect(send.bounce_rate).toBeCloseTo(2 / 11);
    expect(send.avg_duration_ms).toBe(Math.round(870 / 11));
    expect(send.max_duration_ms).toBe(300);
    expect(send.by_role).toEqual({ backend: 10, unroled: 1 });
  });

  it('windows the counters to 7d but keeps the newest surface attestation per seat regardless', () => {
    const { db, team } = seed();
    const now = 1000 * HOUR;
    recordToolCalls(
      db,
      team.id,
      'ada',
      null,
      [{ tool: 'team_status', outcome: 'ok', calls: 4, total_duration_ms: 4, max_duration_ms: 1 }],
      now - 8 * 24 * HOUR, // outside the window
    );
    recordSurfaceRender(db, team.id, 'ada', { tools: 18, bytes: 40_000, est_tokens: 10_000 });
    const m = deriveToolCallMetrics(db, team.id, now);
    expect(m.calls).toBe(0);
    expect(m.tools).toHaveLength(0);
    expect(m.surface).toHaveLength(1);
    expect(m.surface[0]).toMatchObject({
      seat: 'ada',
      tools: 18,
      bytes: 40_000,
      est_tokens: 10_000,
    });
  });

  it('surface attestations land append-only in the audit ledger; the newest per seat wins', async () => {
    const { db, team } = seed();
    recordSurfaceRender(db, team.id, 'ada', {
      tools: 18,
      bytes: 40_000,
      est_tokens: 10_000,
      breakdown: [{ tool: 'team_send', bytes: 2_000, description_bytes: 1_700 }],
    });
    // Audit rows are stamped Date.now(); step past the ms so "newest" is unambiguous (ulid ids
    // don't order within one tick).
    await new Promise((r) => setTimeout(r, 2));
    recordSurfaceRender(db, team.id, 'ada', { tools: 18, bytes: 30_000, est_tokens: 7_500 });
    const rows = listAudit(db, team.id).filter((r) => r.action === 'mcp.surface_rendered');
    expect(rows).toHaveLength(2); // append-only: the history IS the before/after
    const m = deriveToolCallMetrics(db, team.id);
    expect(m.surface).toHaveLength(1);
    expect(m.surface[0]!.bytes).toBe(30_000);
  });
});
