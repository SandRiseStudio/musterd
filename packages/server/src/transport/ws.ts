import type { IncomingMessage } from 'node:http';
import { ulid } from 'ulid';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WSClientFrame,
  PROTOCOL_VERSION,
  type WSServerFrame,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { log } from '../log.js';
import { parseEnvelope } from '../protocol/validate.js';
import { routeEnvelope } from '../protocol/route.js';
import { authMember } from '../store/members.js';
import {
  attach,
  clearMemberPresence,
  hasActivePresence,
  hasLivePresence,
  heartbeat,
  presenceById,
  release,
} from '../store/presence.js';
import { toMember } from '../store/rows.js';
import type { Connection } from './hub.js';

interface ConnState {
  connId: string;
  authenticated: boolean;
  conn?: Connection;
}

function send(ws: WebSocket, frame: WSServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** Emit a presence event to the team if the member just went online/offline. */
function emitPresence(ctx: Ctx, conn: Connection, status: 'online' | 'offline', surface?: string): void {
  ctx.hub.broadcastTeam(
    conn.teamId,
    { type: 'presence', member: conn.memberName, status, ...(surface ? { surface: surface as never } : {}) },
    undefined,
  );
}

export function attachWsServer(ctx: Ctx, server: import('node:http').Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const state: ConnState = { connId: ulid(), authenticated: false };

    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(ws, new MusterdError('bad_request', 'invalid JSON frame').toFrame());
        return;
      }
      const frameResult = WSClientFrame.safeParse(parsed);
      if (!frameResult.success) {
        send(ws, new MusterdError('bad_request', 'unknown or malformed frame').toFrame());
        return;
      }
      const frame = frameResult.data;

      try {
        if (frame.type === 'hello') {
          if (frame.v !== PROTOCOL_VERSION) {
            throw new MusterdError('version_mismatch', `server speaks ${PROTOCOL_VERSION}`);
          }
          const { team, member } = authMember(ctx.db, frame.team, frame.token);
          if (member.name !== frame.as) {
            throw new MusterdError('forbidden', 'token does not match the requested member');
          }
          // Single-active (ADR 010): one live attachment per member. A live holder refuses a
          // second session; a dropped holder's release hold is silently reclaimed within grace.
          if (hasActivePresence(ctx.db, member.id)) {
            throw new MusterdError('member_busy', `member "${member.name}" is already active in this team`);
          }
          clearMemberPresence(ctx.db, member.id);
          const presence = attach(ctx.db, member.id, frame.surface, state.connId);
          const conn: Connection = {
            connId: state.connId,
            memberId: member.id,
            memberName: member.name,
            teamId: team.id,
            presenceId: presence.id,
            send: (f) => send(ws, f),
          };
          state.authenticated = true;
          state.conn = conn;
          ctx.hub.add(conn);
          send(ws, {
            type: 'welcome',
            member: toMember(member, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
          });
          emitPresence(ctx, conn, 'online', frame.surface);
          log.info({ msg: 'ws_hello', team: team.slug, member: member.name, conn: state.connId });
          return;
        }

        if (!state.authenticated || !state.conn) {
          throw new MusterdError('unauthorized', 'send hello first');
        }
        const conn = state.conn;

        switch (frame.type) {
          case 'subscribe': {
            send(ws, { type: 'subscribed', scope: 'team' });
            break;
          }
          case 'heartbeat': {
            if (presenceById(ctx.db, conn.presenceId)) {
              heartbeat(ctx.db, conn.presenceId, frame.status);
            }
            break;
          }
          case 'send': {
            const env = parseEnvelope(frame.envelope);
            const team = ctx.db
              .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
              .get(conn.teamId);
            const member = ctx.db
              .prepare<[string], import('../store/rows.js').MemberRow>('SELECT * FROM members WHERE id = ?')
              .get(conn.memberId);
            if (!team || !member) throw new MusterdError('server_error', 'connection lost its identity');
            const teamRow = ctx.db
              .prepare<[string], import('../store/rows.js').TeamRow>('SELECT * FROM teams WHERE id = ?')
              .get(conn.teamId)!;
            const result = routeEnvelope(ctx, teamRow, member, env);
            send(ws, { type: 'ack', id: result.message.id });
            break;
          }
        }
      } catch (err) {
        send(ws, asMusterdError(err).toFrame());
      }
    });

    const cleanup = () => {
      const conn = state.conn;
      if (!conn) return;
      ctx.hub.remove(conn.connId);
      // Keep the row as a reclaim hold for the grace window instead of deleting it (ADR 010).
      release(ctx.db, conn.presenceId, ctx.config.reclaimGraceMs);
      // Emit offline only if the member now has no live presence anywhere.
      if (!hasLivePresence(ctx.db, conn.memberId, ctx.config.presenceTimeoutMs)) {
        emitPresence(ctx, conn, 'offline');
      }
      log.info({ msg: 'ws_close', member: conn.memberName, conn: conn.connId });
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}
