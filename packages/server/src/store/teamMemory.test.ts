import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { routeEnvelope } from '../protocol/route.js';
import { addMember } from './members.js';
import { ftsQuery, rebuildInsightsFts, searchInsights } from './teamMemory.js';
import { createTeam } from './teams.js';

const ID = '01M0XINSIGHTTEST00000000000A';

/** Persist an insight through the real validate→persist→deliver path so triggers fire. */
function saveInsight(
  db: Database,
  ctx: Ctx,
  team: ReturnType<typeof createTeam>,
  headline: string,
  body: string,
) {
  const { row: sender } = addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });
  routeEnvelope(
    ctx,
    team,
    sender,
    makeEnvelope({
      id: ID + headline.slice(0, 4),
      team: team.slug,
      from: sender.name,
      to: { kind: 'team' },
      act: 'insight',
      body,
      meta: { headline, tags: ['daemon'] },
    }),
  );
}

function stubCtx(db: Database): Ctx {
  return {
    db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

describe('team memory fold (ADR 327)', () => {
  it('finds an insight saved through the real route path', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    saveInsight(
      db,
      stubCtx(db),
      team,
      'service install needs node >= 22',
      'the daemon crashloops from node 20',
    );

    const hits = searchInsights(db, team.id, 'crashloops');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      from: 'ghost',
      headline: 'service install needs node >= 22',
      tags: ['daemon'],
    });
  });

  it('is team-scoped', () => {
    const db = openDb(':memory:');
    const dawn = createTeam(db, { slug: 'dawn' });
    const dusk = createTeam(db, { slug: 'dusk' });
    const ctx = stubCtx(db);
    saveInsight(db, ctx, dawn, 'wake leases are host-local', 'never replicated across machines');

    expect(searchInsights(db, dusk.id, 'replicated')).toHaveLength(0);
    expect(searchInsights(db, dawn.id, 'replicated')).toHaveLength(1);
  });

  it('rebuilds the fold from the log alone (the cache property)', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    saveInsight(
      db,
      stubCtx(db),
      team,
      'perf harness leaks chrome',
      'headless chrome processes outlive runs',
    );

    db.exec('DELETE FROM insights_fts');
    expect(searchInsights(db, team.id, 'chrome')).toHaveLength(0);

    expect(rebuildInsightsFts(db)).toBe(1);
    expect(searchInsights(db, team.id, 'chrome')).toHaveLength(1);
  });

  it('sanitizes user query text into quoted FTS terms', () => {
    expect(ftsQuery('  daemon   "install" node22 ')).toBe('"daemon" """install""" "node22"');
    expect(ftsQuery('')).toBe('');
  });
});
