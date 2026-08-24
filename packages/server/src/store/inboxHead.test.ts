import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { insertMessage, listInbox } from './messages.js';
import { createTeam } from './teams.js';

/**
 * `/inbox` accepts `?limit=` but has no DEFAULT, so a seat returning after time away reads its whole
 * unread history in one response — the last unbounded read on the request path (p99 116ms at 24k
 * unread, against a 100ms bar).
 *
 * The obvious fix is the dangerous one. `limit` takes the NEWEST n (`DESC + LIMIT`, then re-sorted),
 * which is right for "show me the recent tail" and catastrophic as a default: a seat with 5000 unread
 * would be handed the newest 200, and a client that then advanced its cursor to the newest message it
 * received would step over the other 4800 forever. That is precisely the loss ADR 287 exists to
 * prevent, and a latency fix has no business introducing it.
 *
 * So a default cap must truncate to a PREFIX — the OLDEST n — because a prefix of what the caller
 * would otherwise have received is the only truncation where advancing the cursor to the last row
 * seen cannot skip anything. Catching up then takes several reads and reaches every message in order.
 *
 * `headLimit` is that read. It is deliberately a separate option from `limit` rather than a flag on
 * it: they answer opposite questions, and collapsing them would leave the dangerous one as the
 * default spelling.
 */
function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  for (let i = 0; i < 50; i++) {
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: `m${String(i).padStart(2, '0')}`,
        team: team.slug,
        from: 'nick',
        to: { kind: 'member', name: 'Ada' },
        act: 'message',
        body: 'x',
        thread: null,
        meta: null,
        ts: 1_000 + i,
      }),
    );
  }
  return { db, team, ada };
}

describe('listInbox headLimit — a bounded read that cannot skip a message', () => {
  it('takes the OLDEST n, so the response is a prefix of the unbounded read', () => {
    const { db, ada } = seed();
    const all = listInbox(db, ada, { unreadOnly: true, cursorTs: 0 }).map((r) => r.id);
    const head = listInbox(db, ada, { unreadOnly: true, cursorTs: 0, headLimit: 10 }).map(
      (r) => r.id,
    );
    expect(head).toEqual(all.slice(0, 10));
    expect(head[0]).toBe('m00');
  });

  it('lets a reader catch up over several reads without a gap', () => {
    const { db, ada } = seed();
    const seen: string[] = [];
    let cursorTs = 0;
    for (let round = 0; round < 5; round++) {
      const rows = listInbox(db, ada, { unreadOnly: true, cursorTs, headLimit: 10 });
      seen.push(...rows.map((r) => r.id));
      // What a client may safely do after a truncated read: advance to the last row it actually saw.
      cursorTs = rows[rows.length - 1]!.ts;
    }
    const all = listInbox(db, ada, { unreadOnly: true, cursorTs: 0 }).map((r) => r.id);
    expect(seen).toEqual(all);
  });

  it('pages an unread read forward from `since`, so a caller can walk a backlog', () => {
    const { db, ada } = seed();
    const first = listInbox(db, ada, { unreadOnly: true, cursorTs: 0, headLimit: 10 });
    const next = listInbox(db, ada, {
      unreadOnly: true,
      cursorTs: 0,
      since: first[first.length - 1]!.ts,
      headLimit: 10,
    });
    // Without `since` being honoured alongside `unreadOnly`, this would hand back m00-m09 again and
    // a paging caller would loop forever on the first page.
    expect(next.map((r) => r.id)).toEqual([
      'm10',
      'm11',
      'm12',
      'm13',
      'm14',
      'm15',
      'm16',
      'm17',
      'm18',
      'm19',
    ]);
  });

  it('never pages behind the read cursor — the later of the two floors wins', () => {
    const { db, ada } = seed();
    const all = listInbox(db, ada, { unreadOnly: true, cursorTs: 0 });
    const cursorTs = all[19]!.ts; // the seat has read through m19
    const rows = listInbox(db, ada, { unreadOnly: true, cursorTs, since: 0, headLimit: 5 });
    expect(rows.map((r) => r.id)).toEqual(['m20', 'm21', 'm22', 'm23', 'm24']);
  });

  it('leaves `limit` alone — it still takes the newest tail, which is what it is for', () => {
    const { db, ada } = seed();
    const tail = listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 10 }).map((r) => r.id);
    expect(tail[tail.length - 1]).toBe('m49');
    expect(tail[0]).toBe('m40');
  });
});

/**
 * `?limit=` is the newest tail. That is right for team chatter and wrong for a waiting handoff:
 * MCP always sends `limit` (default 50), so an old directed act sits behind the newest broadcasts
 * and `team_inbox_check` reports nothing waiting while the CLI banner, which reads with no limit,
 * counts it. Pin action-needed unread into the limited page. Directed `message` stays newest-N so
 * a mailbox of DMs does not explode the bound.
 */
describe('listInbox limit — pin action-needed unread into the newest tail', () => {
  it('keeps an old unread handoff on a page of newer team broadcasts', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive' });
    const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'handoff-old',
        team: team.slug,
        from: 'nick',
        to: { kind: 'member', name: 'Ada' },
        act: 'handoff',
        body: 'take this',
        thread: null,
        meta: null,
        ts: 1,
      }),
    );
    for (let i = 0; i < 100; i++) {
      insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: `t${String(i).padStart(3, '0')}`,
          team: team.slug,
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: 'noise',
          thread: null,
          meta: null,
          ts: 1_000 + i,
        }),
      );
    }
    const page = listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 50 });
    const ids = page.map((r) => r.id);
    expect(ids).toContain('handoff-old');
    expect(ids).toContain('t099');
    expect(ids).not.toContain('t000');
  });
});
