/**
 * Provider tests run against the REAL TldrawProvider over live TLSocketRooms — not a fake.
 * The producer and the renderer are exercised through the same seam the tools use, so a board
 * that writes what it cannot read back fails here (the two-naive-halves trap).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnknownRecord } from '@tldraw/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../sync/roomManager.js';
import { TldrawProvider } from './provider.js';
import { buildNote } from './records.js';

let dir: string;
let rooms: RoomManager;
let provider: TldrawProvider;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  rooms = new RoomManager({ idleTimeoutMs: 60_000, persistIntervalMs: 60_000 });
  provider = new TldrawProvider(rooms);
});

afterEach(async () => {
  await rooms.persistAllAndClose();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('TldrawProvider', () => {
  it('opens empty, batch-adds, reads back attributed items', async () => {
    const { outline: empty, created } = await provider.open('b1');
    expect(created).toBe(true);
    expect(empty.items).toHaveLength(0);

    const { ids } = await provider.add('b1', 'seat:izzo', [
      { kind: 'note', text: 'idea one' },
      { kind: 'note', text: 'idea two' },
      { kind: 'cluster', title: 'Theme' },
    ]);
    expect(ids).toHaveLength(3);

    const outline = await provider.read('b1');
    expect(outline.items).toHaveLength(3);
    for (const item of outline.items) expect(item.createdBy).toBe('seat:izzo');
    expect(
      outline.items
        .filter((i) => i.kind === 'note')
        .map((i) => i.text)
        .sort(),
    ).toEqual(['idea one', 'idea two']);
  });

  it('links resolve to outline ids in the read', async () => {
    const { ids } = await provider.add('b2', 'seat:izzo', [
      { kind: 'note', text: 'cause' },
      { kind: 'note', text: 'effect' },
    ]);
    await provider.add('b2', 'seat:izzo', [
      { kind: 'link', from: ids[0]!, to: ids[1]!, label: 'leads to' },
    ]);
    const outline = await provider.read('b2');
    const link = outline.items.find((i) => i.kind === 'link')!;
    expect(link.from).toBe(ids[0]);
    expect(link.to).toBe(ids[1]);
    expect(link.text).toBe('leads to');
  });

  it('since-diff sees exactly what changed after a version — including human shapes', async () => {
    await provider.add('b3', 'seat:izzo', [{ kind: 'note', text: 'before' }]);
    const v1 = (await provider.read('b3')).version;

    // A human drawing in the browser lands as an unstamped record through the sync room.
    const { room } = await rooms.ensureRoom('b3');
    const humanNote = buildNote({ x: 500, y: 500, index: 'a9', createdBy: '' });
    humanNote.meta = {};
    humanNote.props['richText'] = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'human idea' }] }],
    };
    await room.updateStore((store) => store.put(humanNote as unknown as UnknownRecord));

    const diff = await provider.read('b3', v1);
    expect(diff.items.map((i) => i.text)).toEqual(['human idea']);
    expect(diff.items[0]!.createdBy).toBe('human');
    expect(diff.version).toBeGreaterThan(v1);
  });

  it('move touches anyone; retitle/delete of the other party is refused with a reason', async () => {
    const { ids } = await provider.add('b4', 'seat:izzo', [
      { kind: 'note', text: 'agent note' },
      { kind: 'cluster', title: 'Theme' },
    ]);
    const [noteId, clusterId] = ids as [string, string];

    // A human note the agent may move but not reword or remove.
    const { room } = await rooms.ensureRoom('b4');
    const humanNote = buildNote({ x: 0, y: 0, index: 'a8', createdBy: '' });
    humanNote.meta = {};
    await room.updateStore((store) => store.put(humanNote as unknown as UnknownRecord));

    const moved = await provider.edit('b4', 'seat:izzo', [
      { op: 'move', id: humanNote.id, cluster: clusterId },
    ]);
    expect(moved.refused).toHaveLength(0);
    const afterMove = await provider.read('b4');
    expect(afterMove.items.find((i) => i.id === humanNote.id)!.cluster).toBe(clusterId);

    const refused = await provider.edit('b4', 'seat:izzo', [
      { op: 'retitle', id: humanNote.id, text: 'reworded' },
      { op: 'delete', id: humanNote.id },
      { op: 'retitle', id: noteId, text: 'my own, reworded' },
    ]);
    expect(refused.refused).toHaveLength(2);
    for (const r of refused.refused) expect(r.reason).toMatch(/not yours/);
    const after = await provider.read('b4');
    expect(after.items.find((i) => i.id === noteId)!.text).toBe('my own, reworded');
    expect(after.items.find((i) => i.id === humanNote.id)).toBeDefined();
  });

  it('refuses a link to a nonexistent item in port vocabulary, placing nothing', async () => {
    await provider.add('b7', 'seat:izzo', [{ kind: 'note', text: 'real' }]);
    await expect(
      provider.add('b7', 'seat:izzo', [
        { kind: 'note', text: 'casualty' },
        { kind: 'link', from: 'shape:nope', to: 'shape:alsono' },
      ]),
    ).rejects.toThrow(/not an item on this board.*whiteboard_read/);
    // Atomic: the valid note in the same batch did not land either.
    const outline = await provider.read('b7');
    expect(outline.items.map((i) => i.text)).toEqual(['real']);
  });

  it('deleting a link owner cleans bindings; deleting a cluster frees its members', async () => {
    const { ids } = await provider.add('b5', 'seat:izzo', [
      { kind: 'note', text: 'a' },
      { kind: 'note', text: 'b' },
      { kind: 'cluster', title: 'T' },
    ]);
    const [a, b, cluster] = ids as [string, string, string];
    const linkRes = await provider.add('b5', 'seat:izzo', [{ kind: 'link', from: a, to: b }]);
    await provider.edit('b5', 'seat:izzo', [{ op: 'move', id: a, cluster }]);

    await provider.edit('b5', 'seat:izzo', [
      { op: 'delete', id: linkRes.ids[0]! },
      { op: 'delete', id: cluster },
    ]);
    const outline = await provider.read('b5');
    expect(outline.items.find((i) => i.kind === 'link')).toBeUndefined();
    const noteA = outline.items.find((i) => i.id === a)!;
    expect(noteA.cluster).toBeUndefined(); // freed, not vanished
  });

  it('boards persist across close and reopen', async () => {
    await provider.add('b6', 'seat:izzo', [{ kind: 'note', text: 'survives' }]);
    const finalOutline = await provider.close('b6');
    expect(finalOutline.items.map((i) => i.text)).toEqual(['survives']);
    expect(rooms.activeRoomCount()).toBe(0);

    const { outline, created } = await provider.open('b6');
    expect(created).toBe(false);
    expect(outline.items.map((i) => i.text)).toEqual(['survives']);

    const boards = await provider.list();
    expect(boards.map((b) => b.name)).toContain('b6');
  });
});
