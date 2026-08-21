import type { FlowMetrics } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { flowLine } from './GoalGridView';

const DAY = 24 * 60 * 60 * 1000;

const flow = (over: Partial<FlowMetrics> = {}): FlowMetrics => ({
  throughput_7d: 0,
  cycle_time_ms: null,
  wip: 0,
  oldest_wip_age_ms: null,
  backlog: 0,
  ...over,
});

/**
 * The card's flow line owns *time and the queue*. Lane composition — how many, how many shipped,
 * how many in review, how many stuck — already sits in the card's foot, and a second count line in
 * the same ink read as a duplicate of it rather than as new information.
 */
describe('flowLine — what the goal card adds, and what it leaves to the foot (ADR 295)', () => {
  it('carries the durations the foot has no way to show', () => {
    expect(flowLine(flow({ wip: 2, oldest_wip_age_ms: 11 * DAY, cycle_time_ms: 2 * DAY }))).toEqual([
      'oldest 11d',
      'cycle 2d',
    ]);
  });

  it('carries the queue, which the foot also lacks', () => {
    expect(flowLine(flow({ backlog: 3 }))).toEqual(['3 queued']);
  });

  it('does not restate lane counts the foot already owns', () => {
    const line = flowLine(flow({ wip: 4, throughput_7d: 9 })).join(' ');
    expect(line).not.toContain('in flight');
    expect(line).not.toContain('9');
  });

  it('says nothing at all for a goal with no time and no queue', () => {
    expect(flowLine(flow({ wip: 1 }))).toEqual([]);
  });
});
