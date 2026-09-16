import { laneVerdictAck } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { registerSend } from './send.js';

/**
 * Lane 01M2KYF888: the caution on an acceptance verdict must survive a STRUCTURED-FIRST client.
 *
 * `team_send {act:'accept', reply_to:<a lane_review ask>}` closes a teammate's lane (ADR 202). The
 * sentence explaining that — and that a `decline` will not undo it — was composed into `text` only,
 * so a client that renders `structuredContent` and drops `content[].text` showed the seat that a
 * lane had closed and none of the reason it could not be taken back. It was tripped exactly that
 * way on 2026-09-16, on the surface the guidance exists to protect.
 *
 * `handoff_lane.warning` twelve lines up in the same function already carries its caution
 * structurally. These tests hold `lane_verdict` to the same bar.
 */
describe('laneVerdictAck (lane 01M2KYF888)', () => {
  it('an accept carries its caution in the ack itself, not only in prose', () => {
    const ack = laneVerdictAck({ lane: '01LANE', state: 'done' });
    expect(ack.lane).toBe('01LANE');
    expect(ack.state).toBe('done');
    // The three things a seat who meant "taking this" has to learn, from the ack ALONE.
    expect(ack.guidance).toMatch(/was the acceptance verdict/i);
    expect(ack.guidance).toMatch(/not an announcement/i);
    expect(ack.guidance).toMatch(/lane_update/);
  });

  it('names the recovery, because a decline on the same ask does NOT reopen an accepted lane', () => {
    // route.ts applyAcceptanceVerdict returns early unless the lane isAwaitingAcceptance, and an
    // accepted lane is `done` — so the obvious undo is a silent no-op and the ack must say so.
    const { guidance } = laneVerdictAck({ lane: '01LANE', state: 'done' });
    expect(guidance).toMatch(/decline/i);
    expect(guidance).toMatch(/state:\s*'active'/);
  });

  it('a decline says the work went back to its owner, and claims no irreversibility', () => {
    const { guidance } = laneVerdictAck({ lane: '01LANE', state: 'active' });
    expect(guidance).toMatch(/back to its owner/i);
    expect(guidance).not.toMatch(/lane_update/);
  });

  it('the ack is self-contained: the lane id is in the guidance, not only in a sibling field', () => {
    // A renderer may surface one string. It must still say WHICH lane moved.
    expect(laneVerdictAck({ lane: '01WHICH', state: 'done' }).guidance).toContain('01WHICH');
    expect(laneVerdictAck({ lane: '01WHICH', state: 'active' }).guidance).toContain('01WHICH');
  });
});

/**
 * The end-to-end hold, on the surface that actually failed: drive the real `team_send` handler
 * against a daemon that returns a verdict, and assert the caution is reachable WITHOUT reading
 * `content[].text`. If this passes while the prose is deleted, the structured client is covered;
 * that is the whole point of the lane.
 */
describe('team_send surfaces the verdict caution structurally (lane 01M2KYF888)', () => {
  const config = { team: 'dawn', member: 'Ada', surface: 'claude-code' };

  function handlerFor(lane_verdict: { lane: string; state: 'done' | 'active' } | undefined) {
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
      sendEnvelope: async () => (lane_verdict ? { lane_verdict } : undefined),
    };
    registerSend(server as any, client, config as any);
    return handlers['team_send']!;
  }

  it('an accept that closed a lane says so in structuredContent, not only in prose', async () => {
    const res = await handlerFor({ lane: '01CLOSED', state: 'done' })({
      to: 'big-body',
      act: 'accept',
      body: 'taking this',
      reply_to: '01ASK',
    });
    const verdict = res.structuredContent.lane_verdict;
    expect(verdict.lane).toBe('01CLOSED');
    expect(verdict.state).toBe('done');
    // Reading ONLY the structured field, a seat learns it judged rather than announced,
    // and learns the recovery — neither of which used to survive a dropped `text`.
    expect(verdict.guidance).toMatch(/not an announcement/i);
    expect(verdict.guidance).toMatch(/lane_update/);
  });

  it('a decline carries its own sentence structurally too', async () => {
    const res = await handlerFor({ lane: '01SENTBACK', state: 'active' })({
      to: 'big-body',
      act: 'decline',
      body: 'not yet',
      reply_to: '01ASK',
    });
    expect(res.structuredContent.lane_verdict.guidance).toMatch(/back to its owner/i);
  });

  it('the prose still carries it, for the surfaces that show prose', async () => {
    const res = await handlerFor({ lane: '01CLOSED', state: 'done' })({
      to: 'big-body',
      act: 'accept',
      body: 'x',
      reply_to: '01ASK',
    });
    expect(res.content[0].text).toContain('not an announcement');
    // One text, two surfaces: they cannot drift, because they are the same string.
    expect(res.content[0].text).toContain(res.structuredContent.lane_verdict.guidance);
  });

  it('an ordinary send carries no verdict field at all', async () => {
    const res = await handlerFor(undefined)({ to: '@team', act: 'status_update', body: 'x' });
    expect(res.structuredContent.lane_verdict).toBeUndefined();
  });
});
