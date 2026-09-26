import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { ACTS, ActSchema, makeEnvelope, type Act, type Recipient } from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { asMusterdError, MusterdError } from '../errors.js';
import { routeEnvelope } from '../protocol/route.js';
import { getCursor } from '../store/cursors.js';
import { rowsToEnvelopes } from '../store/hydrate.js';
import { authMember, getMemberByName, touchSeen } from '../store/members.js';
import { listInbox } from '../store/messages.js';
import { touchAmbientPresence } from '../store/presence.js';
import { requireTeam } from '../store/teams.js';
import { isTlsPeer, requireTeamRedacted } from './oauth.js';
import { mintSponsoredAgent, originFrom } from './sponsoredAgentMint.js';

/**
 * The remote-MCP rail (ADR 446 §1): the musterd adapter served as Streamable HTTP at
 * `POST|GET /mcp/:team`, so a phone app adds one connector URL and signs in as a seat.
 *
 * Two deliberate shapes, both from the ADR:
 *
 * 1. **Framing owned by the SDK, decisions owned by the store.** `createMcpHandler` serves the
 *    Streamable HTTP exchange (initialize handshake, tools/list, tools/call, session ids) with a
 *    per-request factory — each request builds a fresh `McpServer` bound to the bearer, never a
 *    shared client. The tool handlers below call the SAME store paths the REST routes use
 *    (`routeEnvelope` for sends, `listInbox` for reads), so there is one semantics, not two.
 * 2. **Remote-bearer mode, not a socket.** Tool calls authenticate per request (no WS, no
 *    `wantPresence`, no session lease) and stamp ambient presence (`touchAmbientPresence`, ADR
 *    057) — last-OAuth-use is what the roster reads. `team_join` is a no-op success when the
 *    bearer already names the seat (the apps' setup prompts call it; failing there fails the
 *    demo).
 *
 * Increment 1 registers the Done-line tools only (`team_join` / `team_inbox_check` / `team_send`
 * — the join-page prompt's whole vocabulary). Converging the rest of the adapter surface rides
 * increment 3, after rehearsal says which tools a phone actually reaches for. The input shapes
 * mirror the adapter's (`packages/mcp/src/tools/*`) so the prompt works unchanged.
 */

const handlers = new Map<string, McpHttpHandler>();

/**
 * Bridge a zod-v3 object schema to what SDK 2.0.0's `registerTool` accepts: the Standard Schema
 * `~standard` face (Zod v4, ArkType, Valibot all implement it; zod v3 predates the `jsonSchema`
 * half). Validation runs the real zod schema; the JSON Schema is hand-authored beside it and is
 * what `tools/list` advertises — one source per tool, kept adjacent so they cannot drift.
 */
function asMcpSchema<T>(schema: z.ZodType<T>, jsonSchema: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zod',
      validate: (
        value: unknown,
      ): { value: T } | { issues: { message: string; path: PropertyKey[] }[] } => {
        const parsed = schema.safeParse(value);
        if (parsed.success) return { value: parsed.data };
        return {
          issues: parsed.error.issues.map((i) => ({ message: i.message, path: [...i.path] })),
        };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

/**
 * The daemon's own package version for MCP `serverInfo` — read from `package.json` at load so
 * it can never drift (the ADR 175 posture, same as the adapter's `ADAPTER_VERSION`).
 */
const DAEMON_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** The audience parser, mirroring the adapter's `normalizeTo` (same rules, no shared import). */
function parseRecipient(
  to: string | string[],
  act: Act,
): { to: Recipient; eligible: string[] | null } {
  const names = (Array.isArray(to) ? to : [to]).map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return { to: { kind: 'team' }, eligible: null };
  if (names.length === 1) {
    const only = names[0]!;
    if (only === '@team') return { to: { kind: 'team' }, eligible: null };
    if (only === '@broadcast') return { to: { kind: 'broadcast' }, eligible: null };
    return { to: { kind: 'member', name: only }, eligible: null };
  }
  if (names.length > 4)
    throw new Error(`too many recipients (${names.length}) — name at most 4 seats, or use @team`);
  const alias = names.find((n) => n.startsWith('@'));
  if (alias)
    throw new Error(`"${alias}" cannot appear in a list of seats — send to ${alias} on its own`);
  if (act !== 'message' && act !== 'request_help' && act !== 'challenge')
    throw new Error(
      `a list of seats can only take message, request_help, or challenge — not ${act}`,
    );
  return { to: { kind: 'team' }, eligible: names };
}

const TeamJoinInput = z.object({}).passthrough();
const TeamInboxInput = z.object({
  ids: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.number().int().positive().max(500).optional(),
  unread_only: z.boolean().optional(),
});
const TeamSendInput = z.object({
  to: z.union([z.string(), z.array(z.string())]).default('@team'),
  act: z.enum(ACTS),
  body: z.string(),
  thread: z.string().optional(),
  reply_to: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const TeamAgentCreateInput = z.object({
  name: z.string().min(1).max(64),
  role: z.string().max(64).optional(),
});

/** One request's seat, read by the factory off the bridged request's identity headers. */
function requestSeat(webReq: Request): { team: string; member: string } {
  const team = webReq.headers.get('x-musterd-remote-team');
  const member = webReq.headers.get('x-musterd-remote-member');
  if (!team || !member) throw new Error('remote MCP request lost its seat identity');
  return { team, member };
}

function buildRemoteServer(ctx: Ctx, webReq: Request): McpServer {
  const { team: slug, member: memberName } = requestSeat(webReq);
  const team = requireTeam(ctx.db, slug);
  const server = new McpServer(
    { name: 'musterd', version: DAEMON_VERSION },
    {
      instructions:
        `You are joined to the musterd team "${slug}" as ${memberName} over a phone connector. ` +
        `Call team_join first, then team_inbox_check; send with team_send. ` +
        `team_agent_create adds an agent you sponsor.`,
    },
  );

  server.registerTool(
    'team_join',
    {
      description: 'Join the team — a no-op success when the bearer already names the seat.',
      inputSchema: asMcpSchema(TeamJoinInput, { type: 'object', properties: {} }),
    },
    async () =>
      textResult(
        `Already joined ${slug} as ${memberName} (remote bearer seat — no presence socket; your activity marks you present).`,
      ),
  );

  server.registerTool(
    'team_inbox_check',
    {
      description: 'Read the inbox: recent team traffic and acts directed at this seat.',
      inputSchema: asMcpSchema(TeamInboxInput, {
        type: 'object',
        properties: {
          ids: {
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'read named acts back and nothing else',
          },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          unread_only: { type: 'boolean' },
        },
      }),
    },
    async (rawArgs: unknown) => {
      const parsed = TeamInboxInput.safeParse(rawArgs ?? {});
      if (!parsed.success)
        return toolError('invalid input: ids (string|string[]) | limit | unread_only');
      const args = parsed.data;
      const member = getMemberByName(ctx.db, team.id, memberName);
      if (!member) return toolError('seat is gone — sign in again');
      if (args.ids !== undefined) {
        const ids = (Array.isArray(args.ids) ? args.ids : args.ids.split(',')).filter(
          (s) => s.length > 0,
        );
        const rows = listInbox(ctx.db, member, { ids });
        return textResult(
          JSON.stringify({
            messages: rowsToEnvelopes(ctx.db, slug, rows),
            cursor: getCursor(ctx.db, member.id),
          }),
        );
      }
      const cursor = getCursor(ctx.db, member.id);
      const rows = listInbox(ctx.db, member, {
        unreadOnly: args.unread_only ?? false,
        cursorTs: cursor.last_read_ts,
        cursorId: cursor.last_read_message_id,
        ...(args.limit ? { limit: args.limit } : { headLimit: 200 }),
      });
      return textResult(
        JSON.stringify({
          messages: rowsToEnvelopes(ctx.db, slug, rows),
          cursor: getCursor(ctx.db, member.id),
        }),
      );
    },
  );

  // ADR 449 §3: a human member creates an agent they sponsor — the same mint as
  // `POST …/members/agents` (one helper, so the surfaces cannot drift). The result carries a
  // one-time connect link and no secret: the human opens it on the device that will run the agent.
  server.registerTool(
    'team_agent_create',
    {
      description:
        'Create an agent on this team that you sponsor. Returns a one-time connect link (15 minutes) ' +
        'to open on the device that will run it. It expires when you do, and removing you removes it. ' +
        'At most 3 live agents each.',
      inputSchema: asMcpSchema(TeamAgentCreateInput, {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: "the agent's member name (no spaces)" },
          role: { type: 'string', description: 'optional role, e.g. research' },
        },
      }),
    },
    async (rawArgs: unknown) => {
      const parsed = TeamAgentCreateInput.safeParse(rawArgs ?? {});
      if (!parsed.success) return toolError('invalid input: name | role?');
      const sponsor = getMemberByName(ctx.db, team.id, memberName);
      if (!sponsor) return toolError('seat is gone — sign in again');
      try {
        const origin = originFrom(
          webReq.headers.get('host'),
          webReq.headers.get('x-forwarded-proto'),
        );
        const minted = mintSponsoredAgent(ctx, team, sponsor, parsed.data, origin);
        return textResult(
          `Created agent "${minted.member.name}" on ${slug}, sponsored by you.\n` +
            `Open this link on the device that will run it (expires in 15 minutes, works once):\n` +
            `${minted.connect_url}`,
        );
      } catch (err) {
        return toolError(asMusterdError(err).message);
      }
    },
  );

  server.registerTool(
    'team_send',
    {
      description:
        'Send an act to the team or a seat (message, status_update, request_help, handoff, accept, decline, …).',
      inputSchema: asMcpSchema(TeamSendInput, {
        type: 'object',
        required: ['act', 'body'],
        properties: {
          to: {
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: "member name, '@team', '@broadcast', or 2-4 names",
          },
          act: { type: 'string', enum: ACTS },
          body: { type: 'string' },
          thread: { type: 'string', description: 'thread id to reply within' },
          reply_to: { type: 'string', description: 'message id this accepts/declines' },
          meta: { type: 'object', description: 'act-specific fields, e.g. {progress:0.5}' },
        },
      }),
    },
    async (rawArgs: unknown) => {
      const parsed = TeamSendInput.safeParse(rawArgs ?? {});
      if (!parsed.success)
        return toolError('invalid input: to | act | body | thread? | reply_to? | meta?');
      const args = parsed.data;
      const parsedAct = ActSchema.safeParse(args.act);
      if (!parsedAct.success) return toolError(`unknown act "${args.act}"`);
      const act = parsedAct.data;
      let addressed: { to: Recipient; eligible: string[] | null };
      try {
        addressed = parseRecipient(args.to, act);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
      const member = getMemberByName(ctx.db, team.id, memberName);
      if (!member) return toolError('seat is gone — sign in again');
      const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
      if (args.reply_to) meta['in_reply_to'] = args.reply_to;
      if (addressed.eligible) meta['eligible'] = addressed.eligible;
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: slug,
          from: memberName,
          to: addressed.to,
          act,
          body: args.body,
          thread: args.thread ?? null,
          meta: Object.keys(meta).length > 0 ? meta : null,
        });
        // The ONE validate+persist+deliver path (routeEnvelope) — a remote send is a send.
        // No sender occupancy id by design (stateless, like POST /messages): the model stamp
        // falls back to the member's newest attested presence.
        const result = routeEnvelope(ctx, team, member, envelope);
        return textResult(
          JSON.stringify({
            sent: envelope.id,
            ...(result.handoff_lane ? { handoff_lane: result.handoff_lane } : {}),
            ...(result.lane_verdict ? { lane_verdict: result.lane_verdict } : {}),
            ...(result.lane_ack ? { lane_ack: result.lane_ack } : {}),
          }),
        );
      } catch (err) {
        const me = asMusterdError(err);
        return toolError(`${me.code}: ${me.message}`);
      }
    },
  );

  return server;
}

function getHandler(ctx: Ctx, slug: string): McpHttpHandler {
  let handler = handlers.get(slug);
  if (!handler) {
    // The factory runs per request with that request's seat (ADR 446 §1); sessions the SDK
    // holds are keyed by its own session ids, and this map is keyed by team — bounded by the
    // team count, never by callers. Rehearsal measures the SDK-owned session growth (inc 3).
    handler = createMcpHandler((fctx: { requestInfo?: Request }) => {
      if (!fctx.requestInfo) throw new Error('remote MCP factory needs the request');
      return buildRemoteServer(ctx, fctx.requestInfo);
    });
    handlers.set(slug, handler);
  }
  return handler;
}

async function toWebRequest(
  req: IncomingMessage,
  path: string,
  url: URL,
  seat: { team: string; member: string },
): Promise<Request> {
  // Decline 2: the bridged exchange is bounded — MCP frames carry tool args (message bodies),
  // so the cap is generous (1 MiB), but an unbounded public endpoint is a memory-exhaustion bug.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 1024 * 1024) throw new MusterdError('payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    // Hop-by-hop and framing headers describe the node transport, not the exchange.
    if (name === 'content-length' || name === 'connection' || name === 'transfer-encoding')
      continue;
    headers.set(name, Array.isArray(v) ? v.join(', ') : v);
  }
  // Seat identity for the per-request factory — in-memory only, never logged (the redaction
  // lane owns the daemon log; this header never reaches it).
  headers.set('x-musterd-remote-team', seat.team);
  headers.set('x-musterd-remote-member', seat.member);
  const hasBody =
    body.length > 0 && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH');
  return new Request(`http://localhost${path}${url.search}`, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  });
}

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((v, k) => {
    const name = k.toLowerCase();
    if (name === 'content-encoding' || name === 'content-length' || name === 'connection') return;
    headers[name] = v;
  });
  headers['cache-control'] = 'no-store';
  if (!webRes.body) {
    res.writeHead(webRes.status, headers);
    return void res.end();
  }
  res.writeHead(webRes.status, headers);
  const reader = webRes.body.getReader();
  const onClose = () => void reader.cancel().catch(() => {});
  res.on('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
  } finally {
    res.off('close', onClose);
  }
  res.end();
}

/**
 * `POST|GET|DELETE /mcp/:team` — the connector URL. TLS-except-loopback (a bearer over
 * plaintext is a bearer leaked), bearer-authenticated per request, then handed to the SDK
 * handler whose per-request factory binds the seat. Returns true when the path belonged here.
 */
export async function handleMcpRoute(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  const m = path.match(/^\/mcp\/([^/]+)$/);
  if (!m) return false;
  const slug = decodeURIComponent(m[1]!);
  // Redaction lane 01M3AMYGN5: the slug is attacker-controlled path input and may itself be
  // credential-shaped — never echo it (requireTeam's `no team "X"` would write it back out).
  const team = requireTeamRedacted(ctx.db, slug);
  if (!isTlsPeer(ctx, req)) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        error: {
          code: 'forbidden',
          message:
            'remote MCP is refused over plaintext — reach the daemon through the TLS tunnel (or loopback for local testing)',
        },
      }),
    );
    return true;
  }
  const h = req.headers['authorization'];
  const bearer = h?.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
  if (!bearer) {
    // RFC 6750 §3: a 401 from a protected resource names the scheme so the client knows
    // how to authenticate (ryder's #1694 review note — the 401 carried no header at all).
    res.writeHead(401, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing bearer token' } }));
    return true;
  }
  const actingSeat = req.headers['x-musterd-seat'];
  const seatHeader = Array.isArray(actingSeat) ? actingSeat[0] : actingSeat;
  let memberName: string;
  let memberId: string;
  try {
    const auth = authMember(
      ctx.db,
      slug,
      bearer,
      seatHeader && seatHeader.length > 0 ? seatHeader : undefined,
    );
    memberName = auth.member.name;
    memberId = auth.member.id;
  } catch (err) {
    const me = asMusterdError(err);
    // RFC 6750 §3: an invalid/expired/revoked bearer 401s as invalid_token. The description
    // stays out of the header — the body already says it, and the header must not become an
    // oracle finer than the body. Non-401s (seat mismatch 403s, etc.) ride exactly as before.
    res.writeHead(me.httpStatus, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(me.httpStatus === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {}),
    });
    res.end(JSON.stringify(me.toBody()));
    return true;
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'method not allowed' } }));
    return true;
  }
  // Ambient presence (ADR 057 §4): the tool call IS the heartbeat — stamp it, and announce the
  // flip like authTouch does. Humans stamp no model/provenance (ADR 121); the surface reads
  // `other` (no remote surface in the enum; rehearsal may name one).
  touchSeen(ctx.db, memberId);
  if (touchAmbientPresence(ctx.db, memberId, 'other', ctx.config.presenceTimeoutMs)) {
    ctx.hub.broadcastTeam(team.id, { type: 'presence', member: memberName, status: 'online' });
  }
  try {
    const webReq = await toWebRequest(req, path, url, { team: slug, member: memberName });
    const webRes = await getHandler(ctx, slug).fetch(webReq);
    await sendWebResponse(res, webRes);
  } catch (err) {
    const me = asMusterdError(err);
    // A factory throw means the seat vanished mid-request; anything else is a 500 with no secret.
    if (!res.headersSent) {
      res.writeHead(me.httpStatus, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(me.toBody()));
    }
  }
  return true;
}

/** Test seam: drop cached handlers (per-team singletons) between isolated test servers. */
export function resetMcpHandlersForTest(): void {
  handlers.clear();
}
