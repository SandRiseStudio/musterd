import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { listLanes } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { createTeam, setPolicy } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { ingestTeamSeeds, seedToLane, type RelaySeed } from './ingest.js';

function relaySeed(overrides: Partial<RelaySeed> = {}): RelaySeed {
  return {
    id: '00001785979000000-aaaa',
    body: 'try a seeds relay',
    ts: 1_785_979_000_000,
    source: 'sms',
    ...overrides,
  };
}

describe('seedToLane (light cleanup only)', () => {
  it('title is the first non-empty line, collapsed; detail keeps the raw body verbatim plus provenance', () => {
    const seed = relaySeed({ body: '\n  office   dog should\tbark \nmore context\nhere' });
    const { title, detail } = seedToLane(seed);
    expect(title).toBe('office dog should bark');
    // The raw body survives untouched — cleanup must never rewrite what was said.
    expect(detail).toContain('office   dog should\tbark \nmore context\nhere');
    expect(detail).toContain('seed via sms');
    expect(detail).toContain(seed.id);
  });

  it('truncates a long first line at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(40).trim();
    const { title } = seedToLane(relaySeed({ body: long }));
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('word wor…'); // cut on the space, not mid-word
  });
});

describe('ingestTeamSeeds (through the DB)', () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(() => {
    db = openDb(':memory:');
    ctx = { db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function seedTeam(withPolicy = true) {
    const team = createTeam(db, { slug: 'bravo' });
    addMember(db, team, { name: 'nick', kind: 'human' });
    addMember(db, team, { name: 'stanley', kind: 'agent' });
    if (withPolicy) {
      setPolicy(db, team.id, {
        seeds_relay_url: 'https://relay.example',
        seeds_relay_token: 'tok',
      });
    }
    return team;
  }

  function mockRelay(batches: RelaySeed[][]) {
    let call = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const seeds = batches[Math.min(call, batches.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(new Response(JSON.stringify({ seeds }), { status: 200 }));
    });
  }

  it('opens one unowned open lane per seed, attributed to the human, and advances the cursor', async () => {
    const team = seedTeam();
    const fetchSpy = mockRelay([
      [
        relaySeed({ id: '00001-a', body: 'first idea' }),
        relaySeed({ id: '00002-b', body: 'second idea', source: 'slack' }),
      ],
      [],
    ]);

    expect(await ingestTeamSeeds(ctx, team)).toBe(2);
    const lanes = listLanes(db, team.id, team.slug);
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lane.state).toBe('open');
      expect(lane.owner_seat).toBeNull();
      expect(lane.created_by).toBe('nick');
      expect(lane.stakes).toBe('normal');
    }

    // Second pass: the daemon presents its cursor and the relay's empty answer opens nothing —
    // the second consumer's case (a re-pull after a crash/restart) instantiated, not assumed.
    expect(await ingestTeamSeeds(ctx, team)).toBe(0);
    expect(listLanes(db, team.id, team.slug)).toHaveLength(2);
    const secondUrl = new URL(String(fetchSpy.mock.calls[1]![0]));
    expect(secondUrl.searchParams.get('after')).toBe('00002-b');
  });

  it('does nothing when policy has no relay configured — no outbound call ever', async () => {
    const team = seedTeam(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await ingestTeamSeeds(ctx, team)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records seed.ingested in the audit ledger (observability, never the cursor)', async () => {
    const team = seedTeam();
    mockRelay([[relaySeed({ id: '00003-c', body: 'audited idea' })], []]);
    await ingestTeamSeeds(ctx, team);
    const rows = db
      .prepare<
        [string],
        { action: string; detail: string }
      >("SELECT action, detail FROM audit WHERE team_id = ? AND action = 'seed.ingested'")
      .all(team.id);
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail) as { seed_id: string; source: string };
    expect(detail.seed_id).toBe('00003-c');
    expect(detail.source).toBe('sms');
  });

  it('a relay failure opens nothing and leaves the cursor where it was', async () => {
    const team = seedTeam();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(ingestTeamSeeds(ctx, team)).rejects.toThrow('relay responded 500');
    expect(listLanes(db, team.id, team.slug)).toHaveLength(0);
  });
});
