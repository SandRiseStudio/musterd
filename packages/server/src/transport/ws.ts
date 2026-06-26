import type { IncomingMessage } from 'node:http';
import { WSClientFrame, PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { ulid } from 'ulid';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkUpgrade } from '../config.js';
import type { Ctx } from '../context.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope } from '../protocol/validate.js';
import { authMember } from '../store/members.js';
import {
  attach,
  clearMemberPresence,
  hasLivePresence,
  heartbeat,
  presenceById,
  release,
} from '../store/presence.js';
import { toMember } from '../store/rows.js';
import { recordError, recordPresenceChurn } from '../telemetry.js';
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
function emitPresence(
  ctx: Ctx,
  conn: Connection,
  status: 'online' | 'offline',
  surface?: string,
): void {
  ctx.hub.broadcastTeam(
    conn.teamId,
    {
      type: 'presence',
      member: conn.memberName,
      status,
      ...(surface ? { surface: surface as never } : {}),
    },
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
    // Origin/Host gate (ADR 040): blunt cross-site / DNS-rebinding abuse of a now-exposed daemon.
    const check = checkUpgrade(
      { host: req.headers.host, origin: req.headers.origin },
      {
        boundHost: ctx.config.host,
        allowedHosts: ctx.config.allowedHosts,
        allowedOrigins: ctx.config.allowedOrigins,
      },
    );
    if (!check.ok) {
      log.warn({ msg: 'ws_upgrade_rejected', reason: check.reason });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
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
          // Single-active is *kind-scoped* (ADR 042). **Agent** seats stay single-active,
          // newest-wins (ADR 017, supersedes ADR 010's refusal): one live attachment per agent,
          // and a fresh hello from the *same identity* takes the seat — so a reloaded/orphaned
          // adapter can't lock the agent out of its own seat, and N parallel autonomous minds can't
          // wear one identity. Displace any existing live session: tell it it was superseded, close
          // it, and evict it from the hub.
          // **Human** seats *fan out* instead: a person may watch on a phone while acting on a
          // laptop, so a new human hello attaches an *additional* presence alongside the existing
          // ones — no displacement, no clear. Delivery already pushes to all of a member's conns
          // (hub.deliver), and the durable inbox cursor dedupes (ADR 042; deployment-topology §7).
          // Observers (ADR 063) fan out like humans — several dashboards may watch one seat — so they
          // are exempt from agent single-active displacement.
          if (member.kind === 'agent' && member.observer === 0) {
            for (const old of ctx.hub.connsForMember(member.id)) {
              old.send({
                type: 'error',
                code: 'superseded',
                message: `your session as "${member.name}" was taken over by a newer one`,
              });
              old.close?.();
              ctx.hub.remove(old.connId);
            }
            clearMemberPresence(ctx.db, member.id);
          }
          const presence = attach(ctx.db, member.id, frame.surface, state.connId, {
            provenance: frame.provenance ?? null,
            workspace: frame.workspace ?? null,
            driver: frame.driver ?? null,
          });
          const conn: Connection = {
            connId: state.connId,
            memberId: member.id,
            memberName: member.name,
            teamId: team.id,
            presenceId: presence.id,
            observer: member.observer === 1,
            send: (f) => send(ws, f),
            close: () => ws.close(),
          };
          state.authenticated = true;
          state.conn = conn;
          ctx.hub.add(conn);
          recordPresenceChurn('attach', frame.surface);
          send(ws, {
            type: 'welcome',
            member: toMember(member, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
          });
          // An observer (ADR 063) watches without participating — no online presence event.
          if (!conn.observer) emitPresence(ctx, conn, 'online', frame.surface);
          log.info({ msg: 'ws_hello', team: team.slug, member: member.name, conn: state.connId });
          return;
        }

        if (!state.authenticated || !state.conn) {
          throw new MusterdError('unauthorized', 'send hello first');
        }
        const conn = state.conn;

        switch (frame.type) {
          case 'subscribe': {
            // `team-all` = the firehose: this connection receives every envelope routed on the team,
            // not just recipient-matched ones — for read-only observers like the dashboard (ADR 061).
            if (frame.scope === 'team-all') ctx.hub.subscribeFirehose(conn.connId);
            send(ws, { type: 'subscribed', scope: frame.scope });
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
              .prepare<
                [string],
                import('../store/rows.js').MemberRow
              >('SELECT * FROM members WHERE id = ?')
              .get(conn.memberId);
            if (!team || !member)
              throw new MusterdError('server_error', 'connection lost its identity');
            const teamRow = ctx.db
              .prepare<
                [string],
                import('../store/rows.js').TeamRow
              >('SELECT * FROM teams WHERE id = ?')
              .get(conn.teamId)!;
            const result = routeEnvelope(ctx, teamRow, member, env);
            send(ws, { type: 'ack', id: result.message.id });
            break;
          }
        }
      } catch (err) {
        const me = asMusterdError(err);
        recordError(me.code);
        send(ws, me.toFrame());
      }
    });

    const cleanup = () => {
      const conn = state.conn;
      if (!conn) return;
      ctx.hub.remove(conn.connId);
      recordPresenceChurn('detach');
      // Keep the row as a reclaim hold for the grace window instead of deleting it (ADR 010).
      release(ctx.db, conn.presenceId, ctx.config.reclaimGraceMs);
      // Emit offline only if the member now has no live presence anywhere — never for an observer.
      if (!conn.observer && !hasLivePresence(ctx.db, conn.memberId, ctx.config.presenceTimeoutMs)) {
        emitPresence(ctx, conn, 'offline');
      }
      log.info({ msg: 'ws_close', member: conn.memberName, conn: conn.connId });
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}
