import type { FlowMetrics, GoalFlow, Report } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { fmtReport } from './insights.js';

function flow(over: Partial<FlowMetrics> = {}): FlowMetrics {
  return {
    throughput_7d: 0,
    cycle_time_ms: null,
    wip: 0,
    oldest_wip_age_ms: null,
    backlog: 0,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

function report(over: Partial<Report> = {}): Report {
  return {
    team: 'revive',
    generated_ts: 1_000_000,
    flow: flow(),
    waiting_on: [],
    goals: [],
    blocked: [],
    coordination: {
      exchange_ratio: 0.5,
      journal_ratio: 0.5,
      acts: 10,
      window_days: 7,
      flag: false,
    },
    open_directed: [],
    mast: {
      window_days: 7,
      time_to_unblock: { closed: 0, median_ms: null, p95_ms: null },
      ignored_help: [],
      stalled_threads: [],
      circular_handoffs: [],
      diversity: [],
    },
    steering: {
      window_days: 7,
      steers: 0,
      acked: 0,
      latency_median_ms: null,
      latency_p95_ms: null,
      superseded_acts: 0,
      stale_wakes: 0,
      stale_caught: 0,
    },
    ...over,
  };
}

describe('fmtReport — the backlog gauge (ADR 295)', () => {
  // The CLI and MCP report have no second fetch, so the `open` queue that the web board reads off
  // /lanes was simply invisible to them.
  it('names the queue on the flow line', () => {
    const out = fmtReport(report({ flow: flow({ wip: 4, backlog: 3 }) }), 'team');
    expect(out).toContain('WIP 4');
    expect(out).toContain('queued 3');
  });

  it('omits the queue against a pre-295 daemon that does not send it', () => {
    const legacy = flow({ wip: 4 });
    delete legacy.backlog;
    const out = fmtReport(report({ flow: legacy }), 'team');
    expect(out).toContain('WIP 4');
    expect(out).not.toContain('queued');
  });
});

describe('fmtReport — per-goal flow (ADR 295)', () => {
  const goalFlow: GoalFlow[] = [
    { goal_id: 'launch', flow: flow({ wip: 1, oldest_wip_age_ms: 11 * DAY, backlog: 2 }) },
    { goal_id: 'research', flow: flow({ wip: 2, oldest_wip_age_ms: 3 * DAY }) },
    { goal_id: null, flow: flow({ wip: 1, oldest_wip_age_ms: DAY }) },
  ];

  it('breaks flow down by goal at the team altitude', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out).toContain('per goal:');
    expect(out).toContain('launch');
    expect(out).toContain('research');
  });

  it('names the goal-less pool rather than printing a bare null', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out).toContain('(no goal)');
    expect(out).not.toContain('null');
  });

  it('keeps the engine ordering — the dragging goal reads first', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out.indexOf('launch')).toBeLessThan(out.indexOf('research'));
  });

  it('says nothing at all when no lane names a goal', () => {
    const out = fmtReport(report({ goal_flow: [] }), 'team');
    expect(out).not.toContain('per goal:');
  });
});
