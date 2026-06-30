import type { IncomingMessage } from 'node:http';
import {
  WSClientFrame,
  PROTOCOL_VERSION,
  type WSServerFrame,
  type ClaimTarget,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkUpgrade } from '../config.js';
import type { Ctx } from '../context.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope } from '../protocol/validate.js';
import { appendAudit } from '../store/audit.js';
import { consumeGrant, validateGrant } from '../store/grants.js';
import {
  authMember,
  getMemberById,
  getMemberByName,
  hashToken,
  touchSeen,
} from '../store/members.js';
import {
  attach,
  clearOrphanPresence,
  clearPresenceById,
  hasLivePresence,
  heartbeat,
  presenceById,
  release,
} from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import { resolveAccountStatus, resolveCapabilities, toMember } from '../store/rows.js';
import { getAgentKeyHash, requireTeam } from '../store/teams.js';
import { recordError, recordPresenceChurn } from '../telemetry.js';
import type { Connection } from './hub.js';

/** Encode a ClaimTarget to the requests table's single-string format. */
function encodeTarget(t: ClaimTarget): string {
  if ('seat' in t) return `seat:${t.seat}`;
  if ('role' in t) return `role:${t.role}`;
  return 'observe';
}

/** Return claimable seat names for the refused frame hint (ADR 055 no-dead-end rule). */
function claimableSeats(ctx: Ctx, teamId: string): string[] {
  return ctx.db
    .prepare<[string], { name: string }>(
      "SELECT name FROM members WHERE team_id = ? AND left_at IS NULL AND kind = 'agent' AND observer = 0 ORDER BY name",
    )
    .all(teamId)
    .map((r) => r.name);
}

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
          //
          // Displacement is **workspace-scoped** (ADR 068). A hello from the *same* workspace is the
          // same seat reconnecting — a session reload, or (the common case) a health-check probe that
          // briefly spawns the autojoin MCP server every ~90s — and must NOT supersede the live
          // session, or the seat flaps and the agent's posts "land on retry". Only a hello from a
          // *different* workspace is a genuinely new session that should take the seat (newest-wins,
          // ADR 017). A client that sends no workspace falls back to the old displace-all behavior.
          if (member.kind === 'agent' && member.observer === 0) {
            const sameWorkspace = (w?: string | null): boolean =>
              w != null && frame.workspace != null && w === frame.workspace;
            for (const old of ctx.hub.connsForMember(member.id)) {
              if (sameWorkspace(old.workspace)) continue; // same seat reconnecting/probing — keep it
              old.send({
                type: 'error',
                code: 'superseded',
                message: `your session as "${member.name}" was taken over by a newer one`,
              });
              old.close?.();
              ctx.hub.remove(old.connId);
              clearPresenceById(ctx.db, old.presenceId);
            }
            // Sweep crashed-session / grace-hold leftovers, but never the live same-workspace presence.
            clearOrphanPresence(ctx.db, member.id);
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
            workspace: frame.workspace ?? null,
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
          // An observer (ADR 063) watches without participating — no online presence event. Bump its
          // last-seen so the idle-TTL reaper keeps an actively-used seat (ADR 064).
          if (conn.observer) touchSeen(ctx.db, member.id);
          else emitPresence(ctx, conn, 'online', frame.surface);
          log.info({ msg: 'ws_hello', team: team.slug, member: member.name, conn: state.connId });
          return;
        }

        // P3.2 claim frame (ADR 077): governed successor to hello. Authenticates with the team agent
        // key (harness) or a human credential, optionally with a pre-issued grant. Without a grant the
        // server opens a claim request and holds this WS open until an admin decides (spec-gap 3).
        if (frame.type === 'claim') {
          if (frame.v !== PROTOCOL_VERSION) {
            throw new MusterdError('version_mismatch', `server speaks ${PROTOCOL_VERSION}`);
          }
          const team = requireTeam(ctx.db, frame.team);

          // Step 1: authenticate the key — agent key (mskey_) or human credential (mscr_).
          let authenticatedAs: import('../store/rows.js').MemberRow | null = null;
          const keyHash = getAgentKeyHash(ctx.db, team.id);
          if (keyHash && hashToken(frame.key) === keyHash) {
            // Agent harness: key validates against the team secret. No specific member identity yet.
          } else {
            // Human credential: look up by hash.
            const credHash = hashToken(frame.key);
            authenticatedAs =
              ctx.db
                .prepare<
                  [string, string],
                  import('../store/rows.js').MemberRow
                >("SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind = 'human'")
                .get(team.id, credHash) ?? null;
            if (!authenticatedAs) {
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: 'invalid key — present a valid agent key or human credential',
                claimable,
                hint: `musterd claim <seat> --key <mskey_...>`,
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: null,
                result: 'deny',
                detail: { code: 'forbidden', reason: 'invalid_key' },
              });
              return;
            }
          }

          // Step 2: resolve the target member.
          let targetMember: import('../store/rows.js').MemberRow | null = null;
          if ('seat' in frame.target) {
            targetMember = getMemberByName(ctx.db, team.id, frame.target.seat) ?? null;
            if (!targetMember || targetMember.left_at !== null) {
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'not_found',
                message: `no seat "${frame.target.seat}" in team "${team.slug}"`,
                claimable,
                hint: claimable.length
                  ? `available: ${claimable.join(', ')}`
                  : `musterd team add <seat> --team ${team.slug}`,
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: frame.target.seat,
                result: 'deny',
                detail: { code: 'not_found' },
              });
              return;
            }
            // Human credential must match the target seat.
            if (authenticatedAs && authenticatedAs.id !== targetMember.id) {
              const claimable = [authenticatedAs.name];
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: `credential identifies "${authenticatedAs.name}", not "${frame.target.seat}"`,
                claimable,
                hint: `musterd claim ${authenticatedAs.name} --key <mscr_...>`,
              });
              return;
            }
          } else if ('role' in frame.target) {
            targetMember =
              ctx.db
                .prepare<
                  [string, string],
                  import('../store/rows.js').MemberRow
                >('SELECT * FROM members WHERE team_id = ? AND role = ? AND left_at IS NULL LIMIT 1')
                .get(team.id, frame.target.role) ?? null;
            if (!targetMember) {
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'not_found',
                message: `no seats with role "${frame.target.role}" in team "${team.slug}"`,
                claimable,
                hint: claimable.length
                  ? `available seats: ${claimable.join(', ')}`
                  : `musterd team add <seat> --role ${frame.target.role} --team ${team.slug}`,
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: frame.target.role,
                result: 'deny',
                detail: { code: 'not_found', kind: 'role' },
              });
              return;
            }
          }
          // observe: no target member — observer provisioned below in the OCCUPY path

          // Step 3: account_status check on target member.
          if (targetMember) {
            const status = resolveAccountStatus(targetMember);
            if (status === 'disabled' || status === 'banned') {
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: status,
                message: `seat "${targetMember.name}" is ${status}`,
                claimable,
                hint: `contact a team admin to re-enable this seat`,
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: targetMember.name,
                result: 'deny',
                detail: { code: status },
              });
              return;
            }
          }

          // Step 4: single-active check for non-observer seats.
          if (targetMember && !('observe' in frame.target)) {
            const live = ctx.hub.connsForMember(targetMember.id);
            if (live.length > 0) {
              const claimable = claimableSeats(ctx, team.id).filter(
                (n) => n !== targetMember!.name,
              );
              send(ws, {
                type: 'refused',
                code: 'claim_conflict',
                message: `seat "${targetMember.name}" is already occupied`,
                claimable,
                hint: claimable.length
                  ? `try: ${claimable.join(', ')}`
                  : 'wait for the seat to be released or ask an admin to reclaim it',
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: targetMember.name,
                result: 'deny',
                detail: { code: 'claim_conflict' },
              });
              return;
            }
          }

          // Step 5: grant path — if frame.grant is present, validate it and OCCUPY immediately.
          if (frame.grant) {
            const gv = validateGrant(ctx.db, team.id, frame.grant);
            if (!gv.ok) {
              const code = gv.reason === 'expired' ? 'expired_grant' : 'forbidden';
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code,
                message: `grant ${gv.reason}`,
                claimable,
                hint: 'request a new grant from a team admin',
              });
              appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: targetMember?.name ?? null,
                result: 'deny',
                detail: { code, reason: gv.reason },
              });
              return;
            }
            // Validate grant target matches claim target.
            const grantTarget = gv.grant.target;
            const targetOk =
              ('seat' in frame.target &&
                gv.grant.scope === 'seat' &&
                grantTarget === frame.target.seat) ||
              ('role' in frame.target &&
                gv.grant.scope === 'role' &&
                grantTarget === frame.target.role);
            if (!targetOk) {
              const claimable = claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: `grant is for ${gv.grant.scope} "${grantTarget}", not "${encodeTarget(frame.target)}"`,
                claimable,
                hint: 'request a grant that matches your target seat/role',
              });
              return;
            }
            consumeGrant(ctx.db, gv.grant.id);
            // OCCUPY — fall through to the common occupy block below.
          } else {
            // Step 6: no grant → open a claim request and hold the WS open.
            const encodedTarget = 'observe' in frame.target ? null : encodeTarget(frame.target);
            const req = createRequest(ctx.db, team.id, {
              kind: 'claim',
              from_session: state.connId,
              target: encodedTarget,
              surface: frame.surface,
            });
            // Add a provisional pending connection (not in byMember — no deliver routing).
            const pendingConn: Connection = {
              connId: state.connId,
              memberId: targetMember?.id ?? '',
              memberName: targetMember?.name ?? '',
              teamId: team.id,
              presenceId: '',
              awaitingClaim: req.id,
              isAdmin: false,
              send: (f) => send(ws, f),
              close: () => ws.close(),
              _claimApproved: (presenceId) => {
                state.authenticated = true;
                state.conn = {
                  connId: state.connId,
                  memberId: targetMember?.id ?? '',
                  memberName: targetMember?.name ?? '',
                  teamId: team.id,
                  presenceId,
                  observer: targetMember?.observer === 1,
                  send: (f) => send(ws, f),
                  close: () => ws.close(),
                };
                // Promote from pending to full member slot in hub.
                ctx.hub.remove(state.connId);
                ctx.hub.add(state.conn);
              },
            };
            ctx.hub.addPending(pendingConn);
            send(ws, {
              type: 'pending',
              request_id: req.id,
              message: `claim request ${req.id} opened — waiting for admin approval`,
            });
            // Notify admins.
            ctx.hub.deliverToAdmins(team.id, {
              type: 'pending',
              request_id: req.id,
              message: `seat claim request from ${frame.surface}: ${encodedTarget ?? 'teammate'}`,
            });
            appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'claim.pending',
              target: targetMember?.name ?? null,
              result: 'allow',
              detail: { request_id: req.id, surface: frame.surface },
            });
            log.info({
              msg: 'ws_claim_pending',
              team: team.slug,
              target: encodedTarget,
              request: req.id,
              conn: state.connId,
            });
            return; // WS stays open — admin decision arrives via hub.deliverClaimDecision
          }

          // OCCUPY: attach presence and complete the handshake.
          if (!targetMember) {
            // Observer attach: this path isn't fully built in P3.2 MVP; refuse gracefully.
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message:
                'observer observe-target via claim not yet supported — use hello with observer seat',
              claimable: [],
              hint: 'use hello with an observer seat token',
            });
            return;
          }
          const presence = attach(ctx.db, targetMember.id, frame.surface, state.connId, {
            provenance: null,
            workspace: null,
            driver: null,
          });
          const conn: Connection = {
            connId: state.connId,
            memberId: targetMember.id,
            memberName: targetMember.name,
            teamId: team.id,
            presenceId: presence.id,
            observer: targetMember.observer === 1,
            isAdmin: resolveCapabilities(targetMember).is_admin,
            send: (f) => send(ws, f),
            close: () => ws.close(),
          };
          state.authenticated = true;
          state.conn = conn;
          ctx.hub.add(conn);
          recordPresenceChurn('attach', frame.surface);
          send(ws, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            memory: null,
          });
          if (!conn.observer) emitPresence(ctx, conn, 'online', frame.surface);
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.occupied',
            target: targetMember.name,
            result: 'allow',
            detail: { surface: frame.surface },
          });
          log.info({
            msg: 'ws_claim_occupied',
            team: team.slug,
            member: targetMember.name,
            conn: state.connId,
          });
          return;
        }

        if (!state.authenticated || !state.conn) {
          throw new MusterdError('unauthorized', 'send hello or claim first');
        }
        const conn = state.conn;

        switch (frame.type) {
          case 'subscribe': {
            // `team-all` = the firehose: this connection receives every envelope routed on the team,
            // not just recipient-matched ones — for read-only observers like the dashboard (ADR 061).
            // Gated on `can_observe` (ADR 071, P2): a seat narrowed to `can_observe:false` is refused the
            // firehose. Generalist `can_observe:true` keeps every observer/dashboard working.
            if (frame.scope === 'team-all') {
              const subscriber = getMemberById(ctx.db, conn.memberId);
              if (subscriber && !resolveCapabilities(subscriber).can_observe) {
                appendAudit(ctx.db, conn.teamId, {
                  actor: conn.memberName,
                  action: 'observe.denied',
                  target: null,
                  result: 'deny',
                });
                throw new MusterdError(
                  'forbidden',
                  `seat "${conn.memberName}" lacks the can_observe capability`,
                );
              }
              ctx.hub.subscribeFirehose(conn.connId);
            }
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
