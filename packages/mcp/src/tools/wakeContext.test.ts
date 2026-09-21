import { describe, expect, it } from 'vitest';
import { render } from './wakeContext.js';

describe('team_wake_context render (ADR 430)', () => {
  it('shows the thread attributed, the ledger, the memory, and no follow-ups when everything fit', () => {
    const text = render({
      version: 2,
      wake: { kind: 'reply', act_id: 'a2' },
      objective: { action: 'reply' },
      state: {},
      context: {
        thread: {
          acts: [
            { id: 'a1', from: 'nick', act: 'message', ts: 1_000, body: 'first', truncated: false },
            {
              id: 'a2',
              from: 'nick',
              act: 'steer',
              ts: 2_000,
              body: 'do the thing',
              truncated: true,
            },
          ],
          omitted: 0,
        },
        open: [{ kind: 'ask', id: 'q1', from: 'izzo', title: 'review #12', age_ms: 90_000 }],
        memory: { body: 'carrying lane X', truncated: false },
      },
      budget: { limit_bytes: 12_288, used_bytes: 300 },
      fetch: [],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('wake context: reply a2');
    expect(text).toContain('nick · message · a1: first');
    expect(text).toContain('nick · steer · a2: do the thing …');
    expect(text).toContain('open: ask q1 from izzo — review #12 (2m)');
    expect(text).toContain('memory:\ncarrying lane X');
    expect(text).not.toContain('explicit reads');
  });

  it('names the follow-ups only for what did not fit', () => {
    const text = render({
      version: 2,
      wake: { kind: 'work_order', lane_id: 'L1' },
      objective: { action: 'continue_lane' },
      state: {},
      context: { open: [], lane: { detail: 'D', truncated: true } },
      budget: { limit_bytes: 12_288, used_bytes: 100 },
      fetch: ['lane_detail', 'open_items', 'git_artifact'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('lane: D …');
    expect(text).toContain(
      'explicit reads: lane_board, team_inbox_check (open items did not fit), git artifact on the declared branch',
    );
  });

  it('v1 renders exactly as before', () => {
    const text = render({
      version: 1,
      wake: { kind: 'reply', act_id: 'a1' },
      objective: { action: 'reply' },
      state: {},
      fetch: ['inbox_thread', 'seat_memory'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('explicit reads: team_inbox_check, team_memory_read');
    expect(text).not.toContain('thread (');
  });
});
