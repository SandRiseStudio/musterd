/**
 * Room manager — one live TLSocketRoom per open board. Lifted from the predecessor's sidecar
 * (amprealize whiteboard-sync) and adapted: persistence goes to disk instead of a REST
 * backend, and the agent write path mutates the LIVE room via updateStore so additions
 * broadcast to connected browsers immediately (the predecessor round-tripped agent writes
 * through its backend and a /reload ping to get the same effect).
 */
import type { UnknownRecord } from '@tldraw/store';
import { TLSocketRoom } from '@tldraw/sync-core';
import type { WebSocket } from 'ws';
import { baselineStore, TLDRAW_SCHEMA } from '../tldraw/records.js';
import { loadSnapshot, saveSnapshot } from './persistence.js';

interface ManagedRoom {
  tlRoom: TLSocketRoom<UnknownRecord, void>;
  connections: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  persistTimer: ReturnType<typeof setInterval> | null;
}

const MAX_ROOM_CAPACITY = 25;

export interface RoomManagerConfig {
  /** Ms of no connections before persisting and unloading a room. */
  idleTimeoutMs: number;
  /** Ms between periodic snapshot saves while a room is live. */
  persistIntervalMs: number;
}

export class RoomManager {
  private rooms = new Map<string, ManagedRoom>();

  constructor(private config: RoomManagerConfig) {}

  activeRoomCount(): number {
    return this.rooms.size;
  }

  /** Load (or create) the live room for a board. */
  async ensureRoom(
    name: string,
  ): Promise<{ room: TLSocketRoom<UnknownRecord, void>; created: boolean }> {
    const existing = this.rooms.get(name);
    if (existing) return { room: existing.tlRoom, created: false };

    const persisted = await loadSnapshot(name);
    const created = persisted === null;
    type Options = ConstructorParameters<typeof TLSocketRoom<UnknownRecord, void>>[0];
    const initialSnapshot = (
      created ? { store: baselineStore(), schema: TLDRAW_SCHEMA } : persisted
    ) as NonNullable<Options['initialSnapshot']>;

    const tlRoom = new TLSocketRoom<UnknownRecord, void>({ initialSnapshot });

    const managed: ManagedRoom = {
      tlRoom,
      connections: new Set(),
      idleTimer: null,
      persistTimer: null,
    };
    managed.persistTimer = setInterval(() => {
      void this.persistRoom(name, managed).catch((err) =>
        log('error', `periodic persist failed for board=${name}`, err),
      );
    }, this.config.persistIntervalMs);

    this.rooms.set(name, managed);
    if (created) await this.persistRoom(name, managed);
    this.resetIdleTimer(name, managed);
    return { room: tlRoom, created };
  }

  /** Wire a browser WebSocket into a board's room. */
  async handleConnection(name: string, sessionId: string, ws: WebSocket): Promise<void> {
    const { room } = await this.ensureRoom(name);
    const managed = this.rooms.get(name)!;

    if (managed.connections.size >= MAX_ROOM_CAPACITY) {
      ws.close(4003, 'Room at capacity');
      return;
    }

    managed.connections.add(sessionId);
    this.resetIdleTimer(name, managed);

    type SocketArg = Parameters<
      TLSocketRoom<UnknownRecord, void>['handleSocketConnect']
    >[0]['socket'];
    room.handleSocketConnect({ sessionId, socket: ws as unknown as SocketArg });

    ws.on('close', () => {
      managed.connections.delete(sessionId);
      room.handleSocketClose(sessionId);
      if (managed.connections.size === 0) this.resetIdleTimer(name, managed);
    });
  }

  /** Persist a board now (called after every agent mutation — boards are small). */
  async persist(name: string): Promise<void> {
    const managed = this.rooms.get(name);
    if (managed) await this.persistRoom(name, managed);
  }

  /** Persist and unload one board. Idempotent when the board isn't loaded. */
  async closeRoom(name: string): Promise<void> {
    const managed = this.rooms.get(name);
    if (!managed) return;
    await this.persistRoom(name, managed);
    this.teardownRoom(name, managed);
  }

  /** Persist and unload everything — shutdown path. */
  async persistAllAndClose(): Promise<void> {
    await Promise.allSettled(
      [...this.rooms.entries()].map(async ([name, managed]) => {
        try {
          await this.persistRoom(name, managed);
        } catch (err) {
          log('error', `persist on shutdown failed for board=${name}`, err);
        }
        this.teardownRoom(name, managed);
      }),
    );
  }

  private resetIdleTimer(name: string, managed: ManagedRoom): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (managed.connections.size === 0) {
      managed.idleTimer = setTimeout(() => {
        void this.persistRoom(name, managed)
          .catch((err) => log('error', `idle persist failed for board=${name}`, err))
          .finally(() => this.teardownRoom(name, managed));
      }, this.config.idleTimeoutMs);
    }
  }

  private async persistRoom(name: string, managed: ManagedRoom): Promise<void> {
    await saveSnapshot(name, managed.tlRoom.getCurrentSnapshot());
  }

  private teardownRoom(name: string, managed: ManagedRoom): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (managed.persistTimer) clearInterval(managed.persistTimer);
    managed.tlRoom.close();
    this.rooms.delete(name);
  }
}

function log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'agent-whiteboard',
    component: 'room-manager',
    message,
    ...(error instanceof Error ? { error: error.message } : {}),
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
