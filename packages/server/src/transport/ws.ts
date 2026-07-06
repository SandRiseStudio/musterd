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
import { consumeGrant, refreshGrant, validateGrant } from '../store/grants.js';
import { getMemberById, getMemberByName, hashToken, markBound } from '../store/members.js';
import { memoryEnvelope } from '../store/memory.js';
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
  /** Pending same-workspace-predecessor reap this (successor) connection scheduled (ADR 092). Cleared
   * on close so a successor that drops within the grace never reaps on behalf of a dead session. */
  evictionTimer?: NodeJS.Timeout;
}

/**
 * ADR 092: a same-workspace successor does not supersede at claim time (ADR 068 keeps the seat from
 * flapping under transient health-check probes), but once it proves **durable** — still attached
 * after a grace window — it reaps the same-workspace predecessor(s) it found, i.e. the orphaned
 * pre-reload sessions the issue #118 war was between. A transient probe disconnects before the grace,
 * so the gate finds the successor gone and keeps the incumbent untouched. Returns the timer so the
 * successor's own close can cancel it. No-op when there were no same-workspace predecessors.
 */
function scheduleSameWorkspaceEviction(
  ctx: Ctx,
  teamId: string,
  successorConnId: string,
  memberName: string,
  predecessorConnIds: string[],
): NodeJS.Timeout | undefined {
  if (predecessorConnIds.length === 0) return undefined;
  // Drift signal (ADR 092 §C): the duplicate same-workspace adapter is observable in the audit log
  // now, even before — or if — the eviction fires.
  appendAudit(ctx.db, teamId, {
    actor: memberName,
    action: 'claim.duplicate_workspace',
    target: memberName,
    result: 'allow',
    detail: { predecessors: predecessorConnIds.length, grace_ms: ctx.config.supersedeGraceMs },
  });
  const timer = setTimeout(() => {
    // Reap only if the successor is still attached — a probe that disconnected within the grace never
    // reaches here (its conn is gone), so the incumbent is preserved (ADR 068's anti-flap intact).
    if (!ctx.hub.getConn(successorConnId)) return;
    let evicted = 0;
    for (const connId of predecessorConnIds) {
      const old = ctx.hub.getConn(connId);
      if (!old) continue; // predecessor already left on its own
      old.send?.({
        type: 'error',
        code: 'superseded',
        message: `your session as "${memberName}" was replaced by a newer one in the same workspace`,
        same_workspace: true,
      });
      old.close?.();
      ctx.hub.remove(old.connId);
      clearPresenceById(ctx.db, old.presenceId);
      evicted++;
    }
    if (evicted > 0) {
      appendAudit(ctx.db, teamId, {
        actor: memberName,
        action: 'claim.superseded',
        target: memberName,
        result: 'allow',
        detail: { same_workspace: true, evicted },
      });
    }
  }, ctx.config.supersedeGraceMs);
  timer.unref?.();
  return timer;
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

          // Step 4: single-active is **kind-scoped** (ADR 042), matching the hello path. An **agent**
          // seat is newest-wins (ADR 017): a newer claim displaces the incumbent — tell it it was
          // superseded, close it, evict it — rather than dead-ending on `claim_conflict`, so a relaunched
          // agent re-occupies its own seat without a manual leave. A **human**/observer seat fans out: a
          // second claim attaches an *additional* presence with no displacement (a person may act on a
          // laptop while watching on a phone). Displacement is **workspace-scoped** (ADR 068): a claim
          // from the *same* workspace is the same seat reconnecting — a reload, or the ~90s health-check
          // MCP probe — and must NOT supersede the live session, or the seat flaps. A client that sends no
          // workspace falls back to displace-all. A same-workspace predecessor is kept here (anti-flap)
          // but reaped after this successor proves durable — see scheduleSameWorkspaceEviction (ADR 092).
          const sameWorkspacePredecessors: string[] = [];
          if (
            targetMember &&
            !('observe' in frame.target) &&
            targetMember.kind === 'agent' &&
            targetMember.observer === 0
          ) {
            const sameWorkspace = (w?: string | null): boolean =>
              w != null && frame.workspace != null && w === frame.workspace;
            for (const old of ctx.hub.connsForMember(targetMember.id)) {
              if (sameWorkspace(old.workspace)) {
                // Same seat reconnecting/probing — keep it now; a durable successor reaps it (ADR 092).
                sameWorkspacePredecessors.push(old.connId);
                continue;
              }
              old.send?.({
                type: 'error',
                code: 'superseded',
                message: `your session as "${targetMember.name}" was taken over by a newer one`,
              });
              old.close?.();
              ctx.hub.remove(old.connId);
              clearPresenceById(ctx.db, old.presenceId);
            }
            clearOrphanPresence(ctx.db, targetMember.id);
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
            // Resume token (ADR 087): a reusable grant survives consumeGrant — refresh its TTL so an
            // actively-reconnecting seat never expires. No-op for single_use/standing grants.
            refreshGrant(ctx.db, gv.grant.id, ctx.config.resumeTtlMs);
            // OCCUPY — fall through to the common occupy block below.
          } else if (authenticatedAs && targetMember && authenticatedAs.id === targetMember.id) {
            // Credential self-authorize (ADR 077): a human authenticated by their own mscr_ credential
            // claiming their own seat is self-authorizing — no grant, no admin-approval request. Fall
            // through to OCCUPY (symmetric with the POST /claim credential-occupy path).
          } else {
            // Step 6: no grant → open a claim request and hold the WS open.
            const encodedTarget = 'observe' in frame.target ? null : encodeTarget(frame.target);
            const req = createRequest(ctx.db, team.id, {
              kind: 'claim',
              from_session: state.connId,
              target: encodedTarget,
              surface: frame.surface,
              // A specific-seat claim collapses to one pending request per seat, refreshing the waiter
              // to this newest session — a reconnecting grant-less agent can't stack duplicates.
              collapseByTarget: 'seat' in frame.target,
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
            // Anonymous observe-target ({ observe: true }) isn't built yet; a *named* observer seat is
            // claimable via `target: { seat: <name> }`. Refuse gracefully and point at that.
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: 'anonymous observe-target via claim not yet supported',
              claimable: [],
              hint: 'claim a named observer seat: target { seat: "<name>" }',
            });
            return;
          }
          const presence = attach(ctx.db, targetMember.id, frame.surface, state.connId, {
            provenance: frame.provenance ?? null,
            workspace: frame.workspace ?? null,
            driver: frame.driver ?? null,
          });
          // First occupancy stamps the durable *held* marker (ADR 058) — the claim path is the v0.3
          // successor to the v0.2 first-token-touch that used to do this; keeps the ADR 070 derivation.
          markBound(ctx.db, targetMember.id);
          const conn: Connection = {
            connId: state.connId,
            memberId: targetMember.id,
            memberName: targetMember.name,
            teamId: team.id,
            presenceId: presence.id,
            observer: targetMember.observer === 1,
            isAdmin: resolveCapabilities(targetMember).is_admin,
            workspace: frame.workspace ?? null,
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
            memory: memoryEnvelope(ctx.db, targetMember.id),
          });
          if (!conn.observer) emitPresence(ctx, conn, 'online', frame.surface);
          // ADR 092: now that this successor is occupied, arm the grace-gated reap of any same-workspace
          // predecessor it displaced (the orphaned pre-reload sessions). Cancelled if it closes first.
          const evictionTimer = scheduleSameWorkspaceEviction(
            ctx,
            team.id,
            state.connId,
            targetMember.name,
            sameWorkspacePredecessors,
          );
          if (evictionTimer) state.evictionTimer = evictionTimer;
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
          throw new MusterdError('unauthorized', 'send a claim frame first');
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
      // Cancel any pending same-workspace reap this connection armed (ADR 092): a successor that drops
      // within the grace must not evict on behalf of a now-dead session (the getConn gate also guards
      // this, but clearing the timer is tidier and stops the audit row).
      if (state.evictionTimer) {
        clearTimeout(state.evictionTimer);
        delete state.evictionTimer;
      }
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
