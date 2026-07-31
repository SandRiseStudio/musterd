import { describeFamilyPosture } from '@musterd/protocol';
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
    // ADR 187: idle seats carry what they would bring. Never attested here, so `unknown` — the
    // durable-record cases are covered in their own describe below.
    expect(p.wake_pool.map((c) => c.seat).sort()).toEqual(['gptbot', 'grokbot']);
    expect(p.wake_pool.every((c) => c.family === 'unknown')).toBe(true);
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

/**
 * ADR 187. `presence` holds an attestation only while a seat is live and is reaped when it goes
 * offline, so reading it alone made every idle seat's family `unknown` — which silently emptied the
 * cross-family remedy while the durable `occupancy.model_attested` record knew the answer all along.
 */
describe('the wake pool reads the durable attestation record (ADR 187)', () => {
  /** An agent that attested once and then went away — no presence row survives it. */
  function wentOffline(
    db: ReturnType<typeof seed>['db'],
    team: ReturnType<typeof seed>['team'],
    name: string,
    model: string,
    at: number = Date.now(),
  ): void {
    if (!db.prepare('SELECT 1 FROM members WHERE team_id = ? AND name = ?').get(team.id, name)) {
      addMember(db, team, { kind: 'agent', name, role: '' });
    }
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, NULL, 'occupancy.model_attested', ?, 'allow', ?, ?)`,
    ).run(
      `a-${name}-${String(at)}`,
      team.id,
      at,
      name,
      JSON.stringify({ old: null, new: model, source: 'claim' }),
      at,
    );
  }

  it('an idle seat carries the family it last attested, with the age of that claim', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-opus-5');
    const when = Date.now() - 86_400_000 * 21;
    wentOffline(db, team, 'grokbot', 'grok-4.5', when);

    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('monoculture'); // still — an idle seat never counts as attesting
    expect(p.wake_pool).toEqual([{ seat: 'grokbot', family: 'grok', attested_at: when }]);
  });

  it('newest attestation wins — a seat that switched models is not remembered as its old one', () => {
    const { db, team } = seed();
    const old = Date.now() - 86_400_000 * 30;
    wentOffline(db, team, 'drifter', 'grok-4.5', old);
    wentOffline(db, team, 'drifter', 'claude-opus-5', old + 86_400_000);

    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool).toEqual([
      { seat: 'drifter', family: 'claude', attested_at: old + 86_400_000 },
    ]);
  });

  it('a seat that never attested stays unknown — the record cannot invent one', () => {
    const { db, team } = seed();
    agent(db, team, 'ghost'); // enrolled, never attached, never attested
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool).toEqual([{ seat: 'ghost', family: 'unknown', attested_at: null }]);
  });

  /**
   * The hazard this design must not introduce. A LIVE seat whose current occupancy attested nothing
   * must read `unknown`, NOT whatever it attested last week — otherwise a stale memory could certify
   * a live review as cross-family, and a review whose diversity claim is false is worse than no
   * review at all (ADR 056). The durable record answers "what would waking this seat bring", never
   * "what is this seat running now".
   */
  it('a LIVE seat is never described by its durable record — no stale cross-family claim', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-opus-5');
    // grokbot attested grok long ago, then came back on a session that attests nothing.
    wentOffline(db, team, 'grokbot', 'grok-4.5', Date.now() - 86_400_000 * 21);
    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
      .get('grokbot')!;
    attach(db, row.id, 'claude-code', 'conn-grokbot'); // live, no model

    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.unattested).toBe(1); // present, proves nothing
    expect(p.families).toEqual({ claude: 2 }); // NOT { claude: 2, grok: 1 }
    expect(p.state).toBe('monoculture'); // a stale memory must not read as diversity
    expect(p.wake_pool).toEqual([]); // and it is not idle, so it is not a remedy either
  });

  it('the posture line names the cross-family remedy first, with its age', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-opus-5');
    wentOffline(db, team, 'sleepy', 'claude-opus-5', Date.now() - 3_600_000);
    wentOffline(db, team, 'grokbot', 'grok-4.5', Date.now() - 86_400_000 * 3);

    const line = describeFamilyPosture(teamFamilyPosture(db, team.id, TIMEOUT));
    expect(line).toContain('idle & enrollable: grokbot (grok, 3d ago)');
  });
});

describe('pickReviewCounterpart — risky-lane human requirement (ADR 172)', () => {
  it('never routes a risky lane to an agent, even one whose stale row still carries is_admin', async () => {
    // Admins can only be humans (ADR 172). Reconcile clamps new projections, but a row written
    // before the clamp can still carry is_admin in its capabilities JSON — and the one review that
    // exists to demand a human's judgment must not route to it.
    const { openLane } = await import('./lanes.js');
    const { setMemberGovernance } = await import('./members.js');
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5'); // the worker
    const { row: botty } = addMember(db, team, { kind: 'agent', name: 'botty', role: '' });
    attach(db, botty.id, 'claude-code', 'conn-botty', { model: 'gpt-5.2-codex' });
    setMemberGovernance(db, botty.id, null, JSON.stringify({ is_admin: true })); // the stale shape
    const lane = openLane(db, team.id, 'dawn', 'ada', {
      title: 'prod deploy',
      risk: ['production'],
      claim: true,
    });
    const { pickReviewCounterpart, pickHumanReviewer } = await import('./review.js');
    // ADR 188: botty IS routable — as the stage-one PEER (an intended agent review). What the
    // stale admin bit must never do is satisfy the HUMAN stage: pickHumanReviewer is kind-only.
    expect(pickReviewCounterpart(db, team.id, lane, 'ada', TIMEOUT)).toMatchObject({
      reviewer: 'botty',
      grade: 'cross_family',
    });
    expect(pickHumanReviewer(db, team.id, 'ada', TIMEOUT)).toBeNull();
  });
});

describe('pickReviewCounterpart — graded ladder (ADR 188)', () => {
  async function pick(setup: (h: ReturnType<typeof seed>) => void, risk: string[] = []) {
    const { openLane } = await import('./lanes.js');
    const { pickReviewCounterpart } = await import('./review.js');
    const h = seed();
    agent(h.db, h.team, 'worker', 'claude-opus-5');
    setup(h);
    const lane = openLane(h.db, h.team.id, 'dawn', 'worker', {
      title: 'a change',
      risk,
      claim: true,
    });
    return pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
  }

  it('cross_model is now routable: opus-5 worker, opus-4.8 reviewer', async () => {
    const p = await pick(({ db, team }) => agent(db, team, 'dolly', 'claude-opus-4-8'));
    expect(p).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
  });

  it('cross_family beats cross_model when both are live', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'dolly', 'claude-opus-4-8');
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
    });
    expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('same_model is never routed — two opus-5 seats still find no candidate', async () => {
    expect(await pick(({ db, team }) => agent(db, team, 'twin', 'claude-opus-5'))).toBeNull();
  });

  it('an unattested live seat stays ineligible (null grade is not a grade)', async () => {
    expect(await pick(({ db, team }) => agent(db, team, 'mist'))).toBeNull();
  });

  it('a live human outranks every agent grade and reads grade "human"', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
      attach(db, row.id, 'cli', 'conn-nick');
    });
    expect(p).toMatchObject({ reviewer: 'nick', grade: 'human' });
  });
});
