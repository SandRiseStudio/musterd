import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit, reviewRouting } from './audit.js';
import { createTeam } from './teams.js';

/**
 * `reviewRouting`'s read edge (ADR 173 correction #1). The function that motivated ADR 173 violated
 * its clause 1 in its own return type: `routed` abstained, `human_required` beside it did not — it
 * read `false` both for a legacy row predating #462 (the field was never written) and for a
 * `catch`-ed parse failure. "Could not see whether a human was required" was served as "no human was
 * required", and the close edge's ADR 172 counter-metric undercounted over exactly those rows.
 *
 * The write edge was never wrong (`lane.risk.length > 0`, a closed set the writer owns), so these
 * cases are all about what the READ says when the evidence is absent or unreadable.
 */
describe('reviewRouting — human_required abstains rather than asserting a negative (ADR 173)', () => {
  const seed = () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive' });
    return { db, team };
  };
  const ready = (
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    detail: Record<string, unknown> & { lane: string },
  ) =>
    appendAudit(db, teamId, {
      actor: 'ada',
      action: 'lane.ready_for_review',
      target: detail.lane, // the ready edge writes the lane id as the audit target
      result: 'allow',
      detail,
    });

  it('reads a recorded requirement straight through, both ways', () => {
    const { db, team } = seed();
    ready(db, team.id, { lane: 'a', reviewer: 'gee', human_required: true });
    ready(db, team.id, { lane: 'b', reviewer: 'gee', human_required: false });
    expect(reviewRouting(db, team.id, 'a')).toEqual({ routed: true, human_required: true });
    // An explicit false is knowledge, not absence — it must NOT become undefined.
    expect(reviewRouting(db, team.id, 'b')).toEqual({ routed: true, human_required: false });
  });

  it('abstains on a legacy row that predates the field (#462), rather than reading "not required"', () => {
    const { db, team } = seed();
    ready(db, team.id, { lane: 'a', reviewer: 'gee' }); // routed, but human_required never written
    expect(reviewRouting(db, team.id, 'a')).toEqual({ routed: true, human_required: undefined });
  });

  // The `catch` was unreachable and the real behavior was worse than the lane reported: the WHERE
  // clause filtered on `json_extract(detail, '$.lane')`, so SQLite raised "malformed JSON" from the
  // QUERY, before the try — a throw out of the function, not an abstention.
  it('abstains — never throws — when the row exists but its detail will not parse', () => {
    const { db, team } = seed();
    ready(db, team.id, { lane: 'a', reviewer: 'gee', human_required: true });
    db.prepare(`UPDATE audit SET detail = '{not json'`).run();
    expect(() => reviewRouting(db, team.id, 'a')).not.toThrow();
    expect(reviewRouting(db, team.id, 'a')).toEqual({
      routed: undefined,
      human_required: undefined,
    });
  });

  // …and the blast radius was every lane, not just the corrupt one: json_extract was evaluated over
  // every `lane.ready_for_review` row the scan touched, so ONE unparseable row broke the close edge
  // for lanes whose own rows were perfectly fine.
  it('one unparseable row does not poison the lookup for a different, healthy lane', () => {
    const { db, team } = seed();
    ready(db, team.id, { lane: 'bad', reviewer: 'gee' });
    ready(db, team.id, { lane: 'good', reviewer: 'gee', human_required: true });
    db.prepare(`UPDATE audit SET detail = '{not json' WHERE target = 'bad'`).run();
    expect(reviewRouting(db, team.id, 'good')).toEqual({ routed: true, human_required: true });
  });

  it('abstains when there is no ready row at all', () => {
    const { db, team } = seed();
    expect(reviewRouting(db, team.id, 'never-ready')).toEqual({
      routed: undefined,
      human_required: undefined,
    });
  });

  // The post-#450, pre-#462 window is the row shape that makes this more than a type change: it
  // recorded the routing outcome but not the requirement, so it lands on the reason ladder's
  // no-candidate branch with nothing to say about whether a human was owed.
  it('a row with a routing outcome but no requirement abstains on the requirement only', () => {
    const { db, team } = seed();
    ready(db, team.id, { lane: 'a', no_candidate: true });
    expect(reviewRouting(db, team.id, 'a')).toEqual({ routed: false, human_required: undefined });
  });
});
