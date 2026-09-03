import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { getCursor } from '../store/cursors.js';
import { getMemberByName } from '../store/members.js';
import { getMemory } from '../store/memory.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * Per-seat continuity replication (ADR 366, residence-2 census gap 2) between two real daemons.
 *
 * The census measured the gap: `seat_memory` and `inbox_cursors` were local UPSERTs, so a human who
 * trusts a second laptop (ADR 358) found no note there and re-read an inbox already read. These are
 * the lane's falsifiers: the note crosses WITH ITS BODY (the decision that overturned ADR 093's hard
 * rule 5); a clear beats a stale save and a newer save beats a clear, each on the origin's clock;
 * the cursor crosses as a message id and is re-read against the receiver's own order, never as a
 * timestamp; and a cursor naming a message not yet folded BLOCKS rather than skipping.
 *
 * Harness copied from policy.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let nickOnJoiner: string;
let dir: string;
let joinerCtx: Ctx;

async function call(
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  base: string,
  path: string,
  body?: unknown,
  auth?: string,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}
const post = (base: string, path: string, body?: unknown, auth?: string) =>
  call('POST', base, path, body, auth);

const hubCtx = (): Ctx => ({
  db: hub.db,
  hub: new Hub(),
  config: resolveConfig(),
  rosterRoots: [],
});
const hubTeam = () => getTeamBySlug(hub.db, 'bravo')!;
const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;
const nickOn = (db: RunningServer['db'], team: { id: string }) =>
  getMemberByName(db, team.id, 'nick')!;

async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

async function enrollJoiner() {
  const { json: minted } = await post(
    hubBase,
    '/teams/bravo/nodes/invite',
    { label: 'joiner laptop' },
    nickOnHub,
  );
  const res = await post(joinerBase, '/node/enroll', {
    hub_url: hubBase,
    code: minted.invite,
    team: 'bravo',
  });
  expect(res.status).toBe(200);
}

/** A message on the joiner, so the cursor has somewhere to point. */
function messageOnJoiner(id: string, ts: number) {
  const jt = joinerTeam();
  insertMessage(
    joiner.db,
    jt.id,
    nickOn(joiner.db, jt).id,
    null,
    makeEnvelope({
      id,
      team: 'bravo',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: id,
      ts,
    }),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-continuity-sync-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
  joinerCtx = { db: joiner.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
  nickOnHub = (
    await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
  nickOnJoiner = (
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
  // The joiner's node row is minted on its first logged act, and enrollment needs one.
  messageOnJoiner('j-0', 1000);
  await enrollJoiner();
});

afterEach(async () => {
  await hub.close();
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('seat memory replication (ADR 366)', () => {
  it('a note saved on the joiner is readable on the hub, BODY included, after one round trip', async () => {
    const saved = await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      {
        headline: 'left off here',
        body: 'mid-flight: the cursor half is designed, memory half blocked',
      },
      nickOnJoiner,
    );
    expect(saved.status).toBe(204);
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)).toBeNull();

    await roundTrip();

    // The census's measured gap, now closed — and closed with the body, which is what continuity
    // IS. A headline-only copy would have told the second machine that a note exists and nothing
    // of what it says.
    const onHub = getMemory(hub.db, nickOn(hub.db, hubTeam()).id);
    expect(onHub?.headline).toBe('left off here');
    expect(onHub?.body).toBe('mid-flight: the cursor half is designed, memory half blocked');
  });

  it('the folded row keeps the ORIGIN’s saved_at — one clock per fact', async () => {
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'h', body: 'b' },
      nickOnJoiner,
    );
    const origin = getMemory(joiner.db, nickOn(joiner.db, joinerTeam()).id)!;
    await roundTrip();
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)?.saved_at).toBe(origin.saved_at);
  });

  it('a newer save wins over an older one whichever direction it travels (LWW on the origin clock)', async () => {
    // Save on the hub first, then a NEWER one on the joiner. The joiner's must win on the hub even
    // though the hub's own row was written by a seat credential the hub authenticated itself.
    await call('PUT', hubBase, '/teams/bravo/memory', { headline: 'older', body: 'o' }, nickOnHub);
    await new Promise((r) => setTimeout(r, 5));
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'newer', body: 'n' },
      nickOnJoiner,
    );
    await roundTrip();
    await roundTrip(); // the hub's own row also crosses back; the joiner must not regress to it
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)?.headline).toBe('newer');
    expect(getMemory(joiner.db, nickOn(joiner.db, joinerTeam()).id)?.headline).toBe('newer');
  });

  it('a clear on one machine removes the note on the other — a dropped note must not walk back in', async () => {
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'h', body: 'b' },
      nickOnJoiner,
    );
    await roundTrip();
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)).not.toBeNull();

    const cleared = await call(
      'DELETE',
      joinerBase,
      '/teams/bravo/memory',
      undefined,
      nickOnJoiner,
    );
    expect(cleared.status).toBe(204);
    await roundTrip();
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)).toBeNull();
    // And two more ticks later it has not come back from anywhere.
    await roundTrip();
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)).toBeNull();
    expect(getMemory(joiner.db, nickOn(joiner.db, joinerTeam()).id)).toBeNull();
  });

  it('a save made AFTER a clear survives the clear arriving late', async () => {
    // Clear on the hub, then a newer save on the joiner, then both cross. The clear is a fact with
    // a clock; it is about the note that the new note replaced, and must lose to the newer save.
    await call('PUT', hubBase, '/teams/bravo/memory', { headline: 'old', body: 'o' }, nickOnHub);
    await call('DELETE', hubBase, '/teams/bravo/memory', undefined, nickOnHub);
    await new Promise((r) => setTimeout(r, 5));
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'fresh', body: 'f' },
      nickOnJoiner,
    );
    await roundTrip();
    await roundTrip();
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)?.headline).toBe('fresh');
    expect(getMemory(joiner.db, nickOn(joiner.db, joinerTeam()).id)?.headline).toBe('fresh');
  });

  it('the stamped row is an audit row that CARRIES the body — ADR 093 hard rule 5, overturned on purpose', async () => {
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'sensitive subject', body: 'PASSWORD=hunter2' },
      nickOnJoiner,
    );
    await roundTrip();
    const row = hub.db
      .prepare<
        [],
        { detail: string; origin_seq: number }
      >("SELECT detail, origin_seq FROM audit WHERE action = 'continuity.memory_saved'")
      .get()!;
    // Stated, not discovered: the audit log now holds memory bodies, daemon-side only, bounded by
    // the 8 KiB cap. This is the consequence ADR 366 writes down.
    expect(JSON.parse(row.detail)).toMatchObject({
      headline: 'sensitive subject',
      body: 'PASSWORD=hunter2',
    });
    expect(row.origin_seq).toBeGreaterThan(0);
  });
});

describe('inbox cursor replication (ADR 366)', () => {
  it('a cursor advanced on the joiner is at the same MESSAGE on the hub — resolved locally, not by timestamp', async () => {
    messageOnJoiner('j-1', 2000);
    messageOnJoiner('j-2', 3000);
    await roundTrip(); // the messages must be on the hub before the cursor can point at them
    const before = getCursor(hub.db, nickOn(hub.db, hubTeam()).id);
    expect(before.last_read_message_id).toBeNull();

    const advanced = await post(
      joinerBase,
      '/teams/bravo/inbox/cursor',
      { last_read_message_id: 'j-1' },
      nickOnJoiner,
    );
    expect(advanced.status).toBe(200);
    await roundTrip();

    const onHub = getCursor(hub.db, nickOn(hub.db, hubTeam()).id);
    expect(onHub.last_read_message_id).toBe('j-1');
    // THE point of the design: `last_read_ts` is the HUB's own created_at for j-1 — its receipt
    // clock — not the joiner's. The two daemons folded j-1 at different instants, so the raw
    // number differs; max-merging it would have put the cursor at a place no hub row occupies.
    const hubRow = hub.db
      .prepare<[string], { created_at: number }>('SELECT created_at FROM messages WHERE id = ?')
      .get('j-1')!;
    expect(onHub.last_read_ts).toBe(hubRow.created_at);
    const joinerCursor = getCursor(joiner.db, nickOn(joiner.db, joinerTeam()).id);
    expect(joinerCursor.last_read_message_id).toBe('j-1');
    // The event never carried a timestamp at all.
    const evt = hub.db
      .prepare<
        [],
        { detail: string }
      >("SELECT detail FROM audit WHERE action = 'continuity.cursor_advanced'")
      .get()!;
    expect(JSON.parse(evt.detail)).toEqual({ last_read_message_id: 'j-1' });
  });

  it('the cursor only moves FORWARD in the receiver’s order — an older position arriving late is a no-op', async () => {
    messageOnJoiner('j-1', 2000);
    messageOnJoiner('j-2', 3000);
    await roundTrip();
    // Hub reads further than the joiner will.
    await post(hubBase, '/teams/bravo/inbox/cursor', { last_read_message_id: 'j-2' }, nickOnHub);
    await post(
      joinerBase,
      '/teams/bravo/inbox/cursor',
      { last_read_message_id: 'j-1' },
      nickOnJoiner,
    );
    await roundTrip();
    await roundTrip();
    expect(getCursor(hub.db, nickOn(hub.db, hubTeam()).id).last_read_message_id).toBe('j-2');
    // And the joiner catches UP to j-2 rather than the hub falling back to j-1.
    expect(getCursor(joiner.db, nickOn(joiner.db, joinerTeam()).id).last_read_message_id).toBe(
      'j-2',
    );
  });

  it('a cursor naming a message not folded here yet STOPS the fold (cursor_unborn) instead of skipping', async () => {
    // The block-don't-skip discipline every kind shares. A cursor pointed at a place this daemon
    // cannot resolve is not a fact to apply half of; the next tick has the message.
    const result = foldBatch(hub.db, hubTeam().id, [
      {
        kind: 'continuity',
        team: 'bravo',
        hub_seq: 9_000,
        origin_node: 'node-from-elsewhere',
        origin_seq: 1,
        event: {
          id: 'cursor-ahead-of-its-message',
          ts: Date.now(),
          actor: 'nick',
          action: 'continuity.cursor_advanced',
          target: 'nick',
          result: 'allow',
          detail: { last_read_message_id: 'not-here-yet' },
        },
      },
    ]);
    expect(result.stop).toEqual({
      kind: 'cursor_unborn',
      message: 'not-here-yet',
      seat: 'nick',
      hub_seq: 9_000,
    });
    expect(result.applied).toBe(0);
    expect(
      hub.db
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'cursor-ahead-of-its-message'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('a continuity verb this build cannot project STOPS the fold rather than storing it', async () => {
    const result = foldBatch(joiner.db, joinerTeam().id, [
      {
        kind: 'continuity',
        team: 'bravo',
        hub_seq: 9_001,
        origin_node: 'node-from-the-future',
        origin_seq: 1,
        event: {
          id: 'a-future-verb',
          ts: Date.now(),
          actor: 'nick',
          action: 'continuity.pinned',
          target: 'nick',
          result: 'allow',
          detail: {},
        },
      },
    ]);
    expect(result.stop).toEqual({
      kind: 'unknown_continuity_event',
      action: 'continuity.pinned',
      hub_seq: 9_001,
    });
    expect(result.applied).toBe(0);
  });
});

describe('continuity is a SEAT fact — residence applies (unlike policy)', () => {
  it('a second enrolled node cannot push continuity for a seat that lives elsewhere', async () => {
    // Bind nick to the joiner on the hub by ordinary work.
    await call(
      'PUT',
      joinerBase,
      '/teams/bravo/memory',
      { headline: 'mine', body: 'm' },
      nickOnJoiner,
    );
    await roundTrip();

    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'someone elses laptop' },
      nickOnHub,
    );
    const evil = await post(hubBase, '/teams/bravo/nodes/join', {
      code: minted.invite,
      node_id: 'node-someone-elses-laptop',
      label: 'someone elses laptop',
    });
    expect(evil.status).toBe(200);

    const res = await post(
      hubBase,
      '/teams/bravo/sync/push',
      {
        events: [
          {
            kind: 'continuity',
            team: 'bravo',
            origin_node: evil.json.node_id,
            origin_seq: 1,
            event: {
              id: 'forged-memory-1',
              ts: Date.now() + 60_000,
              actor: 'nick',
              action: 'continuity.memory_saved',
              target: 'nick',
              result: 'allow',
              detail: {
                headline: 'overwritten',
                body: 'by a machine nick never used',
                saved_at: Date.now() + 60_000,
              },
            },
          },
        ],
      },
      evil.json.node_credential,
    );
    // Residence at ingest, the same refusal a forged message or lane transition gets. This is why
    // continuity needed NO special exemption and NO origin rule of its own: it is a seat fact, and
    // the seat-fact machinery already says who may speak for whom.
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('bound_elsewhere');
    expect(res.json.kind).toBe('continuity');
    expect(getMemory(hub.db, nickOn(hub.db, hubTeam()).id)?.headline).toBe('mine');
  });
});
