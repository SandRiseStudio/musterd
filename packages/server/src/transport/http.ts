import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MemberKindSchema,
  LifecycleSchema,
  SurfaceSchema,
  PresenceStatusSchema,
  ProvenanceSchema,
  AvailabilityStatusSchema,
  PROTOCOL_VERSION,
  type MemberSummary,
} from '@musterd/protocol';
import { z } from 'zod';
import { resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { reconcileTeam, teamSpecForSlug } from '../projection/reconcile.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope, parseOrBadRequest } from '../protocol/validate.js';
import { resolveActivity } from '../store/activity.js';
import { getCursor, setCursor } from '../store/cursors.js';
import {
  addMember,
  authMember,
  clearBound,
  getMemberById,
  getMemberByName,
  isHeld,
  leaveMember,
  rotateToken,
  setAvailability,
} from '../store/members.js';
import { latestStatusUpdate, listInbox, rowToEnvelope } from '../store/messages.js';
import {
  attach,
  clearMemberPresence,
  countLivePresences,
  listPresence,
  touchAmbientPresence,
} from '../store/presence.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { toMember } from '../store/rows.js';
import { createTeam, requireTeam } from '../store/teams.js';
import { recordError } from '../telemetry.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
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
  const auth = authMember(ctx.db, slug, bearer(req));
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

function summarize(ctx: Ctx, teamSlug: string, teamId: string): MemberSummary[] {
  return listPresence(ctx.db, teamId, ctx.config.presenceTimeoutMs).map((s) => {
    // Two-clocks rule (M2): liveness from presence, working-label from the latest status_update.
    const activity = resolveActivity(
      s.status !== 'offline',
      latestStatusUpdate(ctx.db, s.member.id),
    );
    return {
      ...toMember(s.member, teamSlug),
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
      return sendJson(res, 201, {
        team: { id: team.id, slug: team.slug, display: team.display },
        member: toMember(row, team.slug),
        token,
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
          members: summarize(ctx, slug, team.id),
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
        const roots = [...new Set([...ctx.rosterRoots, ...resolveRosterRoots()])];
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
        });
        return sendJson(res, 201, { member: toMember(row, team.slug), token });
      }

      if (method === 'GET' && rest === '/members') {
        const team = requireTeam(ctx.db, slug);
        return sendJson(res, 200, { members: summarize(ctx, slug, team.id) });
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
        const { member } = authMember(ctx.db, slug, bearer(req));
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
        const me = summarize(ctx, team.slug, team.id).find((m) => m.name === member.name);
        return sendJson(res, 200, { member: me });
      }

      // Operator escape hatch (ADR 017 follow-up): forcibly drop a member's live session so it can
      // rejoin — for a stuck/orphaned presence newest-wins can't displace (no new session is coming).
      // localhost-only/v0.2: any team member may reclaim any member; the v0.3 seat model will gate this.
      const reclaimMatch = rest.match(/^\/members\/([^/]+)\/reclaim$/);
      if (method === 'POST' && reclaimMatch) {
        const { team } = authTouch(ctx, slug, req);
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
        return sendJson(res, 200, { ok: true, member: target.name });
      }

      // `unbind` (ADR 058): the *holder* voluntarily stops occupying its own seat — clear `bound_at`
      // (back to declared) + drop presence, so the seat is freely re-claimable while its durable file
      // stays on the team. Self-only: authed by the caller's own token, no target name. Distinct from
      // `remove` (deletes the seat) and `reclaim` (operator force-frees someone else's).
      if (method === 'POST' && rest === '/unbind') {
        // authMember (not authTouch) so we don't write an ambient presence row we're about to clear.
        const { team, member } = authMember(ctx.db, slug, bearer(req));
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
      // survive. Idempotent — an already-left member 404s rather than erroring. Like reclaim, this
      // is ungated on localhost-only v0.2; the v0.3 seat model will govern who may remove whom.
      const removeMatch = rest.match(/^\/members\/([^/]+)\/remove$/);
      if (method === 'POST' && removeMatch) {
        const { team } = authTouch(ctx, slug, req);
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
        return sendJson(res, 200, { ok: true, member: target.name, kind: target.kind });
      }
    }

    throw new MusterdError('not_found', `no route for ${method} ${path}`);
  } catch (err) {
    sendError(res, err);
  }
}
