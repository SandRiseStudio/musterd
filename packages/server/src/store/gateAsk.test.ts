import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { findGateAsk, gateAskHumanAnswer } from './gateAsk.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, nick, ada };
}

/** Insert a gate-ask (species:approve, tier:blocking, meta.gate) as `from`. */
function ask(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  id: string,
  fingerprint: string,
  ts: number,
): void {
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: from.name,
    to: { kind: 'team' },
    act: 'ask',
    body: `approve me`,
    meta: { species: 'approve', tier: 'blocking', gate: { class: 'merge-to-main', fingerprint } },
    ts,
  });
  insertMessage(db, team.id, from.id, null, env);
}

/** Insert an accept/decline naming `askId` via meta.in_reply_to, as `from`. */
function answer(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  act: 'accept' | 'decline',
  id: string,
  askId: string,
  ts: number,
): void {
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: from.name,
    to: { kind: 'member', name: from.name },
    act,
    meta: { in_reply_to: askId },
    ts,
  });
  insertMessage(db, team.id, from.id, from.id, env);
}

describe('findGateAsk (fingerprint dedup anchor)', () => {
  it('finds the gate-ask carrying the fingerprint', () => {
    const { db, team, ada } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    expect(findGateAsk(db, team.id, 'fp-abc')).toMatchObject({ id: 'ask-1' });
  });

  it('returns null when no ask carries the fingerprint', () => {
    const { db, team, ada } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    expect(findGateAsk(db, team.id, 'fp-other')).toBeNull();
  });

  it('returns the newest when the same fingerprint was raised more than once', () => {
    const { db, team, ada } = seed();
    ask(db, team, ada, 'ask-old', 'fp-abc', 1_000);
    ask(db, team, ada, 'ask-new', 'fp-abc', 2_000);
    expect(findGateAsk(db, team.id, 'fp-abc')).toMatchObject({ id: 'ask-new' });
  });

  it('is scoped to the team', () => {
    const { db, team, ada } = seed();
    const other = createTeam(db, { slug: 'other' });
    const otherAgent = addMember(db, other, { name: 'zed', kind: 'agent' }).row;
    ask(db, other, otherAgent, 'ask-x', 'fp-abc', 1_000);
    expect(findGateAsk(db, team.id, 'fp-abc')).toBeNull();
  });
});

describe('gateAskHumanAnswer (human-only release signal)', () => {
  it('returns a human accept naming the ask', () => {
    const { db, team, ada, nick } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    answer(db, team, nick, 'accept', 'ans-1', 'ask-1', 2_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({ act: 'accept', by: 'nick' });
  });

  it('returns a human decline naming the ask', () => {
    const { db, team, ada, nick } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    answer(db, team, nick, 'decline', 'ans-1', 'ask-1', 2_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({ act: 'decline', by: 'nick' });
  });

  it('ignores an AGENT accept — only a human releases the gate', () => {
    const { db, team, ada } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    answer(db, team, ada, 'accept', 'ans-1', 'ask-1', 2_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
  });

  it('ignores an answer naming a different ask', () => {
    const { db, team, ada, nick } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    answer(db, team, nick, 'accept', 'ans-1', 'ask-OTHER', 2_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
  });

  it('takes the earliest answer when both a decline and a later accept exist', () => {
    const { db, team, ada, nick } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    answer(db, team, nick, 'decline', 'ans-decline', 'ask-1', 2_000);
    answer(db, team, nick, 'accept', 'ans-accept', 'ask-1', 3_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({ act: 'decline', by: 'nick' });
  });

  it('returns null when the ask is unanswered', () => {
    const { db, team, ada } = seed();
    ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
    expect(gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
  });
});
