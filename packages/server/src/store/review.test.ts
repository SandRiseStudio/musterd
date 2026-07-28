import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import { teamFamilyPosture } from './review.js';
import { createTeam } from './teams.js';

/**
 * The team model-family posture (ADR 172) — through-DB, like the rest of store/. The cases that
 * matter are the ones a two-state design would get wrong: one attester is `unknown`, not
 * `monoculture`; a live human never makes an all-claude agent fleet `diverse`; an agent attesting
 * `unknown` is present but proves nothing.
 */

const TIMEOUT = 60_000;

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  return { db, team };
}

function agent(
  db: ReturnType<typeof seed>['db'],
  team: ReturnType<typeof seed>['team'],
  name: string,
  model?: string,
): void {
  const { row } = addMember(db, team, { kind: 'agent', name, role: '' });
  if (model !== undefined) attach(db, row.id, 'claude-code', `conn-${name}`, { model });
}

describe('teamFamilyPosture (ADR 172)', () => {
  it('monoculture: ≥2 live agents attesting, all one family — enrolled-idle seats listed as the remedy', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-fable-5');
    agent(db, team, 'kim', 'claude-opus-5');
    agent(db, team, 'grokbot'); // enrolled, never attached — the wake pool
    agent(db, team, 'gptbot');
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('monoculture');
    expect(p.attesting).toBe(3);
    expect(p.families).toEqual({ claude: 3 });
    expect(p.wake_pool.sort()).toEqual(['gptbot', 'grokbot']);
  });

  it('diverse: one cross-family attester flips it', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'grokbot', 'grok-4.5');
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('diverse');
    expect(p.families).toEqual({ claude: 1, grok: 1 });
  });

  it('unknown, not monoculture, with a single attester — one data point cannot tell', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'grokbot');
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('unknown');
    expect(p.attesting).toBe(1);
  });

  it('a live agent attesting nothing is unattested — present, proves nothing, not in the denominator', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-fable-5');
    const { row } = addMember(db, team, { kind: 'agent', name: 'mist', role: '' });
    attach(db, row.id, 'claude-code', 'conn-mist'); // live, no model
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('monoculture'); // the unknown seat neither proves nor breaks it
    expect(p.attesting).toBe(2);
    expect(p.unattested).toBe(1);
  });

  it('a live human never makes an all-claude agent fleet diverse — counted beside, not inside', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-fable-5');
    const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
    attach(db, row.id, 'cli', 'conn-nick');
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('monoculture');
    expect(p.humans_live).toBe(1);
    expect(p.wake_pool).toEqual([]); // a human is never "wakeable" here
  });

  it('empty team → unknown with zeros, never a throw', () => {
    const { db, team } = seed();
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('unknown');
    expect(p.attesting).toBe(0);
    expect(p.families).toEqual({});
  });
});
