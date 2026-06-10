import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MemberKindSchema,
  LifecycleSchema,
  SurfaceSchema,
  PresenceStatusSchema,
  PROTOCOL_VERSION,
  type MemberSummary,
} from '@musterd/protocol';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { parseEnvelope, parseOrBadRequest } from '../protocol/validate.js';
import { routeEnvelope } from '../protocol/route.js';
import { getCursor, setCursor } from '../store/cursors.js';
import { addMember, authMember, getMemberById } from '../store/members.js';
import { listInbox, rowToEnvelope } from '../store/messages.js';
import { attach, listPresence } from '../store/presence.js';
import { toMember } from '../store/rows.js';
import { createTeam, requireTeam } from '../store/teams.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  const me = asMusterdError(err);
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
  if (!h || !h.startsWith('Bearer ')) throw new MusterdError('unauthorized', 'missing bearer token');
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

const PresenceBody = z.object({
  surface: SurfaceSchema,
  status: PresenceStatusSchema.optional(),
});

function summarize(ctx: Ctx, teamSlug: string, teamId: string): MemberSummary[] {
  return listPresence(ctx.db, teamId, ctx.config.presenceTimeoutMs).map((s) => ({
    ...toMember(s.member, teamSlug),
    presence: s.status,
    presences: s.presences,
  }));
}

/** Dispatch an HTTP request. Returns true if it handled the request (always, except non-matching upgrade). */
export async function handleHttp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, v: PROTOCOL_VERSION });
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
        return sendJson(res, 200, { team: { id: team.id, slug: team.slug, display: team.display }, members: summarize(ctx, slug, team.id) });
      }

      if (method === 'POST' && rest === '/members') {
        const team = requireTeam(ctx.db, slug);
        const body = parseOrBadRequest(AddMemberBody, await readJson(req));
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
        const { team, member } = authMember(ctx.db, slug, bearer(req));
        const body = (await readJson(req)) as { envelope?: unknown };
        const env = parseEnvelope(body.envelope);
        const result = routeEnvelope(ctx, team, member, env);
        const ack = rowToEnvelope(result.message, team.slug, member.name, env.to.kind === 'member' ? env.to.name : null);
        return sendJson(res, 201, { ack });
      }

      if (method === 'GET' && rest === '/inbox') {
        const { team, member } = authMember(ctx.db, slug, bearer(req));
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
        const { member } = authMember(ctx.db, slug, bearer(req));
        const body = (await readJson(req)) as { last_read_message_id?: string };
        if (!body.last_read_message_id) throw new MusterdError('bad_request', 'last_read_message_id required');
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
        const p = attach(ctx.db, member.id, body.surface, null);
        if (body.status) {
          ctx.db.prepare('UPDATE presence SET status = ? WHERE id = ?').run(body.status, p.id);
        }
        return sendJson(res, 200, { presence: { id: p.id, surface: p.surface, status: body.status ?? p.status } });
      }
    }

    throw new MusterdError('not_found', `no route for ${method} ${path}`);
  } catch (err) {
    sendError(res, err);
  }
}
