import type { FlowMetrics, GoalFlow, PeerDemand } from '@musterd/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { setColorEnabled } from '../render/theme.js';
import { renderFlow, renderGoalFlow, renderPeerDemand } from './report.js';

beforeAll(() => setColorEnabled(false));

const DAY = 24 * 60 * 60 * 1000;

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

/** Collect what a renderer writes, the way `report` composes its output. */
function lines(render: (w: (s: string) => void) => void): string {
  const out: string[] = [];
  render((s) => out.push(s));
  return out.join('');
}

describe('renderFlow — the backlog gauge (ADR 295)', () => {
  it('names the queue alongside WIP', () => {
    const out = lines((w) => renderFlow(flow({ wip: 4, backlog: 3 }), w));
    expect(out).toContain('WIP 4');
    expect(out).toContain('queued 3');
  });

  it('stays silent against a pre-295 daemon that sends no backlog', () => {
    const legacy = flow({ wip: 4 });
    delete legacy.backlog;
    const out = lines((w) => renderFlow(legacy, w));
    expect(out).toContain('WIP 4');
    expect(out).not.toContain('queued');
  });
});

describe('renderGoalFlow — flow per Goal (ADR 295)', () => {
  const byGoal: GoalFlow[] = [
    { goal_id: 'launch', flow: flow({ wip: 1, oldest_wip_age_ms: 11 * DAY, backlog: 2 }) },
    { goal_id: 'research', flow: flow({ wip: 2, oldest_wip_age_ms: 3 * DAY }) },
    { goal_id: null, flow: flow({ wip: 1, oldest_wip_age_ms: DAY }) },
  ];

  it('renders one line per goal, dragging goal first', () => {
    const out = lines((w) => renderGoalFlow(byGoal, w));
    expect(out).toContain('launch');
    expect(out.indexOf('launch')).toBeLessThan(out.indexOf('research'));
  });

  it('labels the goal-less pool instead of printing a bare null', () => {
    const out = lines((w) => renderGoalFlow(byGoal, w));
    expect(out).toContain('(no goal)');
    expect(out).not.toContain('null');
  });

  it('writes nothing when no lane names a goal', () => {
    expect(lines((w) => renderGoalFlow([], w))).toBe('');
  });
});

describe('renderPeerDemand (ADR 320 §5b, lane 01M2P7GMVJ)', () => {
  const base = (over: Partial<PeerDemand> = {}): PeerDemand => ({
    window_days: 7,
    challenges: { to_human: 0, to_agent: 2, to_service: 0, unaddressed: 0 },
    handoff_declines: { of_human: 0, of_agent: 1, of_service: 0 },
    humans: [{ name: 'nick', acts: 4, accepts: 3 }],
    flag: false,
    ...over,
  });

  it('prints the three counts lines, counts only below the per-member minimum', () => {
    const out = lines((w) => renderPeerDemand(base(), w));
    expect(out).toContain('challenges received · humans 0 · agents 2 (7d)');
    expect(out).toContain('handoffs declined · of human handoffs 0 · of agent handoffs 1');
    expect(out).toContain('nick — 3 accept of 4 acts');
    expect(out).not.toContain('%');
    expect(out).not.toContain('unaddressed');
    expect(out).not.toContain('⚠');
  });

  it('prints the share only over a stable per-member sample, and names unaddressed challenges', () => {
    const out = lines((w) =>
      renderPeerDemand(
        base({
          challenges: { to_human: 1, to_agent: 0, to_service: 1, unaddressed: 2 },
          humans: [{ name: 'nick', acts: 12, accepts: 3 }],
        }),
        w,
      ),
    );
    expect(out).toContain('services 1 · unaddressed 2');
    expect(out).toContain('nick — 3 accept of 12 acts (25%)');
  });

  it('prints the falsifier warn when the projection flags it', () => {
    const out = lines((w) => renderPeerDemand(base({ flag: true }), w));
    expect(out).toContain(
      'humans receive no challenge and no decline — 5b is unsupported by this window',
    );
  });

  it('says so when the roster has no humans', () => {
    const out = lines((w) => renderPeerDemand(base({ humans: [] }), w));
    expect(out).toContain('no human members');
  });
});
