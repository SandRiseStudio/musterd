import { describe, expect, it } from 'vitest';
import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/open.js';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { routeEnvelope } from './route.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';

const ID = '01M0XINSIGHT0000000000000000';

/** Minimal ctx: the cap guard fires before any persistence, and the happy path only needs a
 *  no-op hub (deliver/broadcastFirehose) beside the db. */
function stubCtx(db: Database): Ctx {
  return {
    db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: {
      deliver: () => false,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
  };
}

/**
 * ADR 327: the insight act's 2048-byte body cap is enforced server-side on the one
 * validate→persist→deliver path (actMetaRules sees only {act, thread, meta}, never body).
 */
describe('insight body cap', () => {
  it('rejects an insight whose body exceeds 2048 bytes', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    const { row: sender } = addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });

    const env = makeEnvelope({
      id: ID,
      team: team.slug,
      from: sender.name,
      to: { kind: 'team' },
      act: 'insight',
      body: 'x'.repeat(2049),
      meta: { headline: 'over the line' },
    });

    expect(() => routeEnvelope(stubCtx(db), team, sender, env)).toThrowError(
      new MusterdError('validation', 'act "insight" body is limited to 2048 bytes'),
    );
  });

  it('accepts an insight at the cap boundary and counts bytes, not chars', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    const { row: sender } = addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });

    // 1024 two-byte chars = 2048 bytes: exactly at the cap, must pass.
    const env = makeEnvelope({
      id: ID,
      team: team.slug,
      from: sender.name,
      to: { kind: 'team' },
      act: 'insight',
      body: 'é'.repeat(1024),
      meta: { headline: 'at the cap' },
    });
    expect(() => routeEnvelope(stubCtx(db), team, sender, env)).not.toThrow();
  });
});
