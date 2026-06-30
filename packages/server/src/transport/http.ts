import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  MemberKindSchema,
  LifecycleSchema,
  SurfaceSchema,
  PresenceStatusSchema,
  ProvenanceSchema,
  AvailabilityStatusSchema,
  PROTOCOL_VERSION,
  GENERALIST_CAPABILITIES,
  ClaimTargetSchema,
  DecideRequestSchema,
  IssueGrantSchema,
  PolicySchema,
  type MemberSummary,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import { resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { reconcileTeam, teamSpecForSlug } from '../projection/reconcile.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope, parseOrBadRequest } from '../protocol/validate.js';
import { resolveActivity } from '../store/activity.js';
import { appendAudit, listAudit } from '../store/audit.js';
import { getCursor, setCursor } from '../store/cursors.js';
import {
  consumeGrant,
  issueGrant,
  listGrants,
  revokeGrant,
  validateGrant,
} from '../store/grants.js';
import {
  addMember,
  authMember,
  clearBound,
  getMemberById,
  getMemberByName,
  isHeld,
  hashToken,
  leaveMember,
  mintCredential,
  rotateToken,
  setAvailability,
  setMemberGovernance,
  teamHasAdmin,
} from '../store/members.js';
import {
  latestStatusUpdate,
  listInbox,
  listTeamMessages,
  rowToEnvelope,
} from '../store/messages.js';
import {
  attach,
  clearMemberPresence,
  countLivePresences,
  listPresence,
  touchAmbientPresence,
} from '../store/presence.js';
import { createRequest, decideRequest, getRequest, listRequests } from '../store/requests.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { resolveAccountStatus, resolveCapabilities, toMember } from '../store/rows.js';
import {
  createTeam,
  getAgentKeyHash,
  getPolicy,
  requireTeam,
  rotateAgentKey,
  setPolicy,
} from '../store/teams.js';
import { recordError } from '../telemetry.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res: ServerResponse, file: string): void {
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
}

/**
 * Serve the built web UI same-origin (ADR 062). A real file is served as-is; an extensionless path
 * (a client route like `/live`) falls back to `index.html` so deep links + refresh work. Path
 * traversal is refused by resolving under `webRoot` and requiring containment.
 */
function serveStatic(webRoot: string, pathname: string, res: ServerResponse): void {
  const root = resolve(webRoot);
  let target: string;
  try {
    target = resolve(root, '.' + decodeURIComponent(pathname));
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'bad path' } });
  }
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return void res.end('forbidden');
  }
  if (existsSync(target) && statSync(target).isFile()) return sendFile(res, target);
  // SPA fallback: client routes have no file extension → serve the app shell.
  if (extname(target) === '') {
    const index = join(root, 'index.html');
    if (existsSync(index)) return sendFile(res, index);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function sendError(res: ServerResponse, err: unknown): void {
  const me = asMusterdError(err);
  recordError(me.code);
  sendJson(res, me.httpStatus, me.toBody());
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MusterdError('bad_request', 'invalid JSON body');
  }
}

function bearer(req: IncomingMessage): string {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer '))
    throw new MusterdError('unauthorized', 'missing bearer token');
  return h.slice('Bearer '.length).trim();
}

/**
 * The seat the caller is acting as, from the `x-musterd-seat` header (SPEC A.7 §253). Required by the
 * agent-key auth path (the key authenticates the harness, not a seat); harmless on the legacy token /
 * credential paths, which resolve the seat from the secret itself. Both v0.3 clients set it on every
 * authed call (ADR 077, commit 4d11b35).
 */
function actingSeat(req: IncomingMessage): string | undefined {
  const h = req.headers['x-musterd-seat'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.length > 0 ? v : undefined;
}

const CreateTeamBody = z.object({
  slug: z.string(),
  display: z.string().nullish(),
  creator: z.object({
    name: z.string(),
    kind: z.literal('human').default('human'),
    role: z.string().nullish(),
  }),
});

const AddMemberBody = z.object({
  name: z.string(),
  kind: MemberKindSchema,
  role: z.string().nullish(),
  lifecycle: LifecycleSchema.optional(),
  lifecycle_until: z.number().int().nullish(),
  /** Provision a read-only observer seat (ADR 063), db-only even on a file-backed team. */
  observer: z.boolean().optional(),
});

/**
 * Set the caller's own availability (SPEC A.7; ADR 044). `until` (ms epoch) is only meaningful with
 * `away` (the `away_until` encoding); the server clears it for `available`/`dnd` so the stored shape
 * stays honest. The caller may only set their own seat — availability is never inferred or set by
 * others on localhost (the `can_*` governance is the v0.3 seam).
 */
const AvailabilityBody = z.object({
  status: AvailabilityStatusSchema,
  until: z.number().int().positive().nullish(),
});

const PresenceBody = z.object({
  surface: SurfaceSchema,
  status: PresenceStatusSchema.optional(),
  provenance: ProvenanceSchema.optional(),
  workspace: z.string().max(120).optional(),
  driver: z.string().max(80).optional(),
});

/**
 * Authenticate a request and write an ambient presence touch for the caller (ADR 057): a one-shot
 * authenticated command is itself proof of liveness, so it flips a bursty agent present between watch
 * sockets. A no-op when the member already holds a resident session; on an offline→online transition we
 * emit the same presence event the WS attach path does, so live watchers update. Surface defaults to
 * `cli` but honors `x-musterd-surface` so an adapter one-shot can label its real surface.
 */
function authTouch(
  ctx: Ctx,
  slug: string,
  req: IncomingMessage,
): { team: TeamRow; member: MemberRow } {
  const auth = authMember(ctx.db, slug, bearer(req), actingSeat(req));
  // Observer seats (ADR 063) watch without participating — never flip present, no presence event.
  if (auth.member.observer === 1) return auth;
  // A background poller (the notifier reads inbox on an away human's behalf) opts out: marking them
  // present here would make isReachable see them online and silence the notification (ADR 057).
  if (req.headers['x-musterd-no-touch'] !== undefined) return auth;
  const hint = req.headers['x-musterd-surface'];
  const parsed = SurfaceSchema.safeParse(Array.isArray(hint) ? hint[0] : hint);
  const surface = parsed.success ? parsed.data : 'cli';
  const flipped = touchAmbientPresence(
    ctx.db,
    auth.member.id,
    surface,
    ctx.config.presenceTimeoutMs,
  );
  if (flipped) {
    ctx.hub.broadcastTeam(auth.team.id, {
      type: 'presence',
      member: auth.member.name,
      status: 'online',
    });
  }
  return auth;
}

/**
 * Authorize a **governance** operation (reclaim/remove) on the existing token auth (ADR 071, P2). The
 * caller's effective `is_admin` is required — *except* the empty-admin fallback: a team with zero admins
 * stays on the v0.2 open behaviour so enforcement never breaks an un-migrated team (the fallback is
 * recorded in the audit `detail`). Returns the authed seat + whether the fallback applied.
 */
function authGovernance(
  ctx: Ctx,
  slug: string,
  req: IncomingMessage,
): { team: TeamRow; member: MemberRow; viaFallback: boolean } {
  const { team, member } = authTouch(ctx, slug, req);
  if (resolveCapabilities(member).is_admin) return { team, member, viaFallback: false };
  if (!teamHasAdmin(ctx.db, team.id)) return { team, member, viaFallback: true };
  throw new MusterdError('forbidden', 'this operation requires an admin seat (is_admin)');
}

/** Authorize an **admin-only read** (e.g. the audit log). Strict `is_admin` — no empty-admin fallback,
 *  since there is no prior open behaviour to preserve for a v0.3-only endpoint. */
function authAdmin(
  ctx: Ctx,
  slug: string,
  req: IncomingMessage,
): { team: TeamRow; member: MemberRow } {
  const auth = authMember(ctx.db, slug, bearer(req), actingSeat(req));
  if (!resolveCapabilities(auth.member).is_admin)
    throw new MusterdError('forbidden', 'this resource is admin-only (visibility_level: admin)');
  return auth;
}

/** Best-effort: resolve the calling seat from a bearer token if one is present and valid, else null.
 *  Used by the roster reads to scope the projection (ADR 071) without making them require auth. */
function tryAuth(ctx: Ctx, slug: string, req: IncomingMessage): MemberRow | null {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    return authMember(ctx.db, slug, h.slice('Bearer '.length).trim(), actingSeat(req)).member;
  } catch {
    return null;
  }
}

/**
 * Project the roster, **scoped to the viewer's `visibility_level`** (ADR 071, P2). An `admin` viewer (or
 * the seat looking at *itself*) sees the full `Member` incl. effective `capabilities`; a `team`-level
 * viewer (or an unauthenticated read) gets the need-to-know projection — every seat's handle, kind, role,
 * presence, availability, and account_status, but **not** other seats' capabilities (the authority map:
 * who is admin, who is muted, who is narrowed). Permissive by default — no token still yields a usable
 * roster, just without the authority detail that only an admin dashboard needs.
 */
function summarize(
  ctx: Ctx,
  teamSlug: string,
  teamId: string,
  viewer: MemberRow | null = null,
): MemberSummary[] {
  const viewerIsAdmin = viewer ? resolveCapabilities(viewer).is_admin : false;
  return listPresence(ctx.db, teamId, ctx.config.presenceTimeoutMs).map((s) => {
    // Two-clocks rule (M2): liveness from presence, working-label from the latest status_update.
    const activity = resolveActivity(
      s.status !== 'offline',
      latestStatusUpdate(ctx.db, s.member.id),
    );
    const member = toMember(s.member, teamSlug);
    const seesCaps = viewerIsAdmin || viewer?.id === s.member.id;
    const { capabilities: _caps, ...needToKnow } = member;
    return {
      ...(seesCaps ? member : needToKnow),
      presence: s.status,
      presences: s.presences,
      ...activity,
    };
  });
}

/** Dispatch an HTTP request. Returns true if it handled the request (always, except non-matching upgrade). */
export async function handleHttp(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      // db + schema are exposed so clients can confirm *which* database this daemon serves
      // (a daemon silently serving the wrong db reads as "everyone offline" — dogfood finding).
      // `connections` is the cross-team live-session count the CLI's `service stop|restart` guard
      // reads before bouncing a shared daemon out from under a teammate (ADR 047).
      return sendJson(res, 200, {
        ok: true,
        v: PROTOCOL_VERSION,
        db: ctx.config.dbPath,
        schema: schemaVersion(ctx.db),
        connections: countLivePresences(ctx.db, ctx.config.presenceTimeoutMs),
      });
    }

    if (method === 'POST' && path === '/teams') {
      const body = parseOrBadRequest(CreateTeamBody, await readJson(req));
      const team = createTeam(ctx.db, { slug: body.slug, display: body.display ?? null });
      const { row, token } = addMember(ctx.db, team, {
        name: body.creator.name,
        kind: 'human',
        role: body.creator.role ?? '',
      });
      // Creator-admin default (ADR 071, P2): the creator's human seat is the team's first admin, so the
      // governance routes have an authority from birth (the ADR 070 stated default, implemented here).
      // The team is db-only at create time (no seat-file yet), so this write is uncontended by reconcile;
      // a later `team export` carries the resolved caps into the creator's seat-file.
      setMemberGovernance(
        ctx.db,
        row.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );
      const creator = getMemberById(ctx.db, row.id) ?? row;
      // v0.3 P3 composite mint (SPEC A.7): the team agent key (agents present it to claim a seat) + the
      // creator's human credential (the admin authenticates with it) + the default policy. Each secret is
      // shown ONCE. Additive during the flip — `member`/`token` stay until the cutover removes hello/token;
      // `seat` is the A.7 name (== member in the transition). `agent_key`/`human_credential` are inert
      // until the claim handler (ADR 077) is wired, so this stays Model-B-additive.
      const { agent_key } = rotateAgentKey(ctx.db, team.id);
      const { credential } = mintCredential(ctx.db, creator.id);
      return sendJson(res, 201, {
        team: { id: team.id, slug: team.slug, display: team.display },
        member: toMember(creator, team.slug),
        seat: toMember(creator, team.slug),
        token,
        human_credential: credential,
        agent_key,
        policy: getPolicy(ctx.db, team.id),
      });
    }

    const teamMatch = path.match(/^\/teams\/([^/]+)(\/.*)?$/);
    if (teamMatch) {
      const slug = decodeURIComponent(teamMatch[1]!);
      const rest = teamMatch[2] ?? '';

      if (method === 'GET' && rest === '') {
        const team = requireTeam(ctx.db, slug);
        return sendJson(res, 200, {
          team: { id: team.id, slug: team.slug, display: team.display },
          members: summarize(ctx, slug, team.id, tryAuth(ctx, slug, req)),
        });
      }

      if (method === 'POST' && rest === '/members') {
        const body = parseOrBadRequest(AddMemberBody, await readJson(req));
        // ADR 058 project-and-return: for a *file-backed* team the file is the single writer — the CLI
        // has already written `seats/<name>.toml`; the daemon reconciles it and hands back the token,
        // never originating the seat. A *db-only* team (no roster root declares it) keeps the legacy
        // originate path — per-team cutover (migration-bootstrap.md), so un-migrated teams + their
        // tests are untouched.
        //
        // Resolve roots *fresh* per call (union with the boot-time set): a team exported after the
        // daemon started isn't in `ctx.rosterRoots` yet, but its `rosterHome` is already in the global
        // config — so without this, provisioning would fall through to the legacy originate path and
        // double-source a seat that also lives in a file. Re-reading a small JSON on an infrequent
        // provisioning call is cheap; the boot/watch reconcile catch up on the next reload (SIGHUP).
        // Observers (ADR 063) are runtime watchers, not durable seat files — always provision them
        // db-only, even on a file-backed team, bypassing the seat-file projection below.
        const roots = body.observer
          ? []
          : [...new Set([...ctx.rosterRoots, ...resolveRosterRoots()])];
        const spec = teamSpecForSlug(roots, slug);
        if (spec) {
          const result = reconcileTeam(ctx.db, spec);
          const team = requireTeam(ctx.db, slug);
          const row = getMemberByName(ctx.db, team.id, body.name);
          if (!row || row.left_at !== null) {
            throw new MusterdError(
              'not_found',
              `no seat "${body.name}" is declared in ${slug}'s roster files — write seats/${body.name}.toml first (the file is the source of truth)`,
            );
          }
          // Token: minted this pass (a fresh seat) → return it. Already projected (e.g. via git pull)
          // → mint a fresh one if the seat is unheld; refuse if a teammate already holds it (adopt
          // with `claim --token`).
          let token = result.minted[body.name];
          if (!token) {
            if (isHeld(row)) {
              throw new MusterdError(
                'conflict',
                `seat "${body.name}" in "${slug}" is already held — adopt it with \`claim ${body.name} --token <code>\` or take a pool seat`,
              );
            }
            token = rotateToken(ctx.db, row.id);
          }
          return sendJson(res, 201, { member: toMember(row, team.slug), token });
        }
        const team = requireTeam(ctx.db, slug);
        const { row, token } = addMember(ctx.db, team, {
          name: body.name,
          kind: body.kind,
          role: body.role ?? '',
          ...(body.lifecycle ? { lifecycle: body.lifecycle } : {}),
          lifecycleUntil: body.lifecycle_until ?? null,
          ...(body.observer ? { observer: true } : {}),
        });
        return sendJson(res, 201, { member: toMember(row, team.slug), token });
      }

      if (method === 'GET' && rest === '/members') {
        const team = requireTeam(ctx.db, slug);
        return sendJson(res, 200, {
          members: summarize(ctx, slug, team.id, tryAuth(ctx, slug, req)),
        });
      }

      // The governance audit log (ADR 071, P2) — admin-only, since it exposes who-did-what across the
      // team. Newest-first, capped; `?limit=` and `?before=<ts>` page older entries. `detail` is parsed
      // back to an object for the client.
      if (method === 'GET' && rest === '/audit') {
        const { team } = authAdmin(ctx, slug, req);
        const limit = Number(url.searchParams.get('limit') ?? '');
        const before = Number(url.searchParams.get('before') ?? '');
        const rows = listAudit(ctx.db, team.id, {
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          ...(Number.isFinite(before) && before > 0 ? { before } : {}),
        });
        return sendJson(res, 200, {
          audit: rows.map((r) => ({
            id: r.id,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            target: r.target,
            result: r.result,
            detail: r.detail ? JSON.parse(r.detail) : null,
          })),
        });
      }

      // P3.2 request lane (ADR 077) — claim requests + admin decide. Strict is_admin.
      if (method === 'GET' && rest === '/requests') {
        const { team } = authAdmin(ctx, slug, req);
        const pendingOnly = url.searchParams.get('status') === 'pending';
        const requests = listRequests(ctx.db, team.id, { pendingOnly });
        return sendJson(res, 200, { requests });
      }

      const requestDecideMatch = rest.match(/^\/requests\/([^/]+)\/decide$/);
      if (method === 'POST' && requestDecideMatch) {
        const { team, member: admin } = authAdmin(ctx, slug, req);
        const requestId = decodeURIComponent(requestDecideMatch[1]!);
        const body = parseOrBadRequest(DecideRequestSchema, await readJson(req));
        const existing = getRequest(ctx.db, team.id, requestId);
        if (!existing) throw new MusterdError('not_found', `no request "${requestId}"`);
        if (existing.status !== 'pending')
          throw new MusterdError(
            'conflict',
            `request "${requestId}" is already ${existing.status}`,
          );

        if (body.decision === 'approve') {
          // Resolve the target member from the encoded target string.
          let targetMember: MemberRow | null = null;
          if (existing.target) {
            if (existing.target.startsWith('seat:')) {
              const seatName = existing.target.slice(5);
              targetMember = getMemberByName(ctx.db, team.id, seatName) ?? null;
            } else if (existing.target.startsWith('role:')) {
              const roleName = existing.target.slice(5);
              targetMember =
                ctx.db
                  .prepare<
                    [string, string],
                    MemberRow
                  >('SELECT * FROM members WHERE team_id = ? AND role = ? AND left_at IS NULL LIMIT 1')
                  .get(team.id, roleName) ?? null;
            }
          }
          if (!targetMember) {
            throw new MusterdError(
              'not_found',
              `target member not found for request "${requestId}"`,
            );
          }

          // Account-status check before approving.
          const status = resolveAccountStatus(targetMember);
          if (status === 'disabled' || status === 'banned') {
            throw new MusterdError('forbidden', `seat "${targetMember.name}" is ${status}`);
          }

          // Issue a grant so the approved session can occupy the seat.
          const mint = issueGrant(
            ctx.db,
            team.id,
            {
              scope: existing.target?.startsWith('role:') ? 'role' : 'seat',
              target: targetMember.name,
              lifetime: body.lifetime,
              ...(body.lifetime === 'ttl' && body.ttl_hours != null
                ? { ttl_hours: body.ttl_hours }
                : {}),
              single_use: body.lifetime === 'once',
            },
            admin.name,
          );

          // Attach presence for the approved session.
          const presence = attach(
            ctx.db,
            targetMember.id,
            existing.surface as import('@musterd/protocol').Surface,
            existing.from_session,
            { provenance: null, workspace: null, driver: null },
          );

          // Settle the request.
          decideRequest(ctx.db, team.id, requestId, 'approved', admin.name);

          // Flip the waiting WS: find the pending connection and call _claimApproved.
          const pendingConn = ctx.hub.getConn(existing.from_session);
          if (pendingConn?._claimApproved) {
            pendingConn._claimApproved(presence.id);
          }

          // Push the terminal occupied frame to the waiting WS.
          const delivered = ctx.hub.deliverClaimDecision(existing.from_session, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            memory: null,
          });

          // Broadcast presence online for non-observers.
          if (targetMember.observer !== 1) {
            ctx.hub.broadcastTeam(
              team.id,
              { type: 'presence', member: targetMember.name, status: 'online' },
              undefined,
            );
          }

          appendAudit(ctx.db, team.id, {
            actor: admin.name,
            action: 'request.decide',
            target: targetMember.name,
            result: 'allow',
            detail: { decision: 'approve', request_id: requestId, delivered },
          });
          // Also consume the grant if once (it was issued for the seat; the approve itself IS the use).
          if (body.lifetime === 'once') consumeGrant(ctx.db, mint.grant.id);
          return sendJson(res, 200, {
            request_id: requestId,
            decision: 'approve',
            delivered,
          });
        } else {
          // Deny: settle the request and push a refused frame to the waiting WS.
          decideRequest(ctx.db, team.id, requestId, 'denied', admin.name);
          const delivered = ctx.hub.deliverClaimDecision(existing.from_session, {
            type: 'refused',
            code: 'forbidden',
            message: `your claim request was denied by ${admin.name}`,
            claimable: [],
            hint: `contact ${admin.name} for details`,
          });
          appendAudit(ctx.db, team.id, {
            actor: admin.name,
            action: 'request.decide',
            target: existing.target,
            result: 'deny',
            detail: { decision: 'deny', request_id: requestId, delivered },
          });
          return sendJson(res, 200, { request_id: requestId, decision: 'deny', delivered });
        }
      }

      // v0.3 P3.1 governance admin endpoints (ADR 076) — strict is_admin (authAdmin, no fallback),
      // each audited. The grant/key/policy substrate; additive (the claim flow that consumes grants
      // is P3.2 / the cutover). Secrets (msgr_/mskey_) are returned once and never re-fetchable.
      if (method === 'GET' && rest === '/grants') {
        const { team } = authAdmin(ctx, slug, req);
        return sendJson(res, 200, { grants: listGrants(ctx.db, team.id) });
      }

      if (method === 'POST' && rest === '/grants') {
        const { team, member } = authAdmin(ctx, slug, req);
        const body = parseOrBadRequest(IssueGrantSchema, await readJson(req));
        const mint = issueGrant(ctx.db, team.id, body, member.name);
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'grant.issue',
          target: body.target,
          result: 'allow',
          detail: { scope: body.scope, lifetime: body.lifetime },
        });
        return sendJson(res, 201, mint);
      }

      const grantMatch = rest.match(/^\/grants\/([^/]+)$/);
      if (method === 'DELETE' && grantMatch) {
        const grantId = decodeURIComponent(grantMatch[1]!);
        const { team, member } = authAdmin(ctx, slug, req);
        if (!revokeGrant(ctx.db, team.id, grantId)) {
          throw new MusterdError('not_found', `no active grant "${grantId}" on ${slug}`);
        }
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'grant.revoke',
          target: grantId,
          result: 'allow',
        });
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && rest === '/agent-key/rotate') {
        const { team, member } = authAdmin(ctx, slug, req);
        const mint = rotateAgentKey(ctx.db, team.id);
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'key.rotate',
          target: null,
          result: 'allow',
        });
        return sendJson(res, 200, mint);
      }

      if (method === 'POST' && rest === '/policy') {
        const { team, member } = authAdmin(ctx, slug, req);
        const policy = setPolicy(
          ctx.db,
          team.id,
          parseOrBadRequest(PolicySchema, await readJson(req)),
        );
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'policy.change',
          target: null,
          result: 'allow',
          detail: policy,
        });
        return sendJson(res, 200, { policy });
      }

      // P3.2 stateless claim mirror (SPEC A.7, ADR 077) — unauthenticated (key in body, not Bearer).
      // Response bodies ARE the WS frame shapes: 200=occupied, 202=pending, 4xx=refused.
      if (method === 'POST' && rest === '/claim') {
        const ClaimBody = z.object({
          key: z.string(),
          target: ClaimTargetSchema,
          grant: z.string().optional(),
          surface: SurfaceSchema,
        });
        const body = parseOrBadRequest(ClaimBody, await readJson(req));
        const team = requireTeam(ctx.db, slug);

        // Step 1: verify key (agent key or human credential).
        let authenticatedMember: MemberRow | null = null;
        const keyHash = getAgentKeyHash(ctx.db, team.id);
        if (!keyHash || hashToken(body.key) !== keyHash) {
          authenticatedMember =
            ctx.db
              .prepare<
                [string, string],
                MemberRow
              >("SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind = 'human'")
              .get(team.id, hashToken(body.key)) ?? null;
          if (!authenticatedMember) {
            return sendJson(res, 403, {
              type: 'refused',
              code: 'forbidden',
              message: 'invalid key — present a valid agent key or human credential',
              claimable: [],
              hint: `POST /teams/${slug}/claim with a valid mskey_ or mscr_ key`,
            });
          }
        }

        // Step 2: resolve target member.
        let targetMember: MemberRow | null = null;
        if ('seat' in body.target) {
          targetMember = getMemberByName(ctx.db, team.id, body.target.seat) ?? null;
          if (!targetMember || targetMember.left_at !== null) {
            return sendJson(res, 404, {
              type: 'refused',
              code: 'not_found',
              message: `no seat "${body.target.seat}" in team "${slug}"`,
              claimable: [],
              hint: `musterd team members --team ${slug}`,
            });
          }
          if (authenticatedMember && authenticatedMember.id !== targetMember.id) {
            return sendJson(res, 403, {
              type: 'refused',
              code: 'forbidden',
              message: `credential identifies "${authenticatedMember.name}", not "${body.target.seat}"`,
              claimable: [authenticatedMember.name],
              hint: `musterd claim ${authenticatedMember.name}`,
            });
          }
        } else if ('role' in body.target) {
          targetMember =
            ctx.db
              .prepare<
                [string, string],
                MemberRow
              >('SELECT * FROM members WHERE team_id = ? AND role = ? AND left_at IS NULL LIMIT 1')
              .get(team.id, body.target.role) ?? null;
          if (!targetMember) {
            return sendJson(res, 404, {
              type: 'refused',
              code: 'not_found',
              message: `no seats with role "${body.target.role}" in team "${slug}"`,
              claimable: [],
              hint: `musterd team members --team ${slug}`,
            });
          }
        } else {
          // observe: not supported in stateless HTTP path (no session to push to later)
          return sendJson(res, 403, {
            type: 'refused',
            code: 'forbidden',
            message: 'observe target not supported via HTTP claim — use WS claim',
            claimable: [],
            hint: 'open a WS connection and send a claim frame with { observe: true }',
          });
        }

        // Step 3: account_status check.
        const acctStatus = resolveAccountStatus(targetMember);
        if (acctStatus === 'disabled' || acctStatus === 'banned') {
          return sendJson(res, 403, {
            type: 'refused',
            code: acctStatus,
            message: `seat "${targetMember.name}" is ${acctStatus}`,
            claimable: [],
            hint: 'contact a team admin to re-enable this seat',
          });
        }

        // Step 4: single-active is kind-scoped (ADR 042), matching the WS path. An **agent** seat is
        // newest-wins (ADR 017): a newer claim displaces the incumbent (superseded → close its socket +
        // clear its presence) instead of refusing. A **human**/observer seat fans out — no displacement,
        // a second claim just attaches another presence.
        const liveConns = ctx.hub.connsForMember(targetMember.id);
        if (liveConns.length > 0 && targetMember.kind === 'agent' && targetMember.observer === 0) {
          for (const old of liveConns) {
            old.send?.({
              type: 'error',
              code: 'superseded',
              message: `your session as "${targetMember.name}" was taken over by a newer one`,
            });
            old.close?.();
            ctx.hub.remove(old.connId);
          }
          clearMemberPresence(ctx.db, targetMember.id);
        }

        // Step 5: grant path — validate + consume, then occupy.
        if (body.grant) {
          const gv = validateGrant(ctx.db, team.id, body.grant);
          if (!gv.ok) {
            const code = gv.reason === 'expired' ? 'expired_grant' : 'forbidden';
            return sendJson(res, 403, {
              type: 'refused',
              code,
              message: `grant ${gv.reason}`,
              claimable: [],
              hint: 'request a new grant from a team admin',
            });
          }
          const grantTarget = gv.grant.target;
          const targetOk =
            ('seat' in body.target &&
              gv.grant.scope === 'seat' &&
              grantTarget === body.target.seat) ||
            ('role' in body.target &&
              gv.grant.scope === 'role' &&
              grantTarget === body.target.role);
          if (!targetOk) {
            return sendJson(res, 403, {
              type: 'refused',
              code: 'forbidden',
              message: `grant is for ${gv.grant.scope} "${grantTarget}", not your target`,
              claimable: [],
              hint: 'request a grant that matches your target seat/role',
            });
          }
          consumeGrant(ctx.db, gv.grant.id);
          // OCCUPY: stateless — attach presence with null connId (no persistent socket).
          const presence = attach(ctx.db, targetMember.id, body.surface, null, {
            provenance: null,
            workspace: null,
            driver: null,
          });
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.occupied',
            target: targetMember.name,
            result: 'allow',
            detail: { via: 'http', surface: body.surface },
          });
          ctx.hub.broadcastTeam(
            team.id,
            { type: 'presence', member: targetMember.name, status: 'online' },
            undefined,
          );
          return sendJson(res, 200, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            memory: null,
          });
        }

        // Credential self-authorize (ADR 077, SPEC A.2): a human authenticated by their OWN mscr_
        // credential claiming their own seat is self-authorizing — the credential IS the authorization,
        // so there is no grant and no admin-approval request. Occupy directly (Step 2 already enforced
        // the credential matches the target seat for a seat-target claim).
        if (authenticatedMember && authenticatedMember.id === targetMember.id) {
          const presence = attach(ctx.db, targetMember.id, body.surface, null, {
            provenance: null,
            workspace: null,
            driver: null,
          });
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.occupied',
            target: targetMember.name,
            result: 'allow',
            detail: { via: 'http', surface: body.surface, auth: 'credential' },
          });
          ctx.hub.broadcastTeam(
            team.id,
            { type: 'presence', member: targetMember.name, status: 'online' },
            undefined,
          );
          return sendJson(res, 200, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            memory: null,
          });
        }

        // Step 6: no grant → create request, return 202 pending.
        const encodedTarget =
          'seat' in body.target
            ? `seat:${body.target.seat}`
            : 'role' in body.target
              ? `role:${body.target.role}`
              : 'observe';
        const claimReq = createRequest(ctx.db, team.id, {
          kind: 'claim',
          from_session: `http:${ulid()}`,
          target: encodedTarget,
          surface: body.surface,
        });
        appendAudit(ctx.db, team.id, {
          actor: null,
          action: 'claim.pending',
          target: targetMember.name,
          result: 'allow',
          detail: { via: 'http', request_id: claimReq.id, surface: body.surface },
        });
        ctx.hub.deliverToAdmins(team.id, {
          type: 'pending',
          request_id: claimReq.id,
          message: `HTTP seat claim from ${body.surface}: ${encodedTarget}`,
        });
        return sendJson(res, 202, {
          type: 'pending',
          request_id: claimReq.id,
          message: `claim request opened — waiting for admin approval (poll GET /teams/${slug}/requests/${claimReq.id})`,
        });
      }

      if (method === 'POST' && rest === '/messages') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = (await readJson(req)) as { envelope?: unknown };
        const env = parseEnvelope(body.envelope);
        const result = routeEnvelope(ctx, team, member, env);
        const ack = rowToEnvelope(
          result.message,
          team.slug,
          member.name,
          env.to.kind === 'member' ? env.to.name : null,
        );
        return sendJson(res, 201, { ack });
      }

      if (method === 'GET' && rest === '/inbox') {
        const { team, member } = authTouch(ctx, slug, req);
        const unread = url.searchParams.get('unread') === '1';
        const since = url.searchParams.get('since');
        const cursor = getCursor(ctx.db, member.id);
        const rows = listInbox(ctx.db, member, {
          unreadOnly: unread,
          cursorTs: cursor.last_read_ts,
          ...(since ? { since: Number(since) } : {}),
        });
        const messages = rows.map((r) => {
          const from = getMemberById(ctx.db, r.from_member);
          const to = r.to_member ? getMemberById(ctx.db, r.to_member) : null;
          return rowToEnvelope(r, team.slug, from?.name ?? '?', to?.name ?? null);
        });
        return sendJson(res, 200, { messages, cursor });
      }

      // The whole team timeline — every envelope, not just the caller's inbox — for the firehose's
      // history backfill (ADR 061). The dashboard GETs this, then live-tails via `subscribe team-all`.
      // Authed like /inbox (any team member); read-only.
      if (method === 'GET' && rest === '/messages') {
        const { team } = authTouch(ctx, slug, req);
        const since = url.searchParams.get('since');
        const limit = url.searchParams.get('limit');
        const rows = listTeamMessages(ctx.db, team.id, {
          ...(since ? { since: Number(since) } : {}),
          ...(limit ? { limit: Math.min(Math.max(Number(limit), 1), 1000) } : {}),
        });
        const messages = rows.map((r) => {
          const from = getMemberById(ctx.db, r.from_member);
          const to = r.to_member ? getMemberById(ctx.db, r.to_member) : null;
          return rowToEnvelope(r, team.slug, from?.name ?? '?', to?.name ?? null);
        });
        return sendJson(res, 200, { messages });
      }

      if (method === 'POST' && rest === '/inbox/cursor') {
        const { member } = authTouch(ctx, slug, req);
        const body = (await readJson(req)) as { last_read_message_id?: string };
        if (!body.last_read_message_id)
          throw new MusterdError('bad_request', 'last_read_message_id required');
        const row = ctx.db
          .prepare<[string], { ts: number }>('SELECT ts FROM messages WHERE id = ?')
          .get(body.last_read_message_id);
        if (!row) throw new MusterdError('not_found', 'unknown message id');
        const cursor = setCursor(ctx.db, member.id, body.last_read_message_id, row.ts);
        return sendJson(res, 200, { cursor });
      }

      if (method === 'POST' && rest === '/presence') {
        const { member } = authMember(ctx.db, slug, bearer(req), actingSeat(req));
        const body = parseOrBadRequest(PresenceBody, await readJson(req));
        const p = attach(ctx.db, member.id, body.surface, null, {
          provenance: body.provenance ?? null,
          workspace: body.workspace ?? null,
          driver: body.driver ?? null,
        });
        if (body.status) {
          ctx.db.prepare('UPDATE presence SET status = ? WHERE id = ?').run(body.status, p.id);
        }
        return sendJson(res, 200, {
          presence: { id: p.id, surface: p.surface, status: body.status ?? p.status },
          member: member.name,
        });
      }

      if (method === 'POST' && rest === '/availability') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(AvailabilityBody, await readJson(req));
        // `until` rides only `away` (the away_until encoding); drop it otherwise so the stored shape
        // can't claim "back at 5pm" while available/dnd.
        const availability =
          body.status === 'away' && body.until != null
            ? { status: body.status, until: body.until }
            : { status: body.status };
        setAvailability(ctx.db, member.id, availability);
        const me = summarize(ctx, team.slug, team.id, member).find((m) => m.name === member.name);
        return sendJson(res, 200, { member: me });
      }

      // Operator escape hatch (ADR 017 follow-up): forcibly drop a member's live session so it can
      // rejoin — for a stuck/orphaned presence newest-wins can't displace (no new session is coming).
      // Admin-gated (ADR 071, P2) with the empty-admin fallback so an un-migrated team keeps the hatch.
      const reclaimMatch = rest.match(/^\/members\/([^/]+)\/reclaim$/);
      if (method === 'POST' && reclaimMatch) {
        const { team, member: caller, viaFallback } = authGovernance(ctx, slug, req);
        const targetName = decodeURIComponent(reclaimMatch[1]!);
        const target = getMemberByName(ctx.db, team.id, targetName);
        if (!target || target.left_at !== null)
          throw new MusterdError('not_found', `no member "${targetName}" in ${slug}`);
        // Displace any live session (same mechanism as a newer hello), then free the seat + go offline.
        for (const old of ctx.hub.connsForMember(target.id)) {
          old.send({
            type: 'error',
            code: 'superseded',
            message: `your session as "${target.name}" was reclaimed by an operator`,
          });
          old.close?.();
          ctx.hub.remove(old.connId);
        }
        clearMemberPresence(ctx.db, target.id);
        // Operator reclaim also force-frees the seat's *held* state (ADR 058) — back to declared, so a
        // fresh `claim` (without --token) may rotate it; the durable seat file is untouched.
        clearBound(ctx.db, target.id);
        ctx.hub.broadcastTeam(team.id, {
          type: 'presence',
          member: target.name,
          status: 'offline',
        });
        appendAudit(ctx.db, team.id, {
          actor: caller.name,
          action: 'member.reclaim',
          target: target.name,
          result: 'allow',
          ...(viaFallback ? { detail: { fallback: 'no-admin' } } : {}),
        });
        return sendJson(res, 200, { ok: true, member: target.name });
      }

      // `unbind` (ADR 058): the *holder* voluntarily stops occupying its own seat — clear `bound_at`
      // (back to declared) + drop presence, so the seat is freely re-claimable while its durable file
      // stays on the team. Self-only: authed by the caller's own token, no target name. Distinct from
      // `remove` (deletes the seat) and `reclaim` (operator force-frees someone else's).
      if (method === 'POST' && rest === '/unbind') {
        // authMember (not authTouch) so we don't write an ambient presence row we're about to clear.
        const { team, member } = authMember(ctx.db, slug, bearer(req), actingSeat(req));
        for (const old of ctx.hub.connsForMember(member.id)) {
          old.close?.();
          ctx.hub.remove(old.connId);
        }
        clearMemberPresence(ctx.db, member.id);
        clearBound(ctx.db, member.id);
        ctx.hub.broadcastTeam(team.id, {
          type: 'presence',
          member: member.name,
          status: 'offline',
        });
        return sendJson(res, 200, { ok: true, member: member.name });
      }

      // Soft-remove a member from the roster (ADR 019): set left_at so it drops off every
      // list/auth/route path (all filter `left_at IS NULL`) while message history + provenance
      // survive. Idempotent — an already-left member 404s rather than erroring. Admin-gated (ADR 071,
      // P2) with the same empty-admin fallback as reclaim.
      const removeMatch = rest.match(/^\/members\/([^/]+)\/remove$/);
      if (method === 'POST' && removeMatch) {
        const { team, member: caller, viaFallback } = authGovernance(ctx, slug, req);
        const targetName = decodeURIComponent(removeMatch[1]!);
        const target = getMemberByName(ctx.db, team.id, targetName);
        if (!target || target.left_at !== null)
          throw new MusterdError('not_found', `no member "${targetName}" in ${slug}`);
        leaveMember(ctx.db, target.id);
        // Free the seat immediately: drop any live session (same mechanism as reclaim) so removal
        // doesn't leave a zombie presence holding a name that's no longer on the roster.
        for (const old of ctx.hub.connsForMember(target.id)) {
          old.send({
            type: 'error',
            code: 'superseded',
            message: `your session as "${target.name}" was removed by an operator`,
          });
          old.close?.();
          ctx.hub.remove(old.connId);
        }
        clearMemberPresence(ctx.db, target.id);
        ctx.hub.broadcastTeam(team.id, {
          type: 'presence',
          member: target.name,
          status: 'offline',
        });
        appendAudit(ctx.db, team.id, {
          actor: caller.name,
          action: 'member.remove',
          target: target.name,
          result: 'allow',
          ...(viaFallback ? { detail: { fallback: 'no-admin' } } : {}),
        });
        return sendJson(res, 200, { ok: true, member: target.name, kind: target.kind });
      }
    }

    // Static web UI (ADR 062): serve same-origin for any unmatched GET outside the API namespaces,
    // so the daemon hosts the dashboard with no proxy/CORS. API paths still 404 as JSON.
    if (
      method === 'GET' &&
      ctx.config.webRoot &&
      path !== '/health' &&
      !path.startsWith('/teams')
    ) {
      return serveStatic(ctx.config.webRoot, path, res);
    }

    throw new MusterdError('not_found', `no route for ${method} ${path}`);
  } catch (err) {
    sendError(res, err);
  }
}
