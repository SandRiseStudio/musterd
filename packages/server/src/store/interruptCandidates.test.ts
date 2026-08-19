import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { rowsToEnvelopes } from './hydrate.js';
import { listInterruptCandidates } from './interruptCandidates.js';
import { addMember } from './members.js';
import { insertMessage, listInbox, pendingInterrupts } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

/**
 * `/inbox/interrupt-check` is the most frequently served route in the system — a PostToolUse hook
 * calls it at every tool boundary of every live agent — and it read the seat's ENTIRE unread window to
 * answer a question whose answer is almost always "nothing". After #909 the cost is no longer the
 * hydration but the query itself: `SELECT *` marshalling 6000 rows into JS costs 10.7ms, against
 * 0.7ms to hydrate them and 0.4ms to fold them.
 *
 * `pendingInterrupts` can only ever USE a few shapes, so the window can be narrowed in SQL to exactly
 * those and the fold left untouched:
 *
 *   - what it can RETURN — `meta.urgent`, `steer`, or an obligation (`ask` + `meta.lane_review`);
 *   - what can SUPPRESS one — `resolve` (closes a thread), `accept`/`decline` (discharge by
 *     `meta.in_reply_to`);
 *   - what can REDIRECT one — `meta.eligible`, which replaces the default obligation rule.
 *
 * Everything else in the window is inert. The risk in narrowing a fold's input is that a shape you
 * forgot changes the answer, so the test that matters is equivalence against the unnarrowed read over
 * a corpus that contains every one of those shapes — not a demonstration that the fast path is fast.
 */
function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
  return { db, team, nick, ada, bob };
}

let ts = 1_000;
function say(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  to: MemberRow | null,
  act: string,
  id: string,
  opts: { meta?: Record<string, unknown>; thread?: string } = {},
) {
  insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act: act as 'message',
      body: 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts: ts++,
    }),
  );
}

/** The unnarrowed read the route used to do — the reference answer. */
function viaWholeWindow(
  db: Database,
  team: TeamRow,
  member: MemberRow,
  obligations: boolean,
): string[] {
  const rows = listInbox(db, member, { unreadOnly: true, cursorTs: 0 });
  return pendingInterrupts(rowsToEnvelopes(db, team.slug, rows), member.name, { obligations }).map(
    (e) => e.id,
  );
}

function viaCandidates(
  db: Database,
  team: TeamRow,
  member: MemberRow,
  obligations: boolean,
): string[] {
  const rows = listInterruptCandidates(db, member, { cursorTs: 0 });
  return pendingInterrupts(rowsToEnvelopes(db, team.slug, rows), member.name, { obligations }).map(
    (e) => e.id,
  );
}

/** Every shape the fold can read, plus a lot of noise that it cannot. */
function corpus() {
  const s = seed();
  const { db, team, nick, ada, bob } = s;
  // Inert bulk: the overwhelming majority of a real window.
  for (let i = 0; i < 200; i++) say(db, team, nick, null, 'status_update', `noise${i}`);
  for (let i = 0; i < 50; i++) say(db, team, bob, ada, 'message', `chat${i}`);

  // Urgent directed act — raises.
  say(db, team, nick, ada, 'message', 'urgent-live', {
    meta: { urgent: true, urgent_reason: 'r' },
  });
  // Urgent directed act whose thread is later resolved — must NOT raise.
  say(db, team, nick, ada, 'message', 'urgent-closed', {
    meta: { urgent: true, urgent_reason: 'r' },
    thread: 'T1',
  });
  say(db, team, nick, null, 'resolve', 'res-1', { thread: 'T1' });
  // Urgent act addressed to someone else — never mine.
  say(db, team, nick, bob, 'message', 'urgent-not-mine', {
    meta: { urgent: true, urgent_reason: 'r' },
  });

  // Steer supersession: only the newest directed steer survives.
  say(db, team, nick, ada, 'steer', 'steer-old');
  say(db, team, nick, ada, 'steer', 'steer-new');

  // Eligible-set act, discharged by an accept naming it — must NOT raise.
  say(db, team, nick, null, 'request_help', 'help-taken', {
    meta: { urgent: true, urgent_reason: 'r', eligible: ['Ada', 'bob'] },
  });
  say(db, team, bob, null, 'accept', 'acc-1', { meta: { in_reply_to: 'help-taken' } });
  // Eligible-set act still open — raises.
  say(db, team, nick, null, 'request_help', 'help-open', {
    meta: { urgent: true, urgent_reason: 'r', eligible: ['Ada', 'bob'] },
  });
  // Eligible set that does not name me.
  say(db, team, nick, null, 'request_help', 'help-not-mine', {
    meta: { urgent: true, urgent_reason: 'r', eligible: ['bob', 'nick'] },
  });

  // Obligation class: a routed acceptance, admitted only when obligations:true.
  say(db, team, nick, ada, 'ask', 'oblig-1', {
    meta: { species: 'approve', tier: 'standard', lane_review: { lane: 'L1' } },
  });
  // A plain directed ask must never raise the line.
  say(db, team, nick, ada, 'ask', 'plain-ask', { meta: { species: 'consult', tier: 'advisory' } });
  return s;
}

describe('listInterruptCandidates', () => {
  it('gives pendingInterrupts the same answer as reading the whole window', () => {
    const { db, team, ada } = corpus();
    for (const obligations of [true, false]) {
      expect(viaCandidates(db, team, ada, obligations)).toEqual(
        viaWholeWindow(db, team, ada, obligations),
      );
    }
  });

  it('finds the answer the corpus was built to produce, so the equivalence is not two empty lists', () => {
    const { db, team, ada } = corpus();
    expect(viaCandidates(db, team, ada, true)).toEqual(
      expect.arrayContaining(['urgent-live', 'steer-new', 'help-open', 'oblig-1']),
    );
    expect(viaCandidates(db, team, ada, true)).not.toEqual(
      expect.arrayContaining(['urgent-closed', 'steer-old', 'help-taken', 'plain-ask']),
    );
  });

  it('reads only the shapes the fold can use, not the window', () => {
    const { db, ada } = corpus();
    const whole = listInbox(db, ada, { unreadOnly: true, cursorTs: 0 });
    const candidates = listInterruptCandidates(db, ada, { cursorTs: 0 });
    expect(whole.length).toBeGreaterThan(250);
    // The handful of acts above, not the 250 inert rows they are buried in.
    expect(candidates.length).toBeLessThan(20);
  });
});
