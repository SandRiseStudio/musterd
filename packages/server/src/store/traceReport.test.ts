import type { TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openTraceDb } from '../db/traceDb.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';
import { ingestTraceEvents } from './trace.js';
import { deriveTraceReport } from './traceReport.js';

const H = 60 * 60 * 1000;
const NOW = 1_790_400_000_000;

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
  harness: 'claude-code',
  session_digest: 'aaaaaaaaaaaa',
  ts: NOW - H,
  kind: 'PostToolUse',
  ...over,
});
const usage = (seat: string, ts: number, tokens: Record<string, number>, digest = 'aaaaaaaaaaaa') =>
  ev({ kind: 'usage', ts, session_digest: digest, detail: { parser: 'claude-code@1', ...tokens } });

function fixture() {
  const db = openDb(':memory:');
  const traceDb = openTraceDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  addMember(db, team, { name: 'nick', kind: 'human', role: 'admin' });
  addMember(db, team, { name: 'ryder', kind: 'agent' });
  addMember(db, team, { name: 'izzo', kind: 'agent' });
  return { db, traceDb, team };
}

describe('deriveTraceReport (ADR 445 increment 4)', () => {
  it('coverage: R1 PostToolUse over R2 tool_uses, per harness, with the R2-rail session count', () => {
    const { db, traceDb, team } = fixture();
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      ev({ tool_name: 'Bash' }),
      ev({ tool_name: 'Read' }),
      ev({ tool_name: 'Bash', outcome: 'error', kind: 'PostToolUseFailure' }),
      usage('ryder', NOW - H, { tool_uses: 4, input_tokens: 10, output_tokens: 5 }),
      ev({ harness: 'codex', session_digest: 'bbbbbbbbbbbb', tool_name: 'Bash' }),
    ]);
    const r = deriveTraceReport(db, traceDb, team.id, ['ryder', 'izzo'], { days: 7, now: NOW });
    expect(r.coverage).toEqual([
      {
        harness: 'claude-code',
        sessions: 1,
        sessions_with_r2: 1,
        post_tool_use: 2,
        r2_tool_uses: 4,
        coverage: 0.5,
      },
      {
        harness: 'codex',
        sessions: 1,
        sessions_with_r2: 0,
        post_tool_use: 1,
        r2_tool_uses: 0,
        coverage: null,
      },
    ]);
    expect(r.tool_mix).toEqual([
      { harness: 'claude-code', tool: 'Bash', calls: 2, errors: 1, avg_duration_ms: null },
      { harness: 'codex', tool: 'Bash', calls: 1, errors: 0, avg_duration_ms: null },
      { harness: 'claude-code', tool: 'Read', calls: 1, errors: 0, avg_duration_ms: null },
    ]);
  });

  it('cost per lane: a usage row goes to the most recently claimed open lane; none → unattributed', () => {
    const { db, traceDb, team } = fixture();
    openLane(db, team.id, 'dawn', 'ryder', { title: 'lane A', claim: true }, NOW - 5 * H);
    openLane(db, team.id, 'dawn', 'ryder', { title: 'lane B', claim: true }, NOW - 2 * H);
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      usage('ryder', NOW - 6 * H, { input_tokens: 1, output_tokens: 1 }), // before any claim
      usage('ryder', NOW - 4 * H, { input_tokens: 10, output_tokens: 20 }), // only A open
      usage('ryder', NOW - 1 * H, { input_tokens: 100, output_tokens: 200, cache_read_tokens: 7 }), // A and B open → B
    ]);
    ingestTraceEvents(traceDb, team.id, 'izzo', [
      usage('izzo', NOW - 1 * H, { input_tokens: 3, output_tokens: 3 }, 'cccccccccccc'), // izzo owns nothing
    ]);
    const r = deriveTraceReport(db, traceDb, team.id, ['ryder', 'izzo'], { days: 7, now: NOW });
    expect(
      r.lane_cost.map((l) => [
        l.title,
        l.turns,
        l.input_tokens,
        l.output_tokens,
        l.cache_read_tokens,
      ]),
    ).toEqual([
      ['lane B', 1, 100, 200, 7],
      ['lane A', 1, 10, 20, 0],
    ]);
    expect(r.unattributed).toEqual({
      turns: 2,
      input_tokens: 4,
      output_tokens: 4,
      cache_read_tokens: 0,
    });
  });

  it('scopes to the seats given, and the window', () => {
    const { db, traceDb, team } = fixture();
    ingestTraceEvents(traceDb, team.id, 'ryder', [ev({ tool_name: 'Bash' })]);
    ingestTraceEvents(traceDb, team.id, 'izzo', [
      ev({ tool_name: 'Edit', session_digest: 'dddddddddddd' }),
      ev({ tool_name: 'Edit', session_digest: 'eeeeeeeeeeee', ts: NOW - 10 * 24 * H }),
    ]);
    const own = deriveTraceReport(db, traceDb, team.id, ['izzo'], { days: 7, now: NOW });
    expect(own.seats).toEqual(['izzo']);
    expect(own.tool_mix).toEqual([
      { harness: 'claude-code', tool: 'Edit', calls: 1, errors: 0, avg_duration_ms: null },
    ]);
    expect(own.coverage[0]!.sessions).toBe(1);
    const none = deriveTraceReport(db, traceDb, team.id, [], { days: 7, now: NOW });
    expect(none.coverage).toEqual([]);
    expect(none.tool_mix).toEqual([]);
  });
});
