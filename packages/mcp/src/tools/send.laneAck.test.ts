import { ACCEPTANCE_MOVES_NOTICE, laneAckAck } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { registerSend } from './send.js';

/**
 * Lane 01M2P2E2H6: an acceptance ask had no reply that meant "I have this" without also meaning
 * "and here is my verdict". The acknowledge is `wait`; these hold the two halves of making it real
 * — the ask says both moves exist, and the acknowledge's ack says plainly that nothing moved.
 *
 * The negative claim is the load-bearing one. A quiet acknowledge would leave "acknowledged" and
 * "accepted" indistinguishable from the sender's side, which is the ambiguity this lane removes.
 */
describe('laneAckAck', () => {
  it('states the negative outcome outright: no lane moved, the verdict is still owed', () => {
    const ack = laneAckAck({ lane: '01LANE' });
    expect(ack.lane).toBe('01LANE');
    expect(ack.guidance).toMatch(/no lane moved/i);
    expect(ack.guidance).toMatch(/still yours/i);
  });

  it('names the moves that DO decide, so the acknowledge is not a dead end', () => {
    const { guidance } = laneAckAck({ lane: '01LANE' });
    expect(guidance).toMatch(/accept/);
    expect(guidance).toMatch(/decline/);
  });

  it('is self-contained: a renderer showing one string still says which lane', () => {
    expect(laneAckAck({ lane: '01WHICH' }).guidance).toContain('01WHICH');
  });
});

describe('ACCEPTANCE_MOVES_NOTICE — said in the ask, before either move is made', () => {
  it('names the terminal move as terminal, and the non-terminal one by act', () => {
    expect(ACCEPTANCE_MOVES_NOTICE).toMatch(/IS the verdict/);
    expect(ACCEPTANCE_MOVES_NOTICE).toMatch(/`wait`/);
    // The correction that the verdict ack already had to make after the fact.
    expect(ACCEPTANCE_MOVES_NOTICE).toMatch(/does not undo/i);
  });
});

describe('team_send surfaces the acknowledge structurally', () => {
  const config = { team: 'dawn', member: 'Ada', surface: 'claude-code' };

  function handlerFor(lane_ack: { lane: string } | undefined) {
    const handlers: Record<string, (a: any) => Promise<any>> = {};
    const server = {
      registerTool: (name: string, _s: unknown, h: (a: any) => Promise<any>) => {
        handlers[name] = h;
      },
    };
    const client: any = {
      joined: true,
      holdsSeat: true,
      member: 'Ada',
      markSeen: () => undefined,
      sendEnvelope: async () => (lane_ack ? { lane_ack } : undefined),
    };
    registerSend(server as any, client, config as any);
    return handlers['team_send']!;
  }

  it('a wait that took an ask reports it in structuredContent, not only in prose', async () => {
    const res = await handlerFor({ lane: '01TAKEN' })({
      to: 'big-body',
      act: 'wait',
      body: 'taking this review, judging it next',
      reply_to: '01ASK',
    });
    expect(res.structuredContent.lane_ack.lane).toBe('01TAKEN');
    expect(res.structuredContent.lane_ack.guidance).toMatch(/no lane moved/i);
  });

  it('one text, two surfaces — the prose is the same string, so they cannot drift', async () => {
    const res = await handlerFor({ lane: '01TAKEN' })({
      to: 'big-body',
      act: 'wait',
      body: 'x',
      reply_to: '01ASK',
    });
    expect(res.content[0].text).toContain(res.structuredContent.lane_ack.guidance);
  });

  it('an ordinary wait carries no ack field at all', async () => {
    const res = await handlerFor(undefined)({ to: '@team', act: 'wait', body: 'x' });
    expect(res.structuredContent.lane_ack).toBeUndefined();
  });
});
