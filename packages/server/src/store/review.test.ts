import { describeFamilyPosture } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import { enrollResidency } from './residency.js';
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
    // ADR 189: never enrolled in these fixtures → marked, not filtered.
    expect(p.wake_pool.every((c) => c.wakeability === 'not_enrolled')).toBe(true);
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

  it('a service seat is invisible to the posture: not unattested, never in the wake pool (ADR 232)', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-fable-5');
    const { row } = addMember(db, team, { kind: 'service', name: 'autorefresh', role: '' });
    attach(db, row.id, 'cli', 'conn-autorefresh'); // live, attests no model — correctly
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.state).toBe('monoculture');
    expect(p.unattested).toBe(0); // NOT an evidence hole — services attest none, by design
    expect(p.wake_pool.map((c) => c.seat)).not.toContain('autorefresh');
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
    expect(p.wake_pool).toEqual([
      { seat: 'grokbot', family: 'grok', attested_at: when, wakeability: 'not_enrolled' },
    ]);
  });

  it('newest attestation wins — a seat that switched models is not remembered as its old one', () => {
    const { db, team } = seed();
    const old = Date.now() - 86_400_000 * 30;
    wentOffline(db, team, 'drifter', 'grok-4.5', old);
    wentOffline(db, team, 'drifter', 'claude-opus-5', old + 86_400_000);

    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool).toEqual([
      {
        seat: 'drifter',
        family: 'claude',
        attested_at: old + 86_400_000,
        wakeability: 'not_enrolled',
      },
    ]);
  });

  /**
   * ADR 219. The wake pool is everyone presence calls offline — but presence lapses for
   * reasons other than going away. A seat whose audit trail shows it acting seconds ago is not
   * idle; it is mid-something with a stale heartbeat, and waking it buys a duplicate, not a
   * remedy. Marked, never filtered: the seat stays in the pool so the diversity gap is still
   * named, exactly as ADR 189 does for unenrolled seats.
   */
  describe('quiescence marks a busy seat unspendable (ADR 219)', () => {
    const acted = (
      db: ReturnType<typeof seed>['db'],
      team: { id: string },
      actor: string,
      at: number,
    ) =>
      db
        .prepare(
          `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
           VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
        )
        .run(`aud-${actor}-${String(at)}`, team.id, actor, at, at);

    it('an enrolled seat acting seconds ago is enrolled_seat_busy, and stays in the pool', () => {
      const { db, team } = seed();
      agent(db, team, 'grokbot');
      const row = db
        .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
        .get('grokbot')!;
      enrollResidency(db, team.id, {
        member_id: row.id,
        harness: 'claude-code',
        host: 'h',
        grant_id: null,
        authorized_by: null,
      });
      acted(db, team, 'grokbot', Date.now() - 5_000);
      const p = teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool.map((c) => c.seat)).toEqual(['grokbot']); // marked, NOT filtered
      expect(p.wake_pool[0]?.wakeability).toBe('enrolled_seat_busy');
    });

    it('the same seat quiet past the line is wakeable again — the mark is transient', () => {
      const { db, team } = seed();
      agent(db, team, 'grokbot');
      const row = db
        .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
        .get('grokbot')!;
      enrollResidency(db, team.id, {
        member_id: row.id,
        harness: 'claude-code',
        host: 'h',
        grant_id: null,
        authorized_by: null,
      });
      acted(db, team, 'grokbot', Date.now() - 10 * 60_000);
      expect(teamFamilyPosture(db, team.id, TIMEOUT).wake_pool[0]?.wakeability).toBe('wakeable');
    });

    it('no audited action leaves the seat exactly as it read before the fact existed', () => {
      const { db, team } = seed();
      agent(db, team, 'grokbot');
      const row = db
        .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
        .get('grokbot')!;
      enrollResidency(db, team.id, {
        member_id: row.id,
        harness: 'claude-code',
        host: 'h',
        grant_id: null,
        authorized_by: null,
      });
      // unknown → omit the fact (ADR 169/189). Never "quiet by absence of evidence".
      expect(teamFamilyPosture(db, team.id, TIMEOUT).wake_pool[0]?.wakeability).toBe('wakeable');
    });

    it('a reachability defect outranks busy — the operator gets the actionable reason', () => {
      const { db, team } = seed();
      agent(db, team, 'grokbot'); // never enrolled
      acted(db, team, 'grokbot', Date.now() - 5_000);
      expect(teamFamilyPosture(db, team.id, TIMEOUT).wake_pool[0]?.wakeability).toBe(
        'not_enrolled',
      );
    });
  });

  it('a seat that never attested stays unknown — the record cannot invent one', () => {
    const { db, team } = seed();
    agent(db, team, 'ghost'); // enrolled, never attached, never attested
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool).toEqual([
      { seat: 'ghost', family: 'unknown', attested_at: null, wakeability: 'not_enrolled' },
    ]);
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
    expect(line).toContain('idle: grokbot (grok, 3d ago, not_enrolled)');
  });

  it('an enrolled idle seat is marked wakeable — mark-not-filter, never filter (ADR 189)', () => {
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    agent(db, team, 'lin', 'claude-opus-5');
    const when = Date.now() - 86_400_000 * 3;
    wentOffline(db, team, 'grokbot', 'grok-4.5', when);
    wentOffline(db, team, 'compo', 'composer-2', when);
    const grok = db
      .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
      .get('grokbot')!;
    enrollResidency(db, team.id, {
      member_id: grok.id,
      harness: 'claude-code',
      host: 'mac.lan',
      grant_id: 'g1',
      authorized_by: 'nick',
    });

    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool).toEqual(
      expect.arrayContaining([
        { seat: 'grokbot', family: 'grok', attested_at: when, wakeability: 'wakeable' },
        { seat: 'compo', family: 'composer', attested_at: when, wakeability: 'not_enrolled' },
      ]),
    );
    // Both stay in the pool — mark, don't filter.
    expect(p.wake_pool.map((c) => c.seat).sort()).toEqual(['compo', 'grokbot']);
    const line = describeFamilyPosture(p);
    // Wakeable cross-family wins the first slot over not_enrolled cross-family.
    expect(line).toMatch(/idle: grokbot \(grok, 3d ago\)/);
    expect(line).toContain('compo (composer, 3d ago, not_enrolled)');
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

  it('a live human is never picked on a non-risky lane — the cross-family agent is (ADR 253)', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
      attach(db, row.id, 'cli', 'conn-nick');
    });
    expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('a live human alone is not a candidate on a non-risky lane (ADR 253)', async () => {
    expect(
      await pick(({ db, team }) => {
        const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
        attach(db, row.id, 'cli', 'conn-nick');
      }),
    ).toBeNull();
  });
});

describe('selectReviewCounterpart — decision-time audit snapshot (ADR 303)', () => {
  it('records the selected grade and a bounded reason for every rejected seat', async () => {
    const { openLane } = await import('./lanes.js');
    const { selectReviewCounterpart } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'cross-model', 'claude-opus-4-8');
    agent(db, team, 'winner', 'gpt-5.6-sol');
    agent(db, team, 'twin', 'claude-opus-5');
    const { row: unknown } = addMember(db, team, { kind: 'agent', name: 'unknown', role: '' });
    attach(db, unknown.id, 'cli', 'conn-unknown'); // live but deliberately without a model attestation
    agent(db, team, 'busy', 'grok-4.5');
    const { row: service } = addMember(db, team, {
      kind: 'service',
      name: 'autorefresh',
      role: '',
    });
    attach(db, service.id, 'cli', 'conn-autorefresh', { model: 'gpt-5.6-sol' });
    const { row: observer } = addMember(db, team, {
      kind: 'human',
      name: 'watcher',
      role: '',
      observer: true,
    });
    attach(db, observer.id, 'cli', 'conn-watcher');
    const { row: offline } = addMember(db, team, { kind: 'agent', name: 'offline', role: '' });
    // `offline` intentionally has no Presence.
    expect(offline.name).toBe('offline');
    db.prepare(
      `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
         VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
    ).run('aud-busy', team.id, 'busy', Date.now() - 5_000, Date.now() - 5_000);
    const lane = openLane(db, team.id, 'dawn', 'worker', { title: 'a change', claim: true });

    expect(selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)).toMatchObject({
      pick: expect.objectContaining({ reviewer: 'winner', grade: 'cross_family' }),
      snapshot: {
        selected: { reviewer: 'winner', grade: 'cross_family' },
        candidates: expect.arrayContaining([
          { member: 'worker', family: 'claude', eligible: false, exclusion: 'self' },
          {
            member: 'autorefresh',
            family: 'gpt',
            eligible: false,
            exclusion: 'service_or_observer',
          },
          { member: 'watcher', family: 'human', eligible: false, exclusion: 'service_or_observer' },
          { member: 'offline', family: 'unknown', eligible: false, exclusion: 'no_live_presence' },
          { member: 'busy', family: 'grok', eligible: false, exclusion: 'busy' },
          { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
          { member: 'twin', family: 'claude', eligible: false, exclusion: 'same_model' },
          { member: 'cross-model', family: 'claude', eligible: false, exclusion: 'lower_grade' },
          { member: 'winner', family: 'gpt', eligible: true, grade: 'cross_family' },
        ]),
      },
    });
  });

  // An ungradeable WORKER is not an absent candidate set. Before this, `reviewGrade` returned null
  // for every candidate when the worker's live occupancy attested nothing, and the picker filed each
  // of those nulls as the CANDIDATE's `unknown_grade` — so one unattested asker knocked out every
  // eligible reviewer, and the row read as "the team had nobody" (10 of 129 no_candidate rows,
  // measured 2026-09-01: worker unattested in all 10, every excluded candidate a known family).
  //
  // ADR 351 (2026-09-02): an unattested worker now ROUTES, at the bottom rung `ungraded`. The
  // pairing proves nothing about diversity and says so — the grade is not one of ADR 188's three,
  // the route is its own value so the ADR 260 eval keeps it out of `liveRouted`, and the close edge
  // abstains (`review_grade_unknown`). An ungraded review beats no review; a false grade beats neither.
  it('an unattested worker routes to a live attested reviewer at the `ungraded` rung (ADR 351)', async () => {
    const { openLane } = await import('./lanes.js');
    const { selectReviewCounterpart } = await import('./review.js');
    const { db, team } = seed();
    const { row: worker } = addMember(db, team, { kind: 'agent', name: 'worker', role: '' });
    attach(db, worker.id, 'cli', 'conn-worker'); // live, attests nothing (the bare-CLI-claim shape)
    agent(db, team, 'gptbot', 'gpt-5.6-sol'); // live, attested — would be cross_family if we knew
    agent(db, team, 'dolly', 'claude-opus-4-8'); // live, attested — could be cross_model or same
    const { row: unknown } = addMember(db, team, { kind: 'agent', name: 'unknown', role: '' });
    attach(db, unknown.id, 'cli', 'conn-unknown'); // a candidate that is itself unattested

    const lane = openLane(db, team.id, 'dawn', 'worker', { title: 'a change', claim: true });
    const selection = selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
    // Roster order among equals: gptbot was added first. No rung above `ungraded` is claimable
    // because nothing can be graded against an unknown worker — gptbot's gpt family is NOT a
    // cross_family claim here, and the pick must not say it is.
    expect(selection.pick).toMatchObject({
      reviewer: 'gptbot',
      route: 'ungraded',
      grade: 'ungraded',
      reviewer_family: 'gpt',
    });
    expect(selection.snapshot).toMatchObject({
      selected: { reviewer: 'gptbot', grade: 'ungraded' },
      worker_family: 'unknown',
      candidates: expect.arrayContaining([
        { member: 'worker', family: 'unknown', eligible: false, exclusion: 'self' },
        { member: 'gptbot', family: 'gpt', eligible: true, grade: 'ungraded' },
        { member: 'dolly', family: 'claude', eligible: false, exclusion: 'tie_break' },
        // A candidate that attests nothing is still its own `unknown_grade` — never routed, at
        // any rung: two unknowns prove even less than one.
        { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
      ]),
    });
    // The attested snapshot names the worker's family too, so a reader need not join the close row.
    const attested = selectReviewCounterpart(db, team.id, lane, 'gptbot', TIMEOUT);
    expect(attested.snapshot.worker_family).toBe('gpt');
  });

  it('`ungraded` is a bottom rung, never a substitute: an attested worker still grades every candidate (ADR 351)', async () => {
    const { openLane } = await import('./lanes.js');
    const { selectReviewCounterpart } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'twin', 'claude-opus-5'); // same_model — must stay excluded, not fall to ungraded
    const { row: unknown } = addMember(db, team, { kind: 'agent', name: 'unknown', role: '' });
    attach(db, unknown.id, 'cli', 'conn-unknown');
    const lane = openLane(db, team.id, 'dawn', 'worker', { title: 'a change', claim: true });
    const selection = selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
    expect(selection.pick).toBeNull();
    expect(selection.snapshot.candidates).toEqual(
      expect.arrayContaining([
        { member: 'twin', family: 'claude', eligible: false, exclusion: 'same_model' },
        { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
      ]),
    );
  });
});

describe('pickReviewCounterpart — drops busy live agents (quiet-set inc 1)', () => {
  const acted = (
    db: ReturnType<typeof seed>['db'],
    team: { id: string },
    actor: string,
    agoMs: number,
  ) =>
    db
      .prepare(
        `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
         VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
      )
      .run(`aud-${actor}-${String(agoMs)}`, team.id, actor, Date.now() - agoMs, Date.now() - agoMs);

  async function pick(setup: (h: ReturnType<typeof seed>) => void) {
    const { openLane } = await import('./lanes.js');
    const { pickReviewCounterpart } = await import('./review.js');
    const h = seed();
    agent(h.db, h.team, 'worker', 'claude-opus-5');
    setup(h);
    const lane = openLane(h.db, h.team.id, 'dawn', 'worker', {
      title: 'a change',
      claim: true,
    });
    return pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
  }

  it('a live busy cross-family seat loses to a quiet cross-model seat', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      agent(db, team, 'dolly', 'claude-opus-4-8');
      acted(db, team, 'gptbot', 5_000); // busy
      acted(db, team, 'dolly', 180_000); // quiet (≥ 120s)
    });
    expect(p).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
  });

  it('a team of only-busy live agents finds no live candidate (wake / no_candidate is the caller)', async () => {
    const p = await pick(({ db, team }) => {
      agent(db, team, 'gptbot', 'gpt-5.6-sol');
      acted(db, team, 'gptbot', 5_000);
    });
    expect(p).toBeNull();
  });

  it('unknown (no work audit) stays eligible — occupancy attestation is not work', async () => {
    // agent() calls attach(), which writes occupancy.model_attested as actor=name at now.
    // If the picker treats that as work, this is null and every ladder test above breaks.
    const p = await pick(({ db, team }) => agent(db, team, 'gptbot', 'gpt-5.6-sol'));
    expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
  });

  it('pickHumanReviewer still returns a live human who acted seconds ago', async () => {
    const { pickHumanReviewer } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'ada', 'claude-opus-5');
    const { row } = addMember(db, team, { kind: 'human', name: 'nick', role: '' });
    attach(db, row.id, 'cli', 'conn-nick');
    acted(db, team, 'nick', 5_000);
    expect(pickHumanReviewer(db, team.id, 'ada', TIMEOUT)).toMatchObject({
      reviewer: 'nick',
      grade: 'human',
    });
  });
});

describe('pickWakeReviewer (ADR 191)', () => {
  function wentOffline(
    db: ReturnType<typeof seed>['db'],
    team: ReturnType<typeof seed>['team'],
    name: string,
    model: string,
    enrolled = true,
  ): void {
    const { row } = addMember(db, team, { kind: 'agent', name, role: '' });
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, NULL, 'occupancy.model_attested', ?, 'allow', ?, ?)`,
    ).run(
      `a-${name}`,
      team.id,
      Date.now() - 3_600_000,
      name,
      JSON.stringify({ old: null, new: model, source: 'claim' }),
      Date.now() - 3_600_000,
    );
    if (enrolled) {
      enrollResidency(db, team.id, {
        member_id: row.id,
        harness: 'claude-code',
        host: 'h',
        grant_id: 'g',
        authorized_by: 'nick',
      });
    }
  }

  it('picks a wakeable cross_family idle seat over a wakeable cross_model one', async () => {
    const { pickWakeReviewer } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    wentOffline(db, team, 'dolly', 'claude-opus-4-8');
    wentOffline(db, team, 'gptbot', 'gpt-5.6-sol');
    const posture = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(pickWakeReviewer(db, team.id, 'worker', posture)).toMatchObject({
      reviewer: 'gptbot',
      grade: 'cross_family',
    });
  });

  it('skips not_enrolled seats even when they would restore family diversity', async () => {
    const { pickWakeReviewer } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    agent(db, team, 'twin', 'claude-opus-5'); // monoculture live
    wentOffline(db, team, 'grokbot', 'grok-4.5', false);
    const posture = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(pickWakeReviewer(db, team.id, 'worker', posture)).toBeNull();
  });

  it('never routes same_model from the wake pool', async () => {
    const { pickWakeReviewer } = await import('./review.js');
    const { db, team } = seed();
    agent(db, team, 'worker', 'claude-opus-5');
    wentOffline(db, team, 'twin', 'claude-opus-5');
    const posture = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(pickWakeReviewer(db, team.id, 'worker', posture)).toBeNull();
  });
});

describe('reviewLoopBounceCount (ADR 191)', () => {
  it('counts prior ready_for_review audit rows for the lane', async () => {
    const { reviewLoopBounceCount, REVIEW_LOOP_BREAKER_N } = await import('./review.js');
    const { appendAudit } = await import('./audit.js');
    const { db, team } = seed();
    expect(REVIEW_LOOP_BREAKER_N).toBe(3);
    expect(reviewLoopBounceCount(db, team.id, 'lane-1')).toBe(0);
    appendAudit(db, team.id, {
      actor: 'ada',
      action: 'lane.ready_for_review',
      target: 'lane-1',
      result: 'allow',
      detail: { lane: 'lane-1' },
    });
    appendAudit(db, team.id, {
      actor: 'ada',
      action: 'lane.ready_for_review',
      target: 'lane-1',
      result: 'allow',
      detail: { lane: 'lane-1' },
    });
    expect(reviewLoopBounceCount(db, team.id, 'lane-1')).toBe(2);
    expect(reviewLoopBounceCount(db, team.id, 'other')).toBe(0);
  });
});
