import type { Seed } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import { registerSeeds } from './seeds.js';

type Handler = (args: any) => Promise<{ content: { text: string }[]; structuredContent?: any }>;

function captureAll(client: Partial<MusterdClient>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerSeeds(
    {
      registerTool: (name: string, _schema: unknown, handler: Handler) => {
        handlers[name] = handler;
      },
    } as any,
    client as MusterdClient,
  );
  return handlers;
}

function seed(over: Partial<Seed> = {}): Seed {
  return {
    id: '01SEED00000000000000000000',
    team: 'dawn',
    relay_id: 'relay-1',
    source: 'slack',
    body: 'Try a shared Seed tray',
    captured_at: 1,
    slack_user_id: 'U123',
    submitted_by: 'nick',
    state: 'open',
    explorer: null,
    thread: [],
    final_brief: null,
    conclusion: null,
    linked_lane_id: null,
    promotion: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe('Shared Seed MCP tools', () => {
  it('lists the active tray by default and returns structured Seeds', async () => {
    const seeds = vi
      .fn()
      .mockResolvedValue([
        seed(),
        seed({ id: 'old', state: 'promoted', linked_lane_id: 'lane-1' }),
      ]);
    const result = await captureAll({ seeds })['team_seed_list']!({});

    expect(result.content[0]!.text).toContain('01SEED00000000000000000000 [open]');
    expect(result.content[0]!.text).not.toContain('old');
    expect(result.structuredContent).toMatchObject({ seeds: [{ state: 'open' }] });
  });

  it('claims a Seed and makes the next state explicit', async () => {
    const claimSeed = vi.fn().mockResolvedValue(seed({ state: 'exploring', explorer: 'Ada' }));
    const result = await captureAll({ claimSeed })['team_seed_claim']!({
      id: '01SEED00000000000000000000',
    });

    expect(result.content[0]!.text).toBe('Seed 01SEED00000000000000000000 — exploring as Ada');
    expect(result.structuredContent).toMatchObject({
      seed: { state: 'exploring', explorer: 'Ada' },
    });
  });

  it('submits the structured exhaustive result without a file intermediary', async () => {
    const completed = seed({ state: 'completed', completed_at: 2, conclusion: 'Not now' });
    const submitSeed = vi.fn().mockResolvedValue(completed);
    const brief = {
      problem: 'Ideas disappear',
      context: 'The Team needs a tray',
      external_evidence: ['Relay observation'],
      approaches: [{ approach: 'Shared Seeds', tradeoffs: 'Adds lifecycle' }],
      constraints: ['Keep Lanes unchanged'],
      risks: ['Clutter'],
      unknowns: ['Volume'],
      recommendation: 'Ship the bounded tray',
      proposed_lane: { title: 'Build it', detail: 'Add each Surface' },
    };

    const result = await captureAll({ submitSeed })['team_seed_submit']!({
      id: completed.id,
      result: 'complete',
      brief,
      conclusion: 'Not now',
    });

    expect(submitSeed).toHaveBeenCalledWith(completed.id, {
      result: 'complete',
      brief,
      conclusion: 'Not now',
    });
    expect(result.structuredContent).toEqual({ seed: completed });
  });
});
