import type { Seed } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { seedLaneHref, seedResultSections, traySeeds } from './SeedsTray';

const base: Seed = {
  id: 'active',
  team: 'revive',
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
};

describe('SeedsTray projection', () => {
  it('shares the protocol active-tray rule and reveals promoted Seeds only in history', () => {
    const promoted = { ...base, id: 'promoted', state: 'promoted' as const, linked_lane_id: 'L 1' };
    expect(traySeeds([base, promoted], false).map((seed) => seed.id)).toEqual(['active']);
    expect(traySeeds([base, promoted], true).map((seed) => seed.id)).toEqual([
      'active',
      'promoted',
    ]);
  });

  it('links promoted history to the ordinary focused Lane view', () => {
    expect(seedLaneHref('L 1', 'revive')).toBe('/live?team=revive&lane=L%201');
  });

  it('projects the complete structured result for Seed history', () => {
    const finalBrief = {
      problem: 'Ideas become Lanes too early',
      context: 'The Team needs a shared pre-Lane space',
      external_evidence: ['Relay captures are durable'],
      approaches: [{ approach: 'Shared tray', tradeoffs: 'Adds one Surface' }],
      constraints: ['Keep the web read-only'],
      risks: ['Tray overload'],
      unknowns: ['Three-day window fit'],
      recommendation: 'Ship the tray',
      proposed_lane: { title: 'Shared Seeds', detail: 'Add thin clients' },
    };

    expect(seedResultSections({ ...base, final_brief: finalBrief })).toEqual([
      { label: 'Problem', body: 'Ideas become Lanes too early' },
      { label: 'Context', body: 'The Team needs a shared pre-Lane space' },
      { label: 'Evidence', body: 'Relay captures are durable' },
      { label: 'Approach', body: 'Shared tray — Adds one Surface' },
      { label: 'Constraints', body: 'Keep the web read-only' },
      { label: 'Risks', body: 'Tray overload' },
      { label: 'Unknowns', body: 'Three-day window fit' },
      { label: 'Recommendation', body: 'Ship the tray' },
      { label: 'Proposed Lane', body: 'Shared Seeds — Add thin clients' },
    ]);
  });
});
