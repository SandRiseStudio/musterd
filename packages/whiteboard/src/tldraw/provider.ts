/**
 * The tldraw provider — implements the port over a RoomManager of live TLSocketRooms.
 * Agent mutations go through room.updateStore, so a connected browser sees them the moment
 * they land; every mutation persists write-through (boards are small).
 */
import type { UnknownRecord } from '@tldraw/store';
import type { TLSocketRoom } from '@tldraw/sync-core';
import type {
  CreatedBy,
  EditOp,
  EditRefusal,
  ItemInput,
  Outline,
  WhiteboardProvider,
} from '../port.js';
import { assertBoardName } from '../port.js';
import { listBoards } from '../sync/persistence.js';
import type { RoomManager } from '../sync/roomManager.js';
import { outlineFromSnapshot, shapeCount, type RoomSnapshotLike } from './outline.js';
import {
  autoPosition,
  buildCluster,
  buildLabel,
  buildLink,
  buildNote,
  nextIndex,
  PAGE_ID,
  toRichText,
  type BindingRecord,
  type ShapeRecord,
} from './records.js';

type Room = TLSocketRoom<UnknownRecord, void>;

function snap(room: Room): RoomSnapshotLike {
  return room.getCurrentSnapshot() as unknown as RoomSnapshotLike;
}

function getShape(room: Room, id: string): ShapeRecord | undefined {
  const doc = snap(room).documents.find((d) => d.state.id === id);
  return doc && doc.state.typeName === 'shape' ? (doc.state as ShapeRecord) : undefined;
}

function ownedBy(shape: ShapeRecord, actor: CreatedBy): boolean {
  const v = (shape.meta as Record<string, unknown>)['createdBy'];
  const creator = typeof v === 'string' && v.startsWith('seat:') ? v : 'human';
  return creator === actor;
}

export class TldrawProvider implements WhiteboardProvider {
  constructor(private rooms: RoomManager) {}

  async open(board: string): Promise<{ outline: Outline; created: boolean }> {
    assertBoardName(board);
    const { room, created } = await this.rooms.ensureRoom(board);
    return { outline: outlineFromSnapshot(board, snap(room)), created };
  }

  async add(
    board: string,
    actor: CreatedBy,
    items: ItemInput[],
  ): Promise<{ ids: string[]; version: number }> {
    const { room } = await this.rooms.ensureRoom(board);
    const ids: string[] = [];
    let count = shapeCount(snap(room));

    // Pre-validate link endpoints in OUR vocabulary before touching the store — the whole
    // batch is atomic, and a canvas-level validation error would teach the wrong terms.
    const known = new Set(
      snap(room)
        .documents.filter((d) => d.state.typeName === 'shape')
        .map((d) => d.state.id),
    );
    for (const item of items) {
      if (item.kind === 'link') {
        for (const end of [item.from, item.to]) {
          if (!known.has(end)) {
            throw new Error(
              `link endpoint ${JSON.stringify(end)} is not an item on this board — use ids from the outline (whiteboard_read); nothing was placed`,
            );
          }
        }
      }
    }

    await room.updateStore((store) => {
      for (const item of items) {
        const pos =
          'x' in item && item.x !== undefined && item.y !== undefined
            ? { x: item.x, y: item.y }
            : autoPosition(count);
        const base = { ...pos, index: nextIndex(count), createdBy: actor };
        count++;

        switch (item.kind) {
          case 'note': {
            const note = buildNote({
              ...base,
              text: item.text,
              ...(item.color ? { color: item.color } : {}),
            });
            if (item.cluster) {
              note.parentId = item.cluster;
              // Frame children position in frame-local coordinates.
              const inside = autoPosition(0);
              note.x = inside.x / 2;
              note.y = inside.y / 2;
            }
            store.put(note as unknown as UnknownRecord);
            ids.push(note.id);
            break;
          }
          case 'label': {
            const label = buildLabel({ ...base, text: item.text });
            store.put(label as unknown as UnknownRecord);
            ids.push(label.id);
            break;
          }
          case 'cluster': {
            const cluster = buildCluster({ ...base, title: item.title });
            store.put(cluster as unknown as UnknownRecord);
            ids.push(cluster.id);
            break;
          }
          case 'link': {
            const { arrow, bindings } = buildLink(
              { ...base, ...(item.label !== undefined ? { label: item.label } : {}) },
              item.from,
              item.to,
            );
            store.put(arrow as unknown as UnknownRecord);
            for (const b of bindings) store.put(b as unknown as UnknownRecord);
            ids.push(arrow.id);
            break;
          }
        }
      }
    });

    await this.rooms.persist(board);
    return { ids, version: snap(room).documentClock };
  }

  async read(board: string, since?: number): Promise<Outline> {
    const { room } = await this.rooms.ensureRoom(board);
    return outlineFromSnapshot(board, snap(room), since);
  }

  async edit(
    board: string,
    actor: CreatedBy,
    ops: EditOp[],
  ): Promise<{ version: number; refused: EditRefusal[] }> {
    const { room } = await this.rooms.ensureRoom(board);
    const refused: EditRefusal[] = [];

    await room.updateStore((store) => {
      for (const op of ops) {
        const shape = getShape(room, op.id);
        if (!shape) {
          refused.push({
            id: op.id,
            reason: 'no such item on this board — read the outline again',
          });
          continue;
        }

        switch (op.op) {
          case 'move': {
            // Moving anyone's item is allowed: proposing a grouping IS the converge mechanic.
            const updated: ShapeRecord = { ...shape, parentId: op.cluster ?? PAGE_ID };
            if (op.x !== undefined) updated.x = op.x;
            if (op.y !== undefined) updated.y = op.y;
            if (op.cluster && op.x === undefined) {
              // Default frame-local placement, offset from the frame's origin.
              updated.x = 40;
              updated.y = 60;
            }
            store.put(updated as unknown as UnknownRecord);
            break;
          }
          case 'retitle': {
            if (!ownedBy(shape, actor)) {
              refused.push({
                id: op.id,
                reason: `rewording the other party's item is not yours to do — add your own note beside it, or ask them`,
              });
              continue;
            }
            const props = { ...shape.props };
            if (shape.type === 'frame') props['name'] = op.text;
            else props['richText'] = toRichText(op.text);
            store.put({ ...shape, props } as unknown as UnknownRecord);
            break;
          }
          case 'delete': {
            if (!ownedBy(shape, actor)) {
              refused.push({
                id: op.id,
                reason: `deleting the other party's item is not yours to do — say why it should go, on the board or in chat`,
              });
              continue;
            }
            // Bindings referencing a deleted shape must go with it; a deleted cluster's
            // children return to the open board rather than vanishing.
            const s = snap(room);
            for (const doc of s.documents) {
              const r = doc.state;
              if (r.typeName === 'binding') {
                const b = r as BindingRecord;
                if (b.fromId === op.id || b.toId === op.id) store.delete(b.id);
              } else if (r.typeName === 'shape' && (r as ShapeRecord).parentId === op.id) {
                store.put({ ...(r as ShapeRecord), parentId: PAGE_ID } as unknown as UnknownRecord);
              }
            }
            store.delete(op.id);
            break;
          }
        }
      }
    });

    await this.rooms.persist(board);
    return { version: snap(room).documentClock, refused };
  }

  async list(): Promise<Array<{ name: string; updatedAt: number }>> {
    return listBoards();
  }

  async close(board: string): Promise<Outline> {
    const { room } = await this.rooms.ensureRoom(board);
    const outline = outlineFromSnapshot(board, snap(room));
    await this.rooms.closeRoom(board);
    return outline;
  }
}
