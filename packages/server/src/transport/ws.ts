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
import { appendAudit } from '../store/audit.js';
import {
  consumeGrant,
  createClaimRequest,
  findExistingRequest,
  getClaimableSeats,
  hashToken,
  validateGrant,
  verifyAgentKey,
} from '../store/claims.js';
import { authMember, getMemberById, getMemberByName, touchSeen } from '../store/members.js';
import {
  attach,
  clearOrphanPresence,
  clearPresenceById,
  hasLivePresence,
  heartbeat,
  presenceById,
  release,
} from '../store/presence.js';
import { resolveCapabilities, toMember } from '../store/rows.js';
import { requireTeam } from '../store/teams.js';
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

        // P3.2 claim handler (ADR 077, SPEC A.3): the governed successor to `hello`. Runs
        // alongside hello during the feature-branch build; hello/token are removed at the P3
        // atomic cutover (ADR 069 decision 2). Three outcomes: occupied / refused / pending.
        if (frame.type === 'claim') {
          if (frame.v !== PROTOCOL_VERSION) {
            throw new MusterdError('version_mismatch', `server speaks ${PROTOCOL_VERSION}`);
          }
          // Step 2: resolve team.
          const team = requireTeam(ctx.db, frame.team);

          // Step 3: authenticate the key (agent key or human credential, SPEC A.2).
          // Agent key: sha256(frame.key) against teams.agent_key_hash.
          // Human credential: sha256(frame.key) against the target seat's credential_hash.
          // → refused {forbidden} on mismatch. Pre-v10 schema: agent-key check falls back to
          // false (column absent), human-credential check runs if we can resolve the seat.
          const agentKeyValid = verifyAgentKey(ctx.db, team.id, frame.key);
          if (!agentKeyValid) {
            // Try human credential path — key must match the target seat's credential_hash.
            // credential_hash lands in P3.1 migration v10; pre-v10 this column is absent so
            // we fall through to refused.
            let credValid = false;
            if ('seat' in frame.target) {
              const targetMember = getMemberByName(ctx.db, team.id, frame.target.seat);
              if (targetMember) {
                try {
                  const row = ctx.db
                    .prepare<[string, string], { credential_hash: string | null }>(
                      'SELECT credential_hash FROM members WHERE id = ? AND team_id = ?',
                    )
                    .get(targetMember.id, team.id);
                  if (row?.credential_hash && row.credential_hash === hashToken(frame.key)) {
                    credValid = true;
                  }
                } catch {
                  // pre-v10: column absent
                }
              }
            }
            if (!credValid) {
              const claimable = getClaimableSeats(ctx.db, team.id);
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: 'invalid key or credential',
                claimable,
                hint:
                  claimable.length > 0
                    ? `claimable seats: ${claimable.join(', ')}`
                    : 'contact an admin to provision access',
              });
              appendAudit(ctx.db, team.id, {
                actor: 'claim',
                action: 'claim.refused',
                target: 'seat' in frame.target ? frame.target.seat : null,
                result: 'deny',
                detail: { code: 'forbidden' },
              });
              return;
            }
          }

          // Step 4: resolve target seat.
          let targetMember =
            'seat' in frame.target
              ? getMemberByName(ctx.db, team.id, frame.target.seat)
              : 'role' in frame.target
                ? // Next open seat in role pool — pick the first un-held seat with this role.
                  ctx.db
                    .prepare<[string, string], import('../store/rows.js').MemberRow>(
                      `SELECT m.* FROM members m
                       WHERE m.team_id = ? AND m.role = ? AND m.kind != 'observer'
                         AND m.left_at IS NULL
                         AND NOT EXISTS (
                           SELECT 1 FROM presences p
                           WHERE p.member_id = m.id AND p.released_at IS NULL
                         )
                       ORDER BY m.created_at ASC LIMIT 1`,
                    )
                    .get(team.id, frame.target.role)
                : // observe: true — pick or create an observer seat (ADR 063).
                  ctx.db
                    .prepare<[string], import('../store/rows.js').MemberRow>(
                      `SELECT * FROM members WHERE team_id = ? AND kind = 'agent' AND observer = 1 LIMIT 1`,
                    )
                    .get(team.id);

          if (!targetMember) {
            const claimable = getClaimableSeats(ctx.db, team.id);
            send(ws, {
              type: 'refused',
              code: 'not_found',
              message:
                'seat' in frame.target
                  ? `no seat "${frame.target.seat}" on team ${team.slug}`
                  : 'role' in frame.target
                    ? `no open seat in role "${frame.target.role}" on team ${team.slug}`
                    : `no observer seat on team ${team.slug}`,
              claimable,
              hint:
                claimable.length > 0
                  ? `open seats: ${claimable.join(', ')}`
                  : 'contact an admin to add a seat',
            });
            appendAudit(ctx.db, team.id, {
              actor: 'claim',
              action: 'claim.refused',
              target: 'seat' in frame.target ? frame.target.seat : null,
              result: 'deny',
              detail: { code: 'not_found' },
            });
            return;
          }

          // Step 5: check account_status (ADR 070).
          const caps = resolveCapabilities(targetMember);
          if (targetMember.account_status === 'disabled') {
            send(ws, {
              type: 'refused',
              code: 'disabled',
              message: `seat "${targetMember.name}" is disabled`,
              claimable: getClaimableSeats(ctx.db, team.id),
              hint: 'contact an admin to re-enable this seat',
            });
            return;
          }
          if (targetMember.account_status === 'banned') {
            send(ws, {
              type: 'refused',
              code: 'banned',
              message: `seat "${targetMember.name}" is banned`,
              claimable: [],
              hint: 'this seat has been permanently banned',
            });
            return;
          }

          // Step 6: single-active check — is the seat currently occupied?
          const alreadyHeld =
            targetMember.kind === 'agent' &&
            targetMember.observer === 0 &&
            ctx.hub.connsForMember(targetMember.id).length > 0;
          if (alreadyHeld) {
            const claimable = getClaimableSeats(ctx.db, team.id);
            send(ws, {
              type: 'refused',
              code: 'claim_conflict',
              message: `seat "${targetMember.name}" is already occupied`,
              claimable,
              hint:
                claimable.length > 0
                  ? `open seats: ${claimable.join(', ')}`
                  : 'try again when the current session ends',
            });
            appendAudit(ctx.db, team.id, {
              actor: 'claim',
              action: 'claim.refused',
              target: targetMember.name,
              result: 'deny',
              detail: { code: 'claim_conflict' },
            });
            return;
          }

          // Step 7: grant path vs no-grant path.
          if (frame.grant) {
            // Grant path: validate the presented grant token.
            const grant = validateGrant(ctx.db, team.id, frame.grant, frame.target);
            if (!grant) {
              send(ws, {
                type: 'refused',
                code: 'expired_grant',
                message: 'grant is invalid, expired, or does not match this target',
                claimable: getClaimableSeats(ctx.db, team.id),
                hint: 'request a new grant from an admin',
              });
              appendAudit(ctx.db, team.id, {
                actor: 'claim',
                action: 'claim.refused',
                target: targetMember.name,
                result: 'deny',
                detail: { code: 'expired_grant' },
              });
              return;
            }
            if (grant.single_use) consumeGrant(ctx.db, grant.id);
          } else {
            // No-grant path: create a pending request and hold the WS open (spec-gap 3, ADR 069).
            // Dedup: reuse an existing pending request for the same (team, conn, target).
            const existing = findExistingRequest(ctx.db, team.id, state.connId, frame.target);
            const req = existing ?? createClaimRequest(ctx.db, team.id, state.connId, frame.target, frame.surface);

            // Cache request_id on the hub connection (not yet in hub — will attach after occupy
            // or leave unanswered for the reaper).
            // We track awaitingClaim on a provisional Connection object so deliverClaimDecision
            // can find this socket by connId when an admin decides.
            const pendingConn: Connection = {
              connId: state.connId,
              memberId: targetMember.id,
              memberName: targetMember.name,
              teamId: team.id,
              presenceId: '', // not yet in presence — claimed pending; filled by _claimApproved
              observer: targetMember.observer === 1,
              awaitingClaim: req.id,
              isAdmin: caps.is_admin,
              // Called by the HTTP approve handler: flip auth + wire real presenceId so the WS
              // can accept subsequent frames (heartbeat, send) after the occupied frame is sent.
              _claimApproved: (presenceId: string) => {
                pendingConn.presenceId = presenceId;
                state.authenticated = true;
              },
              send: (f) => send(ws, f),
              close: () => ws.close(),
            };
            ctx.hub.add(pendingConn);
            state.conn = pendingConn; // so cleanup() can hub.remove on close

            send(ws, {
              type: 'pending',
              request_id: req.id,
              message: `your claim for seat "${targetMember.name}" is pending admin approval`,
            });
            // Push governance notification to any co-present admin seats (pending frame contains
            // the request_id so they can correlate with GET /requests). Omit deliver-envelope
            // overhead — admins render this via ApprovalCard polling GET /requests (ADR 077).
            ctx.hub.deliverToAdmins(team.id, {
              type: 'pending',
              request_id: req.id,
              message: `seat "${targetMember.name}" has a pending claim request`,
            });
            appendAudit(ctx.db, team.id, {
              actor: 'claim',
              action: 'claim.pending',
              target: targetMember.name,
              result: 'allow',
              detail: { request_id: req.id },
            });
            log.info({
              msg: 'ws_claim_pending',
              team: team.slug,
              seat: targetMember.name,
              request_id: req.id,
              conn: state.connId,
            });
            return;
          }

          // Step 9: OCCUPY — grant validated (grant path) or skipped by a human credential.
          // Mirror the hello path: single-active displacement + attach + hub.add + send occupied.
          if (targetMember.kind === 'agent' && targetMember.observer === 0) {
            for (const old of ctx.hub.connsForMember(targetMember.id)) {
              old.send({
                type: 'error',
                code: 'superseded',
                message: `your session as "${targetMember.name}" was taken over by a newer claim`,
              });
              old.close?.();
              ctx.hub.remove(old.connId);
              clearPresenceById(ctx.db, old.presenceId);
            }
            clearOrphanPresence(ctx.db, targetMember.id);
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
            isAdmin: caps.is_admin,
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
          if (conn.observer) touchSeen(ctx.db, targetMember.id);
          else emitPresence(ctx, conn, 'online', frame.surface);
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
