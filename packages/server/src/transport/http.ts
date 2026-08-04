import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import {
  type Act,
  MemberKindSchema,
  LifecycleSchema,
  SurfaceSchema,
  PresenceStatusSchema,
  ProvenanceSchema,
  AvailabilityStatusSchema,
  PROTOCOL_VERSION,
  FEATURE_EPOCH,
  GENERALIST_CAPABILITIES,
  ClaimTargetSchema,
  DecideRequestSchema,
  IssueGrantSchema,
  PolicyOverrideSchema,
  EnrollResidencyBodySchema,
  RevokeResidencyBodySchema,
  SessionAttestationBodySchema,
  WakeLeasesBodySchema,
  WakeReportBodySchema,
  WakeContextRequestSchema,
  WakeContextResponseSchema,
  ToolTelemetryReportSchema,
  OpenLaneSchema,
  UpdateLaneSchema,
  DeclareGoalSchema,
  ActorAttestationSchema,
  GateCheckRequestSchema,
  AskTierSchema,
  type AskTier,
  askContract,
  LANE_TERMINAL_STATES,
  isAwaitingAcceptance,
  makeEnvelope,
  type Envelope,
  type LaneWarning,
  type MemberSummary,
  type Provenance,
  describeFamilyPosture,
  resolvePosture,
  resolveOfflineReason,
  type OfflineReason,
  isRailCandidate,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import { isLocalPeer, readLocalIdentity, resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { reconcileTeam, teamSpecForSlug } from '../projection/reconcile.js';
import { adjudicateGate, recordActorAttestation } from '../protocol/gate.js';
import { deliveryHintFor } from '../protocol/nudge.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope, parseOrBadRequest } from '../protocol/validate.js';
import { resolveActivity } from '../store/activity.js';
import { appendAudit, hasInterruptRaised, laneOwnerHistory, listAudit } from '../store/audit.js';
import { getCursor, setCursor } from '../store/cursors.js';
import { actDelivery, crossedBySeen } from '../store/delivery.js';
import { listGoals } from '../store/goals.js';
import {
  consumeGrant,
  issueGrant,
  listGrants,
  refreshGrant,
  revokeGrant,
  validateGrant,
} from '../store/grants.js';
import { deriveReport } from '../store/insights.js';
import { recordLaneClose } from '../store/laneClose.js';
import {
  boardWarnings,
  getLane,
  laneWarnings,
  listLanes,
  openLane,
  updateLane,
} from '../store/lanes.js';
import {
  addMember,
  authMember,
  agentKeyMayOccupy,
  agentKeySeatKindRefusal,
  clearBound,
  getMemberById,
  getMemberByName,
  isHeld,
  hashToken,
  leaveMember,
  markBound,
  markSignedOff,
  mintCredential,
  rotateToken,
  setAvailability,
  setMemberGovernance,
  teamHasAdmin,
} from '../store/members.js';
import { clearMemory, getMemory, memoryEnvelope, saveMemory } from '../store/memory.js';
import {
  countInbox,
  latestStatusUpdate,
  deferrals,
  listInbox,
  raisedDeferrals,
  listTeamMessages,
  pendingInterrupts,
  rowToEnvelope,
} from '../store/messages.js';
import { deriveNext } from '../store/orientation.js';
import {
  attach,
  clearMemberPresence,
  countLivePresences,
  hasLivePresence,
  listLiveDrivers,
  listPresence,
  listReclaimableMemberIds,
  touchAmbientPresence,
} from '../store/presence.js';
import {
  lastActionByActor,
  quietestBusyMs,
  resolveQuiescence,
  QUIESCENCE_DEFAULT_QUIET_AFTER_MS,
} from '../store/quiescence.js';
import { unblockerReachable } from '../store/reachability.js';
import { createRequest, decideRequest, getRequest, listRequests } from '../store/requests.js';
import {
  claimWakeLeases,
  buildWakeContext,
  effectiveWakePolicy,
  enrollResidency,
  getResidency,
  listResidency,
  recordSessionAttestation,
  revokeResidency,
  settleWakeLease,
  toResidency,
  wakeExhaustionKey,
} from '../store/residency.js';
import {
  pickHumanReviewer,
  pickReviewCounterpart,
  pickWakeReviewer,
  REVIEW_LOOP_BREAKER_N,
  reviewLoopBounceCount,
  teamFamilyPosture,
  verifiedCloses,
} from '../store/review.js';
import { listRoles } from '../store/roles.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import {
  hasFullMessageVisibility,
  parseWorkingHours,
  resolveAccountStatus,
  resolveCapabilities,
  toMember,
} from '../store/rows.js';
import { redeemHandoff, stageHandoff } from '../store/signinHandoff.js';
import { staleLaneWarnings } from '../store/staleness.js';
import {
  archiveTeam,
  createTeam,
  getTeamBySlug,
  getAgentKeyHash,
  getPolicy,
  getStoredPolicy,
  requireTeam,
  rotateAgentKey,
  setPolicy,
} from '../store/teams.js';
import { recordSurfaceRender, recordToolCalls } from '../store/toolCalls.js';
import {
  recordCcdNudge,
  recordNudgeDecision,
  recordError,
  recordInterruptCheck,
  recordSeenLatency,
} from '../telemetry.js';

/**
 * The content-coding negotiated for this response from its request's `Accept-Encoding`, set once at
 * the top of `handleHttp`. Kept off the request path so `sendJson` (62 call sites, none holding `req`)
 * can consult it without threading. A WeakMap rather than a property on `res` so we neither widen the
 * node type nor leak past the response's lifetime.
 */
const negotiatedEncoding = new WeakMap<ServerResponse, 'br' | 'gzip' | null>();

/**
 * Below ~1 MTU, compression framing + CPU costs more than the bytes it saves and adds latency to the
 * hot small responses (status, inbox-check). The big reads — the /live message backfill especially —
 * clear this easily.
 */
const JSON_COMPRESS_MIN_BYTES = 1400;

/**
 * How far back an inbox read scans for deferring `wait`s (ADR 211 §3). The fold needs history
 * reaching back to the deferral itself, so it cannot use the default team-timeline window. Bounded
 * deliberately: past this, a deferral stops being tracked and its target is simply unread again —
 * the pre-ADR-211 behaviour, which is a degradation rather than a wrong answer.
 */
const DEFERRAL_SCAN_LIMIT = 2000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload);
  const enc = bytes >= JSON_COMPRESS_MIN_BYTES ? (negotiatedEncoding.get(res) ?? null) : null;
  if (!enc) {
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes) });
    return void res.end(payload);
  }
  // Dynamic bodies can't be cached like static assets, so use a fast level (not static's brotli-11):
  // gzip-6 / brotli-4 compress a ~120 KB backfill in a couple ms while still recovering most of it.
  const buf =
    enc === 'br'
      ? brotliCompressSync(payload, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes,
          },
        })
      : gzipSync(payload, { level: 6 });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-encoding': enc,
    vary: 'Accept-Encoding',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
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

/**
 * Text-based assets worth compressing. Already-compressed formats (woff2, png, webp, …) are omitted:
 * gzipping them burns CPU for ~0 bytes, and can even grow the payload.
 */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.wasm',
]);

/**
 * Compressed-bytes cache, keyed by `enc:path:mtime:size`. The dashboard's `/assets/*` are immutable
 * (content-hashed filenames) so their entries are effectively permanent; the mtime+size in the key
 * busts index.html automatically on the next `pnpm build`. Small, bounded set (one web dist) — no
 * eviction needed, and it makes brotli-11 affordable by amortizing it across every view.
 */
const compressCache = new Map<string, Buffer>();

/** Pick the best content-coding the client will accept, preferring brotli. Null ⇒ serve identity. */
function pickEncoding(accept: string | string[] | undefined): 'br' | 'gzip' | null {
  const raw = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  const a = raw.toLowerCase();
  if (/\bbr\b/.test(a)) return 'br';
  if (/\bgzip\b/.test(a)) return 'gzip';
  return null;
}

function compress(file: string, enc: 'br' | 'gzip', mtimeMs: number, size: number): Buffer {
  const key = `${enc}:${file}:${Math.round(mtimeMs)}:${size}`;
  const hit = compressCache.get(key);
  if (hit) return hit;
  const raw = readFileSync(file);
  const out =
    enc === 'br'
      ? brotliCompressSync(raw, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : gzipSync(raw, { level: 9 });
  compressCache.set(key, out);
  return out;
}

/**
 * Serve a static file with content negotiation + HTTP caching. Compressible types are sent br/gzip
 * per the client's `Accept-Encoding` (compressed bytes cached so it's paid once). Immutable assets
 * (content-hashed `/assets/*`) get a one-year `immutable` Cache-Control; everything else (index.html,
 * favicon) gets a weak ETag + `no-cache` and answers `If-None-Match` with a 304. The ETag is weak
 * because the same file has multiple representations (identity/gzip/br) and a strong validator must be
 * unique per representation; weak is exactly what a revalidation needs.
 */
function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  immutable: boolean,
): void {
  const stat = statSync(file);
  const ext = extname(file).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';

  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl });
    return void res.end();
  }

  const compressible = COMPRESSIBLE.has(ext);
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': cacheControl,
    etag,
    ...(compressible ? { vary: 'Accept-Encoding' } : {}),
  };

  const enc = compressible ? pickEncoding(req.headers['accept-encoding']) : null;
  if (!enc) {
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) });
    return void createReadStream(file).pipe(res);
  }

  const body = compress(file, enc, stat.mtimeMs, stat.size);
  res.writeHead(200, {
    ...headers,
    'content-encoding': enc,
    'content-length': String(body.length),
  });
  return void res.end(body);
}

/**
 * Serve the built web UI same-origin (ADR 062). A real file is served as-is; an extensionless path
 * (a client route like `/live`) falls back to `index.html` so deep links + refresh work. Path
 * traversal is refused by resolving under `webRoot` and requiring containment.
 */
function serveStatic(
  req: IncomingMessage,
  webRoot: string,
  pathname: string,
  res: ServerResponse,
): void {
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
  // Content-hashed build assets are safe to cache forever; the app shell and root files are not.
  const assetsDir = join(root, 'assets') + sep;
  if (existsSync(target) && statSync(target).isFile())
    return sendFile(req, res, target, target.startsWith(assetsDir));
  // SPA fallback: client routes have no file extension → serve the app shell (never immutable).
  if (extname(target) === '') {
    const index = join(root, 'index.html');
    if (existsSync(index)) return sendFile(req, res, index, false);
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

/**
 * Defense-in-depth (banned = inert): a `disabled`/`banned`/`archived` seat can't READ message content
 * either — the send gate (route.ts) already blocks its sends, this closes the residual inbox/firehose
 * read access. Mirrors the send-gate's account_status check exactly; `active`/`provisioned` read normally.
 */
function assertSeatCanRead(member: MemberRow): void {
  const status = resolveAccountStatus(member);
  if (status === 'disabled' || status === 'banned' || status === 'archived')
    throw new MusterdError('forbidden', `seat "${member.name}" is ${status} and cannot read`);
}

/**
 * The class of raise that put a line up (ADR 103): a `steer` is interrupt-class by definition, so it
 * can raise the line without the `urgent` flag; everything else that raises is `urgent`. Named on the
 * line and in the audit so "who grabbed the mic, and by what right" stays legible.
 */
function raiseClass(latest: Envelope): 'steer' | 'urgent' {
  return latest.act === 'steer' ? 'steer' : 'urgent';
}

/**
 * The one-line interrupt notice for `/inbox/interrupt-check` (ADR 088 §4): **daemon-composed from
 * structured fields only** — sender + act + count — never the raw `env.body`, so a teammate's message
 * text can't be injected into a busy agent's context mid-turn. Sender identity is always present so the
 * model can weigh the source. Points at the explicit follow-up (`musterd inbox`) rather than dumping
 * the content. The class noun (`steer` vs `urgent`, ADR 103) describes only `latest`, so a mixed queue
 * isn't mislabeled: the plural line uses the neutral "acts" and names the latest's class inline.
 */
function composeInterruptLine(latest: Envelope, count: number): string {
  const head = `${latest.from} (${latest.act})`;
  const noun = raiseClass(latest);
  return count > 1
    ? `⚡ musterd: ${count} acts waiting (latest: ${noun} from ${head}) — run 'musterd inbox' to read them.`
    : `⚡ musterd: ${noun} from ${head} — run 'musterd inbox' to read it.`;
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
  /** Observer grade (ADR 136). `'public'` — team/broadcast traffic only, what a shared watch-link
   *  gets. Omitted ⇒ `'full'`, the trusted local dashboard; safe as a default only because ADR 134
   *  restricts minting to a local peer or an admin. */
  observer_scope: z.enum(['full', 'public']).optional(),
});

/**
 * Body for `POST /teams/:slug/signin-handoff` (ADR 170). The credential is checked, not stored —
 * `authMember` must resolve it to `member`, so the route can only relay an authority the caller
 * already holds.
 */
const StageHandoffSchema = z.object({
  member: z.string().min(1),
  credential: z.string().min(1),
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
 * Save-memory request body (ADR 093). Deliberately only shapes types here — the caps (headline ≤120
 * chars, body ≤8192 UTF-8 bytes) are enforced in `saveMemory` so the 400 names the exact limit
 * (`.max()` in zod would reject first with a generic message). Body defaults to empty for a
 * headline-only note.
 */
const MemorySaveBody = z.object({
  headline: z.string(),
  body: z.string().optional(),
});

/**
 * Optional harness-attested model from `x-musterd-model` (ADR 119). Same 120-char cap as claim /
 * heartbeat; absent or empty → undefined (sticky COALESCE keeps any prior attestation).
 */
function attestedModelHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-musterd-model'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 120);
}

/**
 * Optional client-attested build ref from `x-musterd-build` (ADR 135). Same shape as the model
 * header; 64-char cap matches the claim frame. Absent or empty → undefined (sticky COALESCE keeps
 * any prior attestation). Unlike model there is NO agent-key gate: build attests the *binary* the
 * caller runs, which a human's CLI genuinely has — a stale human CLI is exactly in scope.
 */
function attestedBuildHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-musterd-build'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 64);
}

/**
 * Optional session provenance from `x-musterd-provenance` (ADR 131 §6 amendment, increment 5).
 * The CLI resolves `MUSTERD_PROVENANCE` exactly like the MCP adapter, so a woken session's
 * hook-driven one-shots ambient-touch as `wake` instead of the default `session` — before this,
 * verify credited the wake against a `session`-labelled ambient row and the roster could not mark
 * machine-initiated occupancies (inc-4 finding a). Enum-validated; anything else → undefined.
 */
function provenanceHeader(req: IncomingMessage): Provenance | undefined {
  const raw = req.headers['x-musterd-provenance'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = ProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Authenticate a request and write an ambient presence touch for the caller (ADR 057): a one-shot
 * authenticated command is itself proof of liveness, so it flips a bursty agent present between watch
 * sockets. A no-op when the member already holds a resident session; on an offline→online transition we
 * emit the same presence event the WS attach path does, so live watchers update. Surface defaults to
 * `cli` but honors `x-musterd-surface` so an adapter one-shot can label its real surface.
 * When `x-musterd-model` is present on an **agent** seat, the ambient occupancy is (re)attested
 * (ADR 119) — closing the CLI stamp gap after the claim presence expires (issue #172). Human seats
 * ignore the header (ADR 121): attestation is a harness fact, not a human-shell env leak.
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
  // ADR 121: model attestation is a harness fact — only agent seats re-attest from the header.
  // A human with MUSTERD_MODEL in their shell (or a buggy client) must not stamp their occupancy.
  const model = auth.member.kind === 'agent' ? attestedModelHeader(req) : undefined;
  const build = attestedBuildHeader(req); // all credentials — the binary is the binary (ADR 135)
  // Provenance describes the *current* animation source (newest-wins, owner call 2026-07-14) —
  // agent seats only, mirroring the model gate: a human shell must not label itself `wake`.
  const provenance = auth.member.kind === 'agent' ? provenanceHeader(req) : undefined;
  // Snapshot the ambient row before the touch so a real model change can audit (source: ambient).
  const before = model
    ? ctx.db
        .prepare<
          [string],
          { id: string; model: string | null }
        >('SELECT id, model FROM presence WHERE member_id = ? AND conn_id IS NULL AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1')
        .get(auth.member.id)
    : undefined;
  const flipped = touchAmbientPresence(
    ctx.db,
    auth.member.id,
    surface,
    ctx.config.presenceTimeoutMs,
    {
      ...(model !== undefined ? { model } : {}),
      ...(build !== undefined ? { build } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    },
  );
  if (model) {
    const after = ctx.db
      .prepare<
        [string],
        { id: string; model: string | null }
      >('SELECT id, model FROM presence WHERE member_id = ? AND conn_id IS NULL AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1')
      .get(auth.member.id);
    if (after && (before?.model ?? null) !== after.model) {
      appendAudit(ctx.db, auth.team.id, {
        actor: auth.member.name,
        action: 'occupancy.model_attested',
        target: auth.member.name,
        result: 'allow',
        detail: {
          occupancy: after.id,
          old: before?.model ?? null,
          new: after.model,
          source: 'ambient',
        },
      });
    }
  }
  if (flipped) {
    ctx.hub.broadcastTeam(auth.team.id, {
      type: 'presence',
      member: auth.member.name,
      status: 'online',
    });
  }
  return auth;
}

/** Order-independent key for a lane warning — the (subject, with, kind) dedup identity (ADR 083 §4). */
function laneWarningKey(w: LaneWarning): string {
  return w.kind === 'surface_overlap'
    ? `${w.kind}:${[w.subject, w.with].sort().join(':')}`
    : `${w.kind}:${w.subject}:${w.with}`;
}

/**
 * Send one directed lane act from the acting member to another seat — structured meta on an existing
 * act, so it rides the whole existing delivery path (inbox, ADR 053/054 hooks, ADR 024/035 notify)
 * with no new act token and no SPEC bump (ADR 083 §4). Best-effort: a missing target never fails the
 * lane verb.
 *
 * `act` defaults to `message`, and that default is the safe one **on purpose**. The wake ledger
 * (`openDirectedLedger`, and so every candidate `claimWakeLeases` derives) matches
 * `act IN ('request_help','handoff')` or an urgent flag — nothing else. So the act chosen here decides
 * whether an offline recipient is *spawned*, at real cost. Only a caller whose event is genuinely
 * work-directed-at-a-person should pass one: today that is the handoff, which transfers ownership.
 * Surface-overlap advisories keep the default — waking an offline seat to tell it two lanes touch the
 * same glob is exactly the spend this default exists to prevent.
 */
function deliverLaneAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  body: string,
  meta: Record<string, unknown>,
  act: Act = 'message',
): void {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act,
      body,
      meta,
    });
    routeEnvelope(ctx, team, from, env);
  } catch {
    /* advisory only — the lane verb already succeeded */
  }
}

// LANE_TERMINAL_STATES now imports from @musterd/protocol (ADR 169 consolidation) — this file
// previously hand-mirrored the store's private TERMINAL set, a drift hazard three copies deep.

/**
 * Outcome-acceptance ask (ADR 192): a directed `ask` act from the worker to the picked acceptor —
 * unlike {@link deliverLaneAct} this is act `ask`, so it rides the whole ask-stream machinery
 * (tier contract, reachability, ask-span telemetry) with no new act kind. Best-effort like every
 * lane delivery: a failed compose never fails the verb (the degradation path is self-close anyway).
 */
function deliverLaneAskAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  body: string,
  meta: Record<string, unknown>,
): void {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act: 'ask',
      body,
      meta,
    });
    routeEnvelope(ctx, team, from, env);
  } catch {
    /* advisory only — the lane verb already succeeded */
  }
}

/**
 * The overlap line (ADR 192, lane 01KYX6QY5N). The picker excludes the lane's CURRENT owner and
 * nobody else, so a lane that changed hands can route its acceptance to a previous owner — an
 * author of the very artifact being judged. Rather than exclude them (which would narrow a pool
 * that already finds nobody on most attempts, to close a hole seen on 3 lanes ever), the ask NAMES
 * the overlap and leaves the call to the acceptor: recusal is a judgment, not a computation.
 *
 * Phrased as a fact plus the two honest options, never as an accusation — the acceptor may well be
 * the right judge (ADR 192 acceptance is intent-vs-brief, and a brief's author knows the brief).
 */
function priorOwnerNotice(reviewer: string, priorOwners: string[]): string {
  return priorOwners.includes(reviewer)
    ? ' NOTE — you previously owned this lane, so you are named on the artifact you are judging. ' +
        'That is allowed and may even make you the best judge of intent, but it is yours to weigh: ' +
        'accept if you can judge it independently, or decline and say "recusing — I authored this" ' +
        'so it routes to someone else.'
    : '';
}

/** ADR 192 acceptor checklist — judge the landed outcome, not the diff. */
function acceptanceAskBody(
  title: string,
  opts: { human?: boolean; peerFindings?: string; overlapNotice?: string } = {},
): string {
  const checklist =
    'Judge the LANDED OUTCOME (not a code review): ' +
    '(1) Intent — matches the lane brief? ' +
    '(2) Principles — project/musterd hard rules? ' +
    '(3) Usable — exercise the path enough to say it works? ' +
    '(4) Feel — only if UI/copy/brand is in surface, else N/A. ' +
    'Accept → move the lane to done; reject → send it back to active with a concrete note.';
  const overlap = opts.overlapNotice ?? '';
  if (opts.human && opts.peerFindings !== undefined) {
    return (
      `[lane] human acceptance required: "${title}" — peer accepted with: "${opts.peerFindings}". ` +
      checklist +
      overlap
    );
  }
  return `[lane] acceptance requested: "${title}" — ${checklist}${overlap}`;
}

/**
 * Broadcast a lane lifecycle event (open/resolve) to the whole team — same ordinary `message` envelope
 * + structured meta pattern as `deliverLaneAct` (ADR 083 §4: no new act, no SPEC bump), but `to: team`
 * since open/resolve are board-shape changes every member benefits from seeing on the shared feed and
 * office view, unlike warnings and handoffs which stay directed.
 */
function deliverLaneTeamAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  body: string,
  meta: Record<string, unknown>,
): void {
  const env = makeEnvelope({
    id: ulid(),
    team: team.slug,
    from: from.name,
    to: { kind: 'team' },
    act: 'message',
    body,
    meta,
  });
  routeEnvelope(ctx, team, from, env);
}

/**
 * Directed wakes for fresh lane warnings (ADR 083 §4): the *affected* owner gets one targeted act —
 * never the team, never the firehose. The actor already saw the warning inline in the verb response.
 */
function deliverLaneWarnings(
  ctx: Ctx,
  team: TeamRow,
  actor: MemberRow,
  warnings: LaneWarning[],
): void {
  for (const w of warnings) {
    if (!w.owner || w.owner === actor.name) continue;
    deliverLaneAct(ctx, team, actor, w.owner, `[lane] ${w.detail}`, { lane_warning: w });
  }
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

/**
 * Authenticate a bearer that must be the **team agent key, with no acting seat** (ADR 131): the
 * wake-lease/wake-report poller (`musterd host`) is harness-side infrastructure, not a seat — it
 * never occupies anything, so there is no member to resolve, no presence to touch, nothing to
 * impersonate. Presence-neutral by construction (the woken session announces itself by occupying
 * via the seat's own grant).
 */
function authAgentKeyOnly(ctx: Ctx, slug: string, req: IncomingMessage): TeamRow {
  const team = requireTeam(ctx.db, slug);
  const keyHash = getAgentKeyHash(ctx.db, team.id);
  if (!keyHash || hashToken(bearer(req)) !== keyHash) {
    throw new MusterdError(
      'unauthorized',
      `the residency wake endpoints authenticate with the team agent key (mskey_) for "${slug}"`,
    );
  }
  return team;
}

/**
 * Authorize **seat provisioning** (`POST /members`).
 *
 * This route mints a seat and hands back its secret, and for `{observer: true}` that secret carries
 * full message visibility — the recipient-scoping in `GET /messages` and the firehose both exempt
 * observers (ADR 128). So an unauthenticated caller here can read every DM on the team.
 *
 * The route has always *described* itself as localhost-trust, but nothing enforced it: the server
 * never looked at the peer address, so "local" was an emergent property of the default 127.0.0.1
 * bind rather than a checked predicate. Under ADR 040's off-loopback bind (TLS or trust-proxy) that
 * left the endpoint open to anyone who could reach the port. This enforces the claim.
 *
 * Local peer ⇒ unauthenticated, exactly as before (the CLI and the daemon-served /live dashboard both
 * provision this way, and neither holds an admin credential). Anyone else ⇒ admin.
 */
/**
 * Refuse anything that did not come from this machine (ADR 170, reusing ADR 134's predicate). Unlike
 * `authProvision` there is no admin escape hatch: the sign-in handoff moves a *member* credential,
 * and the whole reason it is safe to put a nonce in a URL is that the URL only works here. `onDeny`
 * lets the caller record the refusal — an off-machine attempt is a product signal (someone wants
 * cross-device sign-in), not just an error.
 */
function requireLocalPeer(
  ctx: Ctx,
  req: IncomingMessage,
  action: string,
  onDeny?: () => void,
): void {
  if (isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy)) return;
  onDeny?.();
  throw new MusterdError(
    'forbidden',
    `${action} only works on the machine running the daemon — a sign-in link carries a member ` +
      'identity, so it is deliberately not redeemable from another device. Sign in with your ' +
      'credential on that device instead.',
  );
}

function authProvision(ctx: Ctx, slug: string, req: IncomingMessage): void {
  if (isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy)) return;
  try {
    authAdmin(ctx, slug, req);
  } catch (e) {
    // Re-frame the generic admin refusal: the caller's real problem is *where they are*, not their role.
    if (e instanceof MusterdError && (e.code === 'unauthorized' || e.code === 'forbidden')) {
      throw new MusterdError(
        e.code,
        'provisioning a seat from off this machine requires an admin credential — an observer seat ' +
          "reads the team's directed messages, so it is not mintable anonymously over the network. " +
          'Provision on the daemon host, or authenticate as an admin seat (is_admin).',
      );
    }
    throw e;
  }
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
 * presence, availability, account_status, and composed `posture` (ADR 138), but **not** other seats'
 * capabilities (the authority map: who is admin, who is muted, who is narrowed). Permissive by default —
 * no token still yields a usable roster, just without the authority detail that only an admin dashboard needs.
 */
function summarize(
  ctx: Ctx,
  teamSlug: string,
  teamId: string,
  viewer: MemberRow | null = null,
): MemberSummary[] {
  const teamWorkingHours = parseWorkingHours(getTeamBySlug(ctx.db, teamSlug)?.working_hours);
  const viewerIsAdmin = viewer ? resolveCapabilities(viewer).is_admin : false;
  // Seats held within their ADR 010 reclaim grace — read `offline` above, but a reservation the clobber
  // guard (ADR 066/105) must treat as occupied. Computed once for the team, not per-member.
  const reclaimable = listReclaimableMemberIds(ctx.db, teamId, Date.now());
  // Seats enrolled in harness residency (ADR 131) — offline reads `offline · wakeable`, and the
  // capture timestamp feeds the `resumable` badge (inc 5: a timestamp, so renderers apply the GC
  // freshness instead of trusting a stale boolean). One listResidency pass covers both facts.
  const residency = new Map(
    listResidency(ctx.db, teamId).map((r) => [r.member_id, r.resumable_at] as const),
  );
  // Steering marks you present (ADR 155 Inc 1): the humans named as `driver` on a live agent seat.
  // Derived here at read time — no synthetic presence row for the steering human (ADR 155 decision 1).
  const liveDrivers = listLiveDrivers(ctx.db, teamId, ctx.config.presenceTimeoutMs);
  // Quiescence (ADR 219): the decision-grade busy read, beside — never folded into — the
  // display fields below. One audit read for the whole roster; a seat with no evidence is absent
  // from the map and reports `unknown` rather than borrowing the shape of quiet.
  const lastAction = lastActionByActor(ctx.db, teamId);
  const quiescenceNow = Date.now();
  return listPresence(ctx.db, teamId, ctx.config.presenceTimeoutMs).map((s) => {
    // Two-clocks rule (M2): liveness from presence, working-label from the latest status_update — plus
    // steering (ADR 155): a human steering a live agent seat reads working + present without their own
    // heartbeat, so a driving human stops showing offline on the roster (driver-copresence-gap).
    const steering = s.member.kind === 'human' && liveDrivers.has(s.member.name);
    const live = s.status !== 'offline' || steering;
    const presenceStatus = steering && s.status === 'offline' ? 'online' : s.status;
    // Humans get the ADR 155 Inc 3 idle window (reusing the presence timeout — decision 2): a human
    // kept live by an authenticated /live tab decays working → idle once their last status_update
    // ages past it. Agents keep the ADR 010 never-silently-revert read (window omitted).
    const activity = resolveActivity(
      live,
      latestStatusUpdate(ctx.db, s.member.id),
      steering,
      s.member.kind === 'human' ? ctx.config.presenceTimeoutMs : undefined,
    );
    const member = toMember(s.member, teamSlug);
    const effectiveWorkingHours = member.working_hours ?? teamWorkingHours;
    const seesCaps = viewerIsAdmin || viewer?.id === s.member.id;
    const { capabilities: _caps, ...needToKnow } = member;
    const isReclaimable = reclaimable.has(s.member.id);
    const sticky = s.member.last_offline_reason;
    const offlineReason = resolveOfflineReason({
      live,
      reclaimable: isReclaimable,
      availability: member.availability ?? null,
      lastOfflineReason:
        sticky === 'disconnected' || sticky === 'signed_off' ? (sticky as OfflineReason) : null,
    });
    return {
      ...(seesCaps ? member : needToKnow),
      working_hours: effectiveWorkingHours,
      presence: presenceStatus,
      presences: s.presences,
      ...activity,
      posture: resolvePosture({
        activity: activity.activity,
        availability: member.availability ?? null,
      }),
      ...(offlineReason ? { offline_reason: offlineReason } : {}),
      reclaimable: isReclaimable,
      wakeable: residency.has(s.member.id),
      resumable_at: residency.get(s.member.id) ?? null,
      quiescence: resolveQuiescence(
        lastAction.get(s.member.name) ?? null,
        quiescenceNow,
        QUIESCENCE_DEFAULT_QUIET_AFTER_MS,
      ),
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
    // Negotiate response compression once; sendJson consults this for bodies over the size threshold.
    negotiatedEncoding.set(res, pickEncoding(req.headers['accept-encoding']));

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
        // Quiescence (2026-08-03 design): age of the newest audited action across live agent seats,
        // for the auto-refresher's quiet-floor — `connections` says who is ATTACHED, this says who
        // is WORKING (measured: gating a bounce on connections would defer 95% of refreshes).
        // Omitted when unknown (no live agent action in the lookback) — absence, never zero.
        ...(() => {
          const q = quietestBusyMs(ctx.db, { presenceTimeoutMs: ctx.config.presenceTimeoutMs });
          return q === null ? {} : { quietest_busy_ms: q };
        })(),
        // The commit this daemon booted from (ADR 130) — lets `service status` name build skew
        // against origin/main. Omitted when not running from a git checkout.
        ...(ctx.config.buildRef ? { build: ctx.config.buildRef } : {}),
        // The daemon's own feature epoch (ADR 148) — the compiled-in capability counter of the code it
        // runs. The roster compares each seat's attested epoch against this to render a "behind" hint.
        epoch: FEATURE_EPOCH,
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
          team: {
            id: team.id,
            slug: team.slug,
            display: team.display,
            working_hours: parseWorkingHours(team.working_hours),
          },
          members: summarize(ctx, slug, team.id, tryAuth(ctx, slug, req)),
        });
      }

      if (method === 'POST' && rest === '/members') {
        authProvision(ctx, slug, req);
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
          return sendJson(res, 201, {
            member: toMember(row, team.slug),
            token,
            // v0.3 (ADR 069): a human member needs a credential (mscr_) to authenticate — the creator gets
            // one at team-create; this gives every *other* human seat the same, closing the "second human
            // can't auth" gap the cutover surfaced. Agents stay credential-less (they claim with the team
            // agent key + a grant).
            ...(row.kind === 'human'
              ? { human_credential: mintCredential(ctx.db, row.id).credential }
              : {}),
          });
        }
        const team = requireTeam(ctx.db, slug);
        const { row, token } = addMember(ctx.db, team, {
          name: body.name,
          kind: body.kind,
          role: body.role ?? '',
          ...(body.lifecycle ? { lifecycle: body.lifecycle } : {}),
          lifecycleUntil: body.lifecycle_until ?? null,
          ...(body.observer
            ? { observer: true, observerScope: body.observer_scope ?? 'full' }
            : {}),
        });
        return sendJson(res, 201, {
          member: toMember(row, team.slug),
          token,
          // v0.3 (ADR 069): a human member needs a credential (mscr_) to authenticate — the creator gets
          // one at team-create; this gives every *other* human seat the same, closing the "second human
          // can't auth" gap the cutover surfaced. Agents stay credential-less (they claim with the team
          // agent key + a grant).
          ...(row.kind === 'human'
            ? { human_credential: mintCredential(ctx.db, row.id).credential }
            : {}),
        });
      }

      if (method === 'GET' && rest === '/members') {
        const team = requireTeam(ctx.db, slug);
        return sendJson(res, 200, {
          members: summarize(ctx, slug, team.id, tryAuth(ctx, slug, req)),
          // The team's role library (ADR 227 discovery): the roster answers "who can do X" only if
          // the roles themselves are visible beside the seats that hold them. Additive — an older
          // client ignores it.
          roles: listRoles(ctx.db, team.id),
        });
      }

      /* ─── sign-in handoff (ADR 170) ────────────────────────────────────────────────────────────
       * `musterd board` walks a human into the browser without either of them handling a secret: the
       * CLI stages the credential it already holds and gets back a nonce, which rides the URL
       * fragment; the browser redeems it once. The nonce is a handle to a one-time relay, not a
       * credential — worthless after a single read or sixty seconds, whichever comes first.
       *
       * Both ends are localhost-gated, and that is load-bearing rather than hardening: a link a
       * phone could redeem is a link that carries a permanent member credential onto a device the
       * ADR 040 trust boundary never covered. Cross-device sign-in needs a bounded credential and is
       * deliberately out of scope — it surfaces here as a loud refusal, not a silent success.
       */
      if (method === 'POST' && rest === '/signin-handoff') {
        const team = requireTeam(ctx.db, slug);
        requireLocalPeer(ctx, req, 'stage a sign-in handoff');
        const body = parseOrBadRequest(StageHandoffSchema, await readJson(req));
        // The caller must already hold this member's credential: the relay moves an authority, it
        // never issues one. A mismatch is the same `unauthorized` any bad credential gets.
        const { member } = authMember(ctx.db, slug, body.credential, body.member);
        const staged = stageHandoff({
          team: team.slug,
          member: member.name,
          credential: body.credential,
        });
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'signin.handoff_staged',
          target: member.name,
          result: 'allow',
          detail: { surface: 'cli' },
        });
        return sendJson(res, 201, staged);
      }

      /**
       * `GET /teams/:slug/local-identity` (ADR 222) — hand a page on THIS machine the identity the
       * CLI already holds, so signing into the office costs one click and no human ever handles a
       * secret by hand.
       *
       * **No nonce, deliberately.** ADR 170's nonce exists to make a CLI→browser *link* inert; when
       * the browser asks the daemon directly there is no link to make inert, nothing to expire, and
       * nothing to leak into history.
       *
       * `isLocalPeer` is the entire security boundary and is load-bearing rather than a hardening
       * detail: this route returns a member CREDENTIAL, so off-machine it would hand a second admin
       * the FIRST admin's identity. The refusal is counted as ADR 170's `off_machine` miss — the
       * pre-registered signal that earns the bounded-credential work both ADRs declined to do.
       */
      if (method === 'GET' && rest === '/local-identity') {
        const team = requireTeam(ctx.db, slug);
        requireLocalPeer(ctx, req, "read this machine's sign-in identity", () =>
          appendAudit(ctx.db, team.id, {
            actor: null,
            action: 'signin.handoff_missed',
            target: null,
            result: 'deny',
            detail: { reason: 'off_machine' },
          }),
        );
        const local = readLocalIdentity(team.slug);
        // The vault can name a seat this team has never heard of — a stale entry, a renamed seat, a
        // team recreated under the same slug. Confirm before offering, so the page is never handed a
        // credential that cannot connect and then blamed for the failure.
        if (!local || !getMemberByName(ctx.db, team.id, local.name)) {
          return sendJson(res, 200, { available: false });
        }
        // **The successful offer is deliberately NOT audited.** ADR 170's rows record discrete human
        // acts — running `musterd board`, redeeming a nonce once. This route is probed automatically
        // on every page load of an ambient surface the founder leaves open, so a row here would not
        // record an act at all: it would record *when the human had the office on screen*. That is
        // precisely the human-activity trail ADR 155 refuses to create ("no new record of when the
        // human was at their desk", surveillance-asymmetry, ADR 145). Measured in the exercise run:
        // four rows from three page loads, nobody having done anything.
        //
        // Nothing is lost. The ADR's evaluation measure is the first ask ever ANSWERED from a
        // browser, which is read off `accept`/`decline`/`wait` envelopes, not off this route. The
        // refusal below stays audited because a refused cross-machine attempt is a security event
        // about an action someone took, not a note about where a human was sitting.
        return sendJson(res, 200, { available: true, as: local.name, credential: local.key });
      }

      const handoffMatch = rest.match(/^\/signin-handoff\/([^/]+)$/);
      if (method === 'GET' && handoffMatch) {
        const team = requireTeam(ctx.db, slug);
        requireLocalPeer(ctx, req, 'redeem a sign-in link', () =>
          appendAudit(ctx.db, team.id, {
            actor: null,
            action: 'signin.handoff_missed',
            target: null,
            result: 'deny',
            detail: { reason: 'off_machine' },
          }),
        );
        const redeemed = redeemHandoff(team.slug, decodeURIComponent(handoffMatch[1]!));
        if (!redeemed) {
          // Unknown, expired, and already-redeemed are one answer on purpose — a caller holding a
          // nonce learns nothing from the difference, and the CLI's remedy is the same for all three.
          appendAudit(ctx.db, team.id, {
            actor: null,
            action: 'signin.handoff_missed',
            target: null,
            result: 'deny',
            detail: { reason: 'unknown_or_spent' },
          });
          throw new MusterdError(
            'not_found',
            // Names both surfaces (ADR 222): a nonce carries no record of which one staged it, and
            // telling someone who ran `musterd live` to run `musterd board` sends them to the wrong
            // page. The remedy is the same command they used, whichever it was.
            'that sign-in link was already used or has expired — run `musterd board` or ' +
              '`musterd live` again',
          );
        }
        appendAudit(ctx.db, team.id, {
          actor: redeemed.as,
          action: 'signin.handoff_redeemed',
          target: redeemed.as,
          result: 'allow',
          detail: { surface: 'web' },
        });
        return sendJson(res, 200, redeemed);
      }

      // The governance audit log (ADR 071, P2) — admin-only, since it exposes who-did-what across the
      // team. Newest-first, capped; `?limit=` and `?before=<ts>` page older entries. `detail` is parsed
      // back to an object for the client.
      if (method === 'GET' && rest === '/audit') {
        const { team } = authAdmin(ctx, slug, req);
        const limit = Number(url.searchParams.get('limit') ?? '');
        const before = Number(url.searchParams.get('before') ?? '');
        const authorizedBy = url.searchParams.get('authorized_by');
        const rows = listAudit(ctx.db, team.id, {
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          ...(Number.isFinite(before) && before > 0 ? { before } : {}),
          ...(authorizedBy ? { authorized_by: authorizedBy } : {}),
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

          // Issue a grant so the approved session can occupy the seat. A `ttl` grant is the ADR 087
          // resume token: reusable (single_use:false) and refreshed on each occupy — when no explicit
          // `ttl_hours` is given, fall back to the server's resume window so the token is always bounded
          // (never accidentally standing). `once`/`standing` are honored as the admin passed them.
          const ttlHours =
            body.lifetime === 'ttl'
              ? (body.ttl_hours ?? ctx.config.resumeTtlMs / 3_600_000)
              : undefined;
          const mint = issueGrant(
            ctx.db,
            team.id,
            {
              scope: existing.target?.startsWith('role:') ? 'role' : 'seat',
              target: targetMember.name,
              lifetime: body.lifetime,
              ...(ttlHours != null ? { ttl_hours: ttlHours } : {}),
              single_use: body.lifetime === 'once',
            },
            admin.name,
          );
          // Deliver the token to the occupying session for a reusable grant (ADR 087) so it lands in
          // `binding.grant` and silently resumes on reconnect. A `once` grant is not a resume token.
          const resumeToken = body.lifetime === 'once' ? undefined : mint.token;

          // Attach presence for the approved session — carrying the claimant's attestation (ADR 101)
          // so the approved occupancy isn't born `unknown`.
          const presence = attach(
            ctx.db,
            targetMember.id,
            existing.surface as import('@musterd/protocol').Surface,
            existing.from_session,
            { provenance: null, workspace: null, driver: null, model: existing.model ?? null },
          );
          if (existing.model) {
            appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'occupancy.model_attested',
              target: targetMember.name,
              result: 'allow',
              detail: {
                occupancy: presence.id,
                old: null,
                new: existing.model,
                source: 'claim',
              },
            });
          }

          // Settle the request.
          decideRequest(ctx.db, team.id, requestId, 'approved', admin.name);

          // Flip the waiting WS: find the pending connection and call _claimApproved.
          const pendingConn = ctx.hub.getConn(existing.from_session);
          if (pendingConn?._claimApproved) {
            pendingConn._claimApproved(presence.id);
          }

          // Push the terminal occupied frame to the waiting WS, carrying the resume token (ADR 087).
          const delivered = ctx.hub.deliverClaimDecision(existing.from_session, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            ...(resumeToken ? { grant: resumeToken } : {}),
            memory: memoryEnvelope(ctx.db, targetMember.id),
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
            detail: {
              decision: 'approve',
              request_id: requestId,
              delivered,
              authorized_by: admin.name,
            },
          });
          // ADR 127: the minted grant also gets a grant.issue row so the grant→authorizer join exists.
          appendAudit(ctx.db, team.id, {
            actor: admin.name,
            action: 'grant.issue',
            target: targetMember.name,
            result: 'allow',
            detail: {
              scope: mint.grant.scope,
              lifetime: mint.grant.lifetime,
              grant_id: mint.grant.id,
              via: 'request.decide',
              request_id: requestId,
              authorized_by: admin.name,
            },
          });
          // Also consume the grant if once (it was issued for the seat; the approve itself IS the use).
          if (body.lifetime === 'once') consumeGrant(ctx.db, mint.grant.id);
          return sendJson(res, 200, {
            request_id: requestId,
            decision: 'approve',
            delivered,
            // The resume token, echoed for a stateless/HTTP claimer that can't receive the pushed frame.
            ...(resumeToken ? { grant: resumeToken } : {}),
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
            detail: {
              decision: 'deny',
              request_id: requestId,
              delivered,
              authorized_by: admin.name,
            },
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
          detail: {
            scope: body.scope,
            lifetime: body.lifetime,
            grant_id: mint.grant.id,
            authorized_by: member.name,
          },
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

      // Soft-archive the team (the inverse of POST /teams). Admin-only + audited: archiving pulls the
      // team off every surface at once (requireTeam treats archived as gone), so it carries the same
      // authority bar as the other governance writes. Auth resolves BEFORE the archive lands, so the
      // admin of a live team can always reach this; a second call 404s on auth ("team is archived").
      if (method === 'POST' && rest === '/archive') {
        const { team, member } = authAdmin(ctx, slug, req);
        const { archived_at } = archiveTeam(ctx.db, slug);
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'team.archive',
          target: slug,
          result: 'allow',
        });
        return sendJson(res, 200, { ok: true, team: slug, archived_at });
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
        // ADR 185: the wire carries the SPARSE doc — only the knobs an admin chose — and the row
        // stores it verbatim. Replace semantics, so an omitted key is unset and its default comes
        // back to life. The audit records the request, not the parsed result: the old row wrote
        // `detail: policy` post-parse, which is exactly why nothing could later say whether a stored
        // value was chosen or baked in.
        const stored = parseOrBadRequest(PolicyOverrideSchema, await readJson(req));
        const policy = setPolicy(ctx.db, team.id, stored);
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'policy.change',
          target: null,
          result: 'allow',
          detail: stored,
        });
        return sendJson(res, 200, { policy, stored });
      }

      // The read half of the policy verb (increment 5): `musterd residency policy` does
      // read → merge → POST, so admins can set one knob without re-stating the rest. It merges into
      // `stored` (ADR 185) — merging into `policy` is what re-densified the row on every write.
      if (method === 'GET' && rest === '/policy') {
        const { team } = authAdmin(ctx, slug, req);
        return sendJson(res, 200, {
          policy: getPolicy(ctx.db, team.id),
          stored: getStoredPolicy(ctx.db, team.id),
        });
      }

      // ── PreToolUse enforcement gates (ADR 150 — structural inducement) ──────────────────────────
      // The class table is member-readable (unlike the full policy, which is admin-only and carries the
      // secret webhook): every seat's hook needs it to match tool calls CLIENT-side, and a class name +
      // its globs are not secret. This is the ONLY policy sub-field exposed to members — the read is
      // scoped to `enforcement` so the webhook never leaks through it.
      if (method === 'GET' && rest === '/enforcement') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        return sendJson(res, 200, { enforcement: getPolicy(ctx.db, team.id).enforcement });
      }

      // The gate ingest: the hook POSTs the shapes of a MATCHED tool call (never an undeclared one), the
      // daemon adjudicates atomically (race-safe dedup/emit/release for Gate B) and records one
      // shapes-only `lane.gate`/`action.gate` audit row. Member-authed AS the acting seat, so a Gate B
      // ask is raised through the seat's own credential. Best-effort semantics live in the hook, not
      // here: this route answers honestly, and the hook fails OPEN on any error (never wedge a seat).
      if (method === 'POST' && rest === '/gate') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const gateReq = parseOrBadRequest(GateCheckRequestSchema, await readJson(req));
        const decision = adjudicateGate(ctx, team, member, gateReq);
        return sendJson(res, 200, decision);
      }

      // ── Actor attestation (ADR 163) — who did it, never whether it was allowed ──────────────────
      // The hook POSTs this for a write-shaped call carrying an `agent_id` (a subagent wrote under its
      // parent seat's identity) or for a spawn (the denominator). It is NOT a gate: there is no
      // decision to return, so the response is an empty 202 and the hook never awaits it — an observer
      // on the critical path would be the latency tax ADR 163's guard metric forbids. Fires on
      // UNDECLARED calls by design, which the amended ADR 150 §Gate B boundary permits precisely
      // because nothing here can change whether the call proceeds.
      if (method === 'POST' && rest === '/actor') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const att = parseOrBadRequest(ActorAttestationSchema, await readJson(req));
        recordActorAttestation(ctx, team, member, att);
        return sendJson(res, 202, {});
      }

      // ── Harness residency: the wake ledger (ADR 131, increment 2) ──────────────────────────────
      // Enrollment is the authorization event (admin-authorized, actor≠authorizer per ADR 127):
      // one verb writes the enrollment row + mints the standing resume grant whose revocation is
      // the kill switch. The grant token travels ONCE in this response — the CLI writes it into the
      // seat's `binding.grant`, so woken sessions occupy via the seat's own credential and the
      // daemon never holds it.
      if (method === 'POST' && rest === '/residency/enroll') {
        const { team, member: authorizer, viaFallback } = authGovernance(ctx, slug, req);
        const body = parseOrBadRequest(EnrollResidencyBodySchema, await readJson(req));
        const target = getMemberByName(ctx.db, team.id, body.seat);
        if (!target || target.left_at !== null)
          throw new MusterdError('not_found', `no seat "${body.seat}" in team "${slug}"`);
        // Residency resurrects *harness* sessions — an agent-seat concept. A human's reachability
        // path is notify (ADR 024/035); an observer never participates at all.
        // UX papercut (dogfood 2026-07-13): the common miss is `--as nick` naming the AUTHORIZER
        // while the seat fell back to the human's own identity — the error must name the fix.
        if (target.kind !== 'agent' || target.observer === 1)
          throw new MusterdError(
            'forbidden',
            `residency enrolls agent seats — "${body.seat}" is a ` +
              `${target.observer === 1 ? 'observer' : target.kind} seat. Run \`musterd residency on\` ` +
              `in the agent's workspace (or pass --seat <agent>); --as names who authorizes, not what enrolls`,
          );
        const status = resolveAccountStatus(target);
        if (status === 'disabled' || status === 'banned')
          throw new MusterdError('forbidden', `seat "${body.seat}" is ${status}`);

        // Standing-while-enrolled (the considered ADR 087 exception): a quiet week must not make
        // the seat unwakeable, so control moves from TTL decay to explicit revocation.
        const mint = issueGrant(
          ctx.db,
          team.id,
          { scope: 'seat', target: target.name, lifetime: 'standing', single_use: false },
          authorizer.name,
        );
        const { row, previous } = enrollResidency(ctx.db, team.id, {
          member_id: target.id,
          harness: body.harness,
          host: body.host,
          grant_id: mint.grant.id,
          authorized_by: authorizer.name,
          // Sparse knob override (increment 5): absent = preserve, `{}` = clear, object = replace.
          ...(body.policy !== undefined ? { policy: body.policy } : {}),
        });
        // Last-enrolled-wins: the superseded enrollment's grant dies with it (no orphan standing
        // grants), and the host swap is named in the audit detail.
        if (previous?.grant_id) revokeGrant(ctx.db, team.id, previous.grant_id);
        appendAudit(ctx.db, team.id, {
          actor: authorizer.name,
          action: 'residency.enrolled',
          target: target.name,
          result: 'allow',
          detail: {
            harness: body.harness,
            host: body.host,
            grant_id: mint.grant.id,
            authorized_by: authorizer.name,
            ...(body.policy !== undefined ? { policy: body.policy } : {}),
            ...(previous ? { previous_host: previous.host } : {}),
            ...(viaFallback ? { fallback: 'no-admin' } : {}),
          },
        });
        appendAudit(ctx.db, team.id, {
          actor: authorizer.name,
          action: 'grant.issue',
          target: target.name,
          result: 'allow',
          detail: {
            scope: 'seat',
            lifetime: 'standing',
            grant_id: mint.grant.id,
            via: 'residency.enroll',
            authorized_by: authorizer.name,
          },
        });
        // Grant-rotation trap (dogfood 2026-07-13): a re-enroll revokes the previous standing
        // grant, but a LIVE session still holds it in its adapter — name that so the operator
        // knows the new grant/policy only govern from the seat's next wake/claim.
        const seatLive = hasLivePresence(ctx.db, target.id, ctx.config.presenceTimeoutMs);
        return sendJson(res, 201, {
          residency: toResidency(row, team.slug, target.name),
          grant: mint.token,
          ...(seatLive ? { seat_live: true } : {}),
        });
      }

      // The kill switch (`musterd residency off`): the seat itself or an admin — revocation must
      // be easy. Reverses the enrollment and revokes the standing grant in one verb.
      if (method === 'POST' && rest === '/residency/revoke') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(RevokeResidencyBodySchema, await readJson(req));
        const target = getMemberByName(ctx.db, team.id, body.seat);
        if (!target || target.left_at !== null)
          throw new MusterdError('not_found', `no seat "${body.seat}" in team "${slug}"`);
        const selfRevoke = member.id === target.id;
        if (!selfRevoke && !resolveCapabilities(member).is_admin && teamHasAdmin(ctx.db, team.id))
          throw new MusterdError(
            'forbidden',
            `revoking another seat's residency requires an admin seat (is_admin)`,
          );
        const removed = revokeResidency(ctx.db, team.id, target.id);
        if (!removed)
          throw new MusterdError('not_found', `seat "${body.seat}" is not enrolled in residency`);
        if (removed.grant_id) revokeGrant(ctx.db, team.id, removed.grant_id);
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'residency.revoked',
          target: target.name,
          result: 'allow',
          detail: {
            host: removed.host,
            ...(removed.grant_id ? { grant_id: removed.grant_id } : {}),
            authorized_by: member.name,
          },
        });
        return sendJson(res, 200, { ok: true });
      }

      // The team's enrollments (`musterd residency status`) — any authenticated member may read;
      // the roster already shows the same fact as `wakeable`.
      if (method === 'GET' && rest === '/residency') {
        const { team } = authTouch(ctx, slug, req);
        const residency = listResidency(ctx.db, team.id).map((r) =>
          toResidency(r, team.slug, getMemberById(ctx.db, r.member_id)?.name ?? '?'),
        );
        // Team wake-policy defaults ride along (increment 5) so `residency status` can render the
        // effective policy per seat and star the overridden knobs — one read, no drift.
        return sendJson(res, 200, {
          residency,
          policy_defaults: getPolicy(ctx.db, team.id).residency,
        });
      }

      // The host's poll (ADR 131 §4): one transaction derives due wakes, inserts leases, returns
      // orders — double-spawn is structurally impossible. Agent-key auth, no seat (the host is
      // infrastructure); the response carries structured fields only, never message bodies.
      if (method === 'POST' && rest === '/residency/wake-leases') {
        const team = authAgentKeyOnly(ctx, slug, req);
        const body = parseOrBadRequest(WakeLeasesBodySchema, await readJson(req));
        const orders = claimWakeLeases(
          ctx.db,
          team.id,
          team.slug,
          body.host,
          ctx.config.presenceTimeoutMs,
        );
        return sendJson(res, 200, { orders });
      }

      // The host's outcome report: settles the lease and writes the actuation audit — the
      // `residency.woke`/`wake_failed` rows the rate policy (cooldown / hourly cap / attempt cap)
      // is derived from. No session ids cross here (ADR 131 §5 — ids stay in `binding.session`).
      if (method === 'POST' && rest === '/residency/wake-report') {
        const team = authAgentKeyOnly(ctx, slug, req);
        const body = parseOrBadRequest(WakeReportBodySchema, await readJson(req));
        const lease = settleWakeLease(ctx.db, team.id, body.lease_id);
        if (!lease) {
          const settled = ctx.db
            .prepare<
              [string, string],
              { member_id: string; act_id: string | null; lane_id: string | null }
            >('SELECT member_id, act_id, lane_id FROM wake_leases WHERE team_id = ? AND id = ?')
            .get(team.id, body.lease_id);
          if (!settled)
            throw new MusterdError('not_found', `no wake lease "${body.lease_id}" on ${slug}`);
          // The supplementary cost record (increment 5): the primary report landed at verification,
          // but harness-attested cost/duration only exist at run exit — a second report carrying
          // them lands as `residency.wake_cost` (outside every rate/attempt derivation; the wake
          // metrics dedupe by lease_id). A cost-less duplicate is still a conflict — the mutual-
          // exclusion guard against a double-reporting host stays intact.
          if (body.cost_usd !== undefined || body.duration_ms !== undefined) {
            appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'residency.wake_cost',
              target: getMemberById(ctx.db, settled.member_id)?.name ?? '?',
              result: 'allow',
              detail: {
                act: wakeExhaustionKey(settled.act_id, settled.lane_id),
                lease_id: body.lease_id,
                ...(body.cost_usd !== undefined ? { cost_usd: body.cost_usd } : {}),
                ...(body.duration_ms !== undefined ? { duration_ms: body.duration_ms } : {}),
                ...(body.delivery_outcome ? { delivery_outcome: body.delivery_outcome } : {}),
                ...(body.exact_match ? { exact_match: body.exact_match } : {}),
                ...(body.transcript_bytes !== undefined
                  ? { transcript_bytes: body.transcript_bytes }
                  : {}),
                ...(body.transcript_age_ms !== undefined
                  ? { transcript_age_ms: body.transcript_age_ms }
                  : {}),
              },
            });
            return sendJson(res, 200, {
              ok: true,
              lease_id: body.lease_id,
              status: 'cost_recorded',
            });
          }
          throw new MusterdError('conflict', `lease "${body.lease_id}" is already reported`);
        }
        const seat = getMemberById(ctx.db, lease.member_id);
        const sender = lease.act_id
          ? ctx.db
              .prepare<[string, string], { name: string }>(
                `SELECT mem.name AS name FROM messages m JOIN members mem ON mem.id = m.from_member
              WHERE m.team_id = ? AND m.id = ?`,
              )
              .get(team.id, lease.act_id)
          : undefined;
        const enrollment = getResidency(ctx.db, team.id, lease.member_id);
        // A deferral (increment 4's local-session guard) is its own verb, NOT a failure: it is
        // excluded by construction from the derived rate/attempt reads (they count woke+wake_failed
        // only), so a human working in the worktree can never exhaust the act — and it feeds the
        // `WAKE_DEFER_SNOOZE_MS` skip in the next lease derivation.
        const action = body.deferred
          ? 'residency.wake_deferred'
          : body.occupied
            ? 'residency.woke'
            : 'residency.wake_failed';
        appendAudit(ctx.db, team.id, {
          actor: null,
          action,
          target: seat?.name ?? '?',
          result: body.occupied || body.deferred ? 'allow' : 'deny',
          detail: {
            act: wakeExhaustionKey(lease.act_id, lease.lane_id),
            sender: sender?.name ?? (lease.act_id ? '?' : 'board'),
            lease_id: lease.id,
            lane: lease.lane,
            ...(lease.lane_id ? { lane_id: lease.lane_id } : {}),
            ...(enrollment?.grant_id ? { grant_id: enrollment.grant_id } : {}),
            ...(body.session ? { session: body.session } : {}),
            ...(body.delivery_outcome ? { delivery_outcome: body.delivery_outcome } : {}),
            // ADR 210: WHY an eligible wake resumed or did not. `delivery_outcome` says what
            // happened; without this the Eval cannot split the eligible cohort.
            ...(body.exact_match ? { exact_match: body.exact_match } : {}),
            ...(body.transcript_bytes !== undefined
              ? { transcript_bytes: body.transcript_bytes }
              : {}),
            ...(body.transcript_age_ms !== undefined
              ? { transcript_age_ms: body.transcript_age_ms }
              : {}),
            ...(body.answered !== undefined ? { answered: body.answered } : {}),
            ...(body.cost_usd !== undefined ? { cost_usd: body.cost_usd } : {}),
            ...(body.duration_ms !== undefined ? { duration_ms: body.duration_ms } : {}),
            ...(body.reason ? { reason: body.reason } : {}),
          },
        });
        return sendJson(res, 200, { ok: true, lease_id: lease.id, status: 'reported' });
      }

      // The resumable attestation (ADR 131 §5, increment 4): `musterd session start|end --stdin`
      // pushes harness CLASS + event only — never a session id, never a transcript path (the body
      // schema has no field for them). Agent-key auth like the other host-side residency routes;
      // presence-neutral by nature (this handler touches no presence row) and it never claims —
      // a hook must never displace the live occupant (ADR 108).
      if (method === 'POST' && rest === '/residency/session') {
        const team = authAgentKeyOnly(ctx, slug, req);
        const body = parseOrBadRequest(SessionAttestationBodySchema, await readJson(req));
        const target = getMemberByName(ctx.db, team.id, body.seat);
        if (!target || target.left_at !== null)
          throw new MusterdError('not_found', `no seat "${body.seat}" in team "${slug}"`);
        const enrolled =
          body.event === 'start'
            ? recordSessionAttestation(ctx.db, team.id, target.id, body.harness)
            : getResidency(ctx.db, team.id, target.id) !== null;
        appendAudit(ctx.db, team.id, {
          actor: null,
          action: body.event === 'start' ? 'residency.session_captured' : 'residency.session_ended',
          target: target.name,
          result: 'allow',
          detail: { harness: body.harness, enrolled },
        });
        return sendJson(res, 200, { ok: true, enrolled });
      }

      // P3.2 stateless claim mirror (SPEC A.7, ADR 077) — unauthenticated (key in body, not Bearer).
      // Response bodies ARE the WS frame shapes: 200=occupied, 202=pending, 4xx=refused.
      if (method === 'POST' && rest === '/claim') {
        const ClaimBody = z.object({
          key: z.string(),
          target: ClaimTargetSchema,
          grant: z.string().optional(),
          surface: SurfaceSchema,
          // Model attestation (ADR 101), mirroring the WS claim frame — attested, never verified.
          model: z.string().max(120).optional(),
          // Build attestation (ADR 135), mirroring the WS claim frame. No requests-table carry: a
          // grant-less claim that goes through approval gets its build installed by the very next
          // authed request's `x-musterd-build` ambient touch (sticky COALESCE).
          build: z.string().max(64).optional(),
          // Feature epoch (ADR 148), mirroring the WS claim frame — the roster's skew signal.
          epoch: z.number().int().nonnegative().optional(),
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

        // Step 2b: SECURITY — the shared team agent key may only occupy an AGENT seat. Deliberately
        // here: AFTER target resolution (a `role` target can resolve to a human seat) and BEFORE the
        // grant/request branches below, so a poisoned claim is never queued for an admin to approve.
        // `authenticatedMember === null` is exactly the agent-key branch; a human credential already
        // proved it identifies the target seat above.
        if (authenticatedMember === null && !agentKeyMayOccupy(targetMember)) {
          const refusal = agentKeySeatKindRefusal(targetMember.name);
          return sendJson(res, 403, {
            type: 'refused',
            code: 'forbidden',
            message: refusal.message,
            claimable: [],
            hint: refusal.hint,
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
          // Resume token (ADR 087): refresh a reusable grant's TTL on occupy (no-op for single_use).
          refreshGrant(ctx.db, gv.grant.id, ctx.config.resumeTtlMs);
          // OCCUPY: stateless — attach presence with null connId (no persistent socket).
          const presence = attach(ctx.db, targetMember.id, body.surface, null, {
            provenance: null,
            workspace: null,
            driver: null,
            model: body.model ?? null,
            build: body.build ?? null,
            epoch: body.epoch ?? null,
          });
          markBound(ctx.db, targetMember.id);
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.occupied',
            target: targetMember.name,
            result: 'allow',
            detail: { via: 'http', surface: body.surface },
          });
          if (body.model) {
            appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'occupancy.model_attested',
              target: targetMember.name,
              result: 'allow',
              detail: { occupancy: presence.id, old: null, new: body.model, source: 'claim' },
            });
          }
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
            memory: memoryEnvelope(ctx.db, targetMember.id),
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
            model: body.model ?? null,
            build: body.build ?? null,
            epoch: body.epoch ?? null,
          });
          markBound(ctx.db, targetMember.id);
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.occupied',
            target: targetMember.name,
            result: 'allow',
            detail: { via: 'http', surface: body.surface, auth: 'credential' },
          });
          if (body.model) {
            appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'occupancy.model_attested',
              target: targetMember.name,
              result: 'allow',
              detail: { occupancy: presence.id, old: null, new: body.model, source: 'claim' },
            });
          }
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
            memory: memoryEnvelope(ctx.db, targetMember.id),
          });
        }

        // Dogfood-mode re-seat (ADR 146, on ADR 145 §7) — the stateless mirror of the WS branch. An
        // agent harness (team agent key, `authenticatedMember === null`) re-claiming an already-bound
        // named agent seat occupies immediately, as a notification, not an admin decision: the
        // seat-claim wall was a stranger-gate firing on teammates. Never-bound seats, role-pool claims,
        // and human seats stay gated (admission is still a decision). Derived from `policy + bound_at`.
        if (
          authenticatedMember === null &&
          'seat' in body.target &&
          targetMember.kind === 'agent' &&
          isHeld(targetMember) &&
          getPolicy(ctx.db, team.id).standing_reseat_known_agents
        ) {
          const presence = attach(ctx.db, targetMember.id, body.surface, null, {
            provenance: null,
            workspace: null,
            driver: null,
            model: body.model ?? null,
            build: body.build ?? null,
            epoch: body.epoch ?? null,
          });
          markBound(ctx.db, targetMember.id);
          appendAudit(ctx.db, team.id, {
            actor: targetMember.name,
            action: 'claim.reseated',
            target: targetMember.name,
            result: 'allow',
            detail: { via: 'http', surface: body.surface, policy: 'standing_reseat_known_agents' },
          });
          if (body.model) {
            appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'occupancy.model_attested',
              target: targetMember.name,
              result: 'allow',
              detail: { occupancy: presence.id, old: null, new: body.model, source: 'claim' },
            });
          }
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
            memory: memoryEnvelope(ctx.db, targetMember.id),
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
          // Carry the attestation across the approval gap (ADR 101).
          model: body.model ?? null,
          // A specific-seat claim collapses to one pending request per seat (no reconnect pile-up).
          collapseByTarget: 'seat' in body.target,
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
        // No sender occupancy id here by design (ADR 101): a POST is stateless — it authenticates a
        // *seat* (agent key + acting seat), not a live session, so there is no per-request occupancy
        // to key the model stamp on. routeEnvelope falls back to the member's newest *attested*
        // presence — which for a single-active agent is its live claim, or (ADR 119) the ambient row
        // re-attested from `x-musterd-model` after that claim ages out. (A human fanned out over
        // several attested sessions on different models is the one ambiguous case; the stateless
        // request carries nothing to disambiguate it.)
        const result = routeEnvelope(ctx, team, member, env);
        // Dependency-targeted invalidation (ADR 111, ADR 088 §5): a `defer` — or a `steer` that names a
        // Goal — bumps that Goal's epoch, so any live lane claimed against the older epoch (on the Goal,
        // or building on a lane on it) is now stale. Wake exactly those owners, never the team. Rides the
        // same directed-wake helper as contention warnings; best-effort, warn-never-block.
        if (env.act === 'defer' || env.act === 'steer') {
          const goalId = (env.meta as { goal_id?: unknown } | null | undefined)?.goal_id;
          if (typeof goalId === 'string' && goalId.trim().length > 0) {
            deliverLaneWarnings(
              ctx,
              team,
              member,
              staleLaneWarnings(ctx.db, team.id, team.slug, goalId),
            );
          }
        }
        const ack = rowToEnvelope(
          result.message,
          team.slug,
          member.name,
          env.to.kind === 'member' ? env.to.name : null,
        );
        // An `ask` ack additionally carries the derived tier contract WITH the reachability projection
        // (ADR 153 §1): `unblocker_reachable` is a fact only the daemon can compute (admin roster +
        // presence + enforcement policy), so it rides the send response beside the pure tier numbers the
        // clients already derive — additive, older clients ignore it, older daemons omit it.
        const askTier = env.act === 'ask' ? AskTierSchema.safeParse(env.meta?.['tier']) : null;
        // The delivery hint (ADR 167 §2): a directed act to a live recipient invites the SENDER — the
        // one party reliably holding the harness's session-send tool — to relay a daemon-composed
        // one-line nudge. Same additive contract as `ask_contract` above; null (the common case) means
        // the ack is exactly what it was before the ADR.
        const decision = deliveryHintFor(
          ctx.db,
          result.message,
          member.name,
          ctx.config.presenceTimeoutMs,
        );
        const hint = decision.hint;
        if (hint) recordCcdNudge('hinted');
        // Every decision counted by reason, so the `issued` count has a denominator (ADR 173) — and,
        // because that counter is OTel and off by default here, a DURABLE row for the decisions that
        // were actually about the rail. Gated on isRailCandidate: the excluded reasons cover nearly
        // every message ever sent, and mirroring those into the audit log would drown it. All-time the
        // gated population is ~40 rows, so this is free and makes the zero queryable:
        //   SELECT json_extract(detail,'$.reason'), COUNT(*) FROM audit
        //     WHERE action = 'nudge.decision' GROUP BY 1;
        recordNudgeDecision(decision.reason);
        if (isRailCandidate(decision.reason)) {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'nudge.decision',
            target: result.message.id,
            result: 'allow',
            detail: {
              reason: decision.reason,
              act: result.message.act,
              message: result.message.id,
              rail: 'ccd_session',
            },
          });
        }
        if (askTier?.success) {
          return sendJson(res, 201, {
            ack,
            ask_contract: {
              ...askContract(askTier.data),
              unblocker_reachable: unblockerReachable(
                ctx.db,
                team.id,
                member.name,
                ctx.config.presenceTimeoutMs,
              ),
            },
            ...(hint ? { delivery_hint: hint } : {}),
          });
        }
        return sendJson(res, 201, { ack, ...(hint ? { delivery_hint: hint } : {}) });
      }

      // ── Coordination lanes, Phase 1 (ADR 083) — the { work-item × owner × surface } board. All
      // member-authed; every mutation returns { lane, warnings } (warn-only, never a rejection).
      if (method === 'GET' && rest === '/lanes') {
        const { team, member } = authTouch(ctx, slug, req);
        const lanes = listLanes(ctx.db, team.id, team.slug, {
          ...(url.searchParams.get('project') !== null
            ? { project: url.searchParams.get('project')! }
            : {}),
          ...(url.searchParams.get('mine') === '1' ? { owner: member.name } : {}),
          ...(url.searchParams.get('open') === '1' ? { openOnly: true } : {}),
          ...(url.searchParams.get('goal') !== null
            ? { goalId: url.searchParams.get('goal')! }
            : {}),
        });
        // Contention warnings (ADR 083) + staleness warnings (ADR 111 §5), one board read. Staleness is
        // team-wide (a Goal's epoch is a team fact); intersect it with the lanes this filtered view shows
        // so `?mine=1` / `?goal=` scopes carry only their own stale flags.
        const shown = new Set(lanes.map((l) => l.id));
        const warnings = [
          ...boardWarnings(ctx.db, team.id, team.slug, lanes),
          ...staleLaneWarnings(ctx.db, team.id, team.slug).filter((w) => shown.has(w.subject)),
        ];
        // ADR 169: annotate done lanes with the derived verified-ness of their close — read from the
        // lane.closed audit rows, never stored on the lane. Absent = unknown (pre-169 closes).
        const verdicts = verifiedCloses(ctx.db, team.id);
        const annotated = lanes.map((l) =>
          l.state === 'done' && verdicts.has(l.id) ? { ...l, verified: verdicts.get(l.id)! } : l,
        );
        return sendJson(res, 200, { lanes: annotated, warnings });
      }

      // The orientation brief (ADR 049/084) — derived floor over the daemon's own lane/act state.
      if (method === 'GET' && rest === '/next') {
        const { team, member } = authTouch(ctx, slug, req);
        return sendJson(res, 200, deriveNext(ctx.db, team.id, team.slug, member.name));
      }

      // Portable wake context (ADR 209): the recipient gets a bounded, server-derived index after
      // occupying. It names explicit reads but never carries an Act or memory body.
      if (method === 'POST' && rest === '/wake-context') {
        const { team, member } = authTouch(ctx, slug, req);
        const target = parseOrBadRequest(WakeContextRequestSchema, await readJson(req));
        // Audit both allow and deny (ADR 209 follow-up): an authorization boundary that only records
        // successes cannot answer "did anyone probe for lanes they do not own". The deny row uses the
        // request's named id as `target` — same shape as allow — without disclosing whether it exists
        // (the HTTP response stays a uniform forbidden).
        try {
          const context = buildWakeContext(ctx.db, team, member, target);
          const response = WakeContextResponseSchema.parse({ context });
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'residency.context_read',
            target: target.act_id ?? target.lane_id ?? '?',
            result: 'allow',
            detail: {
              kind: context.wake.kind,
              version: context.version,
              bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
              fetch: context.fetch,
              fetch_count: context.fetch.length,
              delivery: context.delivery,
            },
          });
          return sendJson(res, 200, response);
        } catch (e) {
          if (e instanceof MusterdError && e.code === 'forbidden') {
            appendAudit(ctx.db, team.id, {
              actor: member.name,
              action: 'residency.context_read',
              target: target.act_id ?? target.lane_id ?? '?',
              result: 'deny',
              detail: {
                reason: 'forbidden',
                // Request shape only — not derived from whether the target exists.
                target_kind: target.act_id !== undefined ? 'act' : 'lane',
              },
            });
          }
          throw e;
        }
      }

      // The insight report (ADR 050/084) — one server-side projection: flow metrics, the waiting-on
      // view, declared Goals with derived status, and blocked-lane exceptions. Altitude framing is a
      // rendering concern for the surfaces; the engine computes everything once.
      if (method === 'GET' && rest === '/report') {
        const { team, member: _member } = authTouch(ctx, slug, req);
        return sendJson(
          res,
          200,
          deriveReport(ctx.db, team.id, team.slug, Date.now(), ctx.config.presenceTimeoutMs),
        );
      }

      // Tool-call telemetry ingest (ADR 144 inc 1): the adapter's batched flush of its own MCP
      // tool invocations, folded into the hourly aggregate; the once-per-session rendered-surface
      // weight rides the first flush and lands as an `mcp.surface_rendered` audit row. The caller
      // role is stamped HERE from the member row (the from_provenance rule — never a wire field).
      // The adapter sends x-musterd-no-touch: telemetry is presence-neutral by contract.
      if (method === 'POST' && rest === '/telemetry/tool-calls') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(ToolTelemetryReportSchema, await readJson(req));
        recordToolCalls(ctx.db, team.id, member.name, member.role || null, body.events);
        if (body.surface) recordSurfaceRender(ctx.db, team.id, member.name, body.surface);
        return sendJson(res, 200, {});
      }

      // Declared Goals (ADR 048's general-team seam, resolved by ADR 084) — a Goal is an ordinary
      // `message` act to `@team` carrying `meta.goal`; no new act, no new table. Status is derived,
      // never stored, same as everything else in the orientation spine.
      if (method === 'GET' && rest === '/goals') {
        const { team, member: _member } = authTouch(ctx, slug, req);
        return sendJson(res, 200, { goals: listGoals(ctx.db, team.id, team.slug) });
      }

      if (method === 'POST' && rest === '/goals') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(DeclareGoalSchema, await readJson(req));
        const env = makeEnvelope({
          id: ulid(),
          team: team.slug,
          from: member.name,
          to: { kind: 'team' },
          act: 'message',
          body: `[goal] declared "${body.title}"`,
          meta: {
            goal: { id: body.id, title: body.title, wave: body.wave, depends_on: body.depends_on },
          },
        });
        routeEnvelope(ctx, team, member, env);
        const goal = listGoals(ctx.db, team.id, team.slug).find((g) => g.id === body.id)!;
        return sendJson(res, 201, { goal });
      }

      if (method === 'POST' && rest === '/lanes') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(OpenLaneSchema, await readJson(req));
        const lane = openLane(ctx.db, team.id, team.slug, member.name, body);
        // The acquisition ledger (ADR 203) must cover every edge that decides who owns work. The
        // PATCH handler records claims and handoffs; this is the third edge — a lane born owned via
        // `{claim:true}` — which is the most common acquisition of all and was the one left
        // unwritten, so a ledger reconstruction would have missed the ordinary case. No collision is
        // possible here (the lane did not exist), hence no guard: just the row, marked `at_open` so
        // a reader can tell a birth from a takeover.
        if (lane.owner_seat) {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'lane.claimed',
            target: lane.id,
            result: 'allow',
            detail: {
              lane: lane.id,
              owner: lane.owner_seat,
              previous_owner: null,
              kind: 'claim',
              at_open: true,
            },
          });
        }
        const warnings = laneWarnings(ctx.db, team.id, team.slug, lane);
        deliverLaneWarnings(ctx, team, member, warnings); // all warnings are fresh at open
        deliverLaneTeamAct(ctx, team, member, `[lane] opened "${lane.title}"`, {
          lane_open: { lane: lane.id, title: lane.title, project: lane.project },
        });
        return sendJson(res, 201, { lane, warnings });
      }

      const laneMatch = rest.match(/^\/lanes\/([^/]+)$/);
      if (method === 'PATCH' && laneMatch) {
        const { team, member } = authTouch(ctx, slug, req);
        const laneId = decodeURIComponent(laneMatch[1]!);
        const body = parseOrBadRequest(UpdateLaneSchema, await readJson(req));
        const before = getLane(ctx.db, team.id, laneId, team.slug);
        if (!before) throw new MusterdError('not_found', `no lane "${laneId}" on ${slug}`);
        // Claiming a lane someone else already holds is the one thing the board exists to prevent
        // ("never build in a lane a teammate owns"), and until now nothing checked it: `lane_claim`
        // is a bare PATCH of `owner_seat`, so a second claimant silently took the lane, got a
        // success back, and broadcast `[lane] claimed` to the team. Two seats then built the same
        // lane ~6 minutes apart (2026-08-01, lanes 01KYX8J5XD / 01KYXWNX9R).
        //
        // A CLAIM is distinguishable from a HANDOFF by the one signal the server already holds: who
        // the new owner is. Taking it for yourself is a claim; naming someone else is a handoff, a
        // deliberate give-away that must keep working. So this refuses only self-directed takeovers,
        // and only while the incumbent is LIVE — an offline or departed owner stays claimable, which
        // is the same posture ADR 196 took when it released departed seats' in-flight lanes.
        const takingForSelf =
          body.owner_seat !== undefined &&
          body.owner_seat === member.name &&
          before.owner_seat !== null &&
          before.owner_seat !== member.name;
        if (takingForSelf) {
          const incumbent = getMemberByName(ctx.db, team.id, before.owner_seat!);
          const incumbentLive =
            incumbent !== undefined &&
            hasLivePresence(ctx.db, incumbent.id, ctx.config.presenceTimeoutMs);
          if (incumbentLive) {
            throw new MusterdError(
              'conflict',
              `lane "${laneId}" is owned by ${before.owner_seat}, who is live — claiming it would ` +
                `duplicate their work. Pick another lane, or ask them to hand it over ` +
                `(lane_handoff) or release it.`,
            );
          }
        }
        const beforeKeys = new Set(
          laneWarnings(ctx.db, team.id, team.slug, before).map(laneWarningKey),
        );
        const lane = updateLane(ctx.db, team.id, laneId, team.slug, body)!;
        // The claim edge is the one that decides who owns work, and it was the only lane edge
        // writing no audit row at all — which is why reconstructing the collision above from the
        // audit log turned up nothing but the release. Record every ownership acquisition.
        if (
          body.owner_seat !== undefined &&
          lane.owner_seat &&
          lane.owner_seat !== before.owner_seat
        ) {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'lane.claimed',
            target: lane.id,
            result: 'allow',
            detail: {
              lane: lane.id,
              owner: lane.owner_seat,
              previous_owner: before.owner_seat,
              // A handoff and a self-claim are the same PATCH; only the audit can tell them apart
              // after the fact, so say which this was rather than leaving it to be inferred.
              kind: lane.owner_seat === member.name ? 'claim' : 'handoff',
              ...(before.owner_seat ? { takeover_of_offline_owner: true } : {}),
            },
          });
        }
        const warnings = laneWarnings(ctx.db, team.id, team.slug, lane);
        // Directed-wake dedup (ADR 083 §4): only warnings the mutation *introduced* wake the other
        // owner — re-surfacing unchanged conditions is the board's job, not the inbox's.
        deliverLaneWarnings(
          ctx,
          team,
          member,
          warnings.filter((w) => !beforeKeys.has(laneWarningKey(w))),
        );
        // A handoff (ownership moved to someone else) tells the recipient — with the branch, which is
        // the whole point (the redone-lane fix): the work arrives as an artifact, not a description.
        // It goes out as act `handoff`, not `message`: the act is what the wake ledger reads, so a
        // lane handed to an *offline* seat only reaches them if the act names the transfer. It rode as
        // a plain message until 2026-07-30, which made `lane_handoff`'s "the recipient gets a directed
        // wake" a promise the daemon never kept — measured, 10 minutes of host polling, zero leases.
        if (
          body.owner_seat !== undefined &&
          body.owner_seat !== before.owner_seat &&
          body.owner_seat !== member.name
        ) {
          deliverLaneAct(
            ctx,
            team,
            member,
            body.owner_seat,
            `[lane] "${lane.title}" handed to you${lane.branch ? ` — branch ${lane.branch}` : ''}`,
            { lane_handoff: { lane: lane.id, branch: lane.branch } },
            'handoff',
          );
        }
        // A self-claim (the actor took ownership of a lane that wasn't theirs) — the "who took it" the
        // board shows, now on the stream too: a noteless structural transition (ADR 102), unowned→owned
        // in the visible record. The foreign-owner case is the handoff above; this is the complement.
        if (
          body.owner_seat !== undefined &&
          body.owner_seat === member.name &&
          before.owner_seat !== member.name
        ) {
          deliverLaneTeamAct(ctx, team, member, `[lane] claimed "${lane.title}"`, {
            lane_claim: { lane: lane.id, title: lane.title },
          });
        }
        // A release (an owned lane moved back to `open` — the store cleared the owner as the state
        // machine's invariant). Letting go is as much a coordination fact as claiming, so it gets the
        // same pair: a team-visible note and an audit row naming who held it. The `lane_state`
        // broadcast below is suppressed for this edge — one event, not two.
        if (before.owner_seat !== null && lane.state === 'open' && before.state !== 'open') {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'lane.released',
            target: lane.id,
            result: 'allow',
            detail: { lane: lane.id, released_by: member.name, owner_before: before.owner_seat },
          });
          deliverLaneTeamAct(ctx, team, member, `[lane] released "${lane.title}" — open again`, {
            lane_release: { lane: lane.id, title: lane.title, owner_before: before.owner_seat },
          });
        }
        // A non-terminal state move (e.g. active↔blocked) — the "it's blocked / unblocked" transition,
        // noteless and daemon-composed (ADR 102). Terminal moves fall to the resolve emit below instead.
        if (
          body.state !== undefined &&
          body.state !== before.state &&
          !LANE_TERMINAL_STATES.has(lane.state) &&
          !(lane.state === 'open' && before.owner_seat !== null) // the release emit above owns this edge
        ) {
          deliverLaneTeamAct(ctx, team, member, `[lane] "${lane.title}" → ${lane.state}`, {
            lane_state: { lane: lane.id, title: lane.title, state: lane.state },
          });
        }
        // ADR 192: entering awaiting_acceptance is the worker's "technically complete" claim — audit
        // it (with any stage-one merge attestation) and compose the acceptance ask to the acceptor the
        // picker chose. No acceptor ⇒ no ask, and the response says self-close is sanctioned (the
        // ADR 145 degradation — never a wedge). Audit action stays `lane.ready_for_review` (frozen).
        let review: Record<string, unknown> | undefined;
        if (isAwaitingAcceptance(lane.state) && !isAwaitingAcceptance(before.state)) {
          // ADR 188 two-stage: for a risky lane the picker returns the PEER (agents-only ladder);
          // when no peer exists the human ask is not gated behind a stage that cannot happen —
          // fall back to the stage-two human directly, at the blocking tier, as before ADR 188.
          const worker = lane.owner_seat ?? member.name;
          const peerPick = pickReviewCounterpart(
            ctx.db,
            team.id,
            lane,
            worker,
            ctx.config.presenceTimeoutMs,
          );
          const humanFallback =
            lane.risk.length > 0 && !peerPick
              ? pickHumanReviewer(ctx.db, team.id, worker, ctx.config.presenceTimeoutMs)
              : null;
          let pick = peerPick ?? humanFallback;
          let wakeQueued = false;
          let breakerTripped = false;
          // ADR 191: when nobody live is eligible, try a marked-wakeable offline seat — only if the
          // review loop is enabled AND that seat is flow:auto AND the circuit breaker has not tripped.
          const teamPolicy = getPolicy(ctx.db, team.id);
          const posture = pick
            ? undefined
            : teamFamilyPosture(ctx.db, team.id, ctx.config.presenceTimeoutMs);
          if (!pick && lane.risk.length === 0 && posture) {
            if (reviewLoopBounceCount(ctx.db, team.id, lane.id) >= REVIEW_LOOP_BREAKER_N) {
              breakerTripped = true;
              const human = pickHumanReviewer(
                ctx.db,
                team.id,
                worker,
                ctx.config.presenceTimeoutMs,
              );
              if (human) {
                pick = human;
                deliverLaneAskAct(
                  ctx,
                  team,
                  member,
                  human.reviewer,
                  `[lane] review loop breaker: "${lane.title}" bounced ${String(REVIEW_LOOP_BREAKER_N)}+ times — decide (confirm or send back)`,
                  {
                    species: 'approve',
                    tier: 'blocking',
                    lane_review: {
                      lane: lane.id,
                      title: lane.title,
                      branch: lane.branch,
                      ...(lane.merged ? { merged: lane.merged } : {}),
                      route: human.route,
                      grade: human.grade,
                      breaker: true,
                    },
                  },
                );
              }
            } else if (teamPolicy.loops?.review === true) {
              const wakePick = pickWakeReviewer(ctx.db, team.id, worker, posture);
              if (wakePick) {
                const wakeMember = getMemberByName(ctx.db, team.id, wakePick.reviewer);
                const enrollment = wakeMember ? getResidency(ctx.db, team.id, wakeMember.id) : null;
                const seatPolicy = enrollment
                  ? effectiveWakePolicy(teamPolicy.residency, enrollment.policy)
                  : null;
                if (seatPolicy?.flow === 'auto') {
                  pick = wakePick;
                  wakeQueued = true;
                }
              }
            }
          }
          // Record the ROUTING OUTCOME here, where it is known. Without it the close edge can only
          // see "this lane passed through review" and calls every owner-close a `review_timeout` —
          // asserting a question was asked and went unanswered, when on a fleet with no eligible
          // counterpart nothing was ever asked. That conflation would make ADR 169's counter-metric
          // ("if nearly all review asks expire unanswered, the tier or the routing is wrong")
          // indict the tier and the picker for an empty candidate pool.
          // ADR 172: a declared risk tag makes HUMAN review a requirement, not a preference — the
          // picker no longer substitutes an agent when no human/admin is live, and the ready row
          // records the requirement so the close edge can derive `human_review_missed`.
          const humanRequired = lane.risk.length > 0;
          // ADR 172: when nobody is eligible, record WHY nobody was — the derived family posture.
          // Without it a run of no_candidate rows says "the pool was empty" but not what the pool
          // looked like, and the remedy (wake an enrolled seat vs. enroll one) is undecidable later.
          // Keep posture on wake_queued / breaker rows too — the remedy list still matters.
          const postureForAudit = pick && !wakeQueued && !breakerTripped ? undefined : posture;
          // ADR 217: the tier is decided HERE rather than at the ask, so the ready row can record
          // the wait the acceptor was actually promised. Without it the close edge has nothing to
          // compare `time_in_review_ms` against, and an owner closing after 8 seconds is recorded
          // as a timeout — which is what `review_timeout` measured for its whole life.
          const acceptanceTier: AskTier = breakerTripped
            ? 'blocking'
            : humanRequired && pick?.grade === 'human'
              ? 'blocking'
              : 'standard';
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'lane.ready_for_review',
            target: lane.id,
            result: 'allow',
            detail: {
              lane: lane.id,
              owner: lane.owner_seat,
              ...(lane.merged ? { merged: lane.merged } : {}),
              // ADR 188: the achieved rung of the diversity ladder rides beside the historical
              // two-value route, so a cross_model routing is never mistaken for a cross_family one.
              //
              // THIS GRADE IS THE ROUTING DECISION, NOT THE VERDICT'S WORTH. It is true when the ask
              // is composed and is never revised — deliberately, because rewriting it to match the
              // outcome would destroy the ability to ask why a seat was chosen. The grade that says
              // what the review was actually worth is re-derived from LIVE attestations at close
              // (`laneClose.ts`), and the two legitimately disagree when a seat changes model
              // between being asked and answering — which happens: a reviewer routed cross_model
              // re-attested to the worker's own model inside one 5-minute window on 2026-08-02.
              // Read the CLOSE row for diversity claims (ADR 056 counts from there); read this one
              // for routing behaviour. Mistaking the two reads a false defect into a healthy system.
              ...(pick
                ? {
                    reviewer: pick.reviewer,
                    route: pick.route,
                    review_grade: pick.grade,
                    ...(wakeQueued ? { wake_queued: true } : {}),
                    ...(breakerTripped ? { breaker_tripped: true } : {}),
                  }
                : {
                    no_candidate: true,
                    ...(breakerTripped ? { breaker_tripped: true } : {}),
                  }),
              // ADR 188: how the human requirement will be met — 'gated' (fires on the peer's
              // accept) vs 'immediate' (no peer existed). Absent on non-risky lanes.
              ...(humanRequired && pick
                ? { human_ask: pick.grade === 'human' ? 'immediate' : 'gated' }
                : {}),
              // ALWAYS written, both ways (ADR 173 correction #1). Omitting the `false` made absence
              // ambiguous — "not required" and "written before this field existed" were the same
              // row — which is what forced the read to serve a legacy row as a confident no. With
              // the boolean always present, absence means exactly "legacy", and the read can abstain.
              human_required: humanRequired,
              // ADR 217: the promised wait, written only where an ask was actually sent — a
              // `no_candidate` row promised nobody anything, and stamping a window on it would
              // invite the close edge to grade a wait that never began.
              ...(pick
                ? {
                    ask_tier: acceptanceTier,
                    ask_timeout_ms: askContract(acceptanceTier).timeout_ms,
                  }
                : {}),
              ...(postureForAudit
                ? {
                    family_posture: {
                      state: postureForAudit.state,
                      attesting: postureForAudit.attesting,
                      families: postureForAudit.families,
                      wake_pool: postureForAudit.wake_pool.length,
                    },
                  }
                : {}),
            },
          });
          if (pick && !breakerTripped) {
            // Name the overlap when the picked acceptor previously owned this lane (see
            // `priorOwnerNotice`). Read from the `lane.claimed` ledger, so it costs one indexed
            // audit query and never narrows the candidate pool.
            const priorOwners = laneOwnerHistory(ctx.db, team.id, lane.id);
            const overlapNotice = priorOwnerNotice(pick.reviewer, priorOwners);
            deliverLaneAskAct(
              ctx,
              team,
              member,
              pick.reviewer,
              acceptanceAskBody(lane.title, { overlapNotice }),
              {
                species: 'approve',
                // ADR 172/188: the HUMAN acceptance ask carries the holding tier (required has
                // teeth); a risky lane's stage-one PEER ask rides standard like any peer
                // acceptance — the blocking ask is composed at stage two, when the peer's accept
                // lands (route.ts). ADR 217: same value the ready row recorded as the promise —
                // one variable, so the promise and the ask can never drift apart.
                tier: acceptanceTier,
                lane_review: {
                  lane: lane.id,
                  title: lane.title,
                  branch: lane.branch,
                  ...(lane.merged ? { merged: lane.merged } : {}),
                  route: pick.route,
                  grade: pick.grade,
                },
              },
            );
            review = {
              reviewer: pick.reviewer,
              route: pick.route,
              grade: pick.grade,
              tier: humanRequired && pick.grade === 'human' ? 'blocking' : 'standard',
              ...(wakeQueued
                ? {
                    wake_queued: true,
                    wait_ms: teamPolicy.residency.work_timeout_ms,
                  }
                : {}),
              ...(humanRequired
                ? {
                    human_review_required: true,
                    human_ask: pick.grade === 'human' ? 'immediate' : 'gated',
                  }
                : {}),
            };
          } else if (pick && breakerTripped) {
            // Breaker already delivered the blocking human ask above.
            review = {
              reviewer: pick.reviewer,
              route: pick.route,
              grade: pick.grade,
              tier: 'blocking',
              breaker_tripped: true,
            };
          } else if (humanRequired) {
            // ADR 172: a risky lane with no live human/admin. NOT the sanctioned self-close — the
            // requirement stands; closing now is possible (never a wedge) but will be recorded as
            // `human_review_missed`, and the response says so before the worker chooses.
            review = {
              human_review_required: true,
              no_human_live: true,
              close_records: 'human_review_missed',
              ...(posture
                ? { family_posture: posture, posture_hint: describeFamilyPosture(posture) }
                : {}),
            };
          } else {
            // The sanction carries the posture so the degradation is legible at the point it is
            // read: not just "nobody was eligible" but what the team looked like and who could be
            // woken to change it (ADR 172). One bounded line — this lands in the worker's context.
            review = {
              self_close_sanctioned: true,
              ...(breakerTripped ? { breaker_tripped: true } : {}),
              ...(posture
                ? { family_posture: posture, posture_hint: describeFamilyPosture(posture) }
                : {}),
            };
          }
        }
        // ADR 192: an acceptor moving an awaiting_acceptance lane back to a live state is the
        // rejection — the counterpart said "not what we wanted". Audited; the lane_state broadcast above
        // already told the team. Audit action stays `lane.review_sent_back` (frozen).
        if (
          isAwaitingAcceptance(before.state) &&
          !LANE_TERMINAL_STATES.has(lane.state) &&
          !isAwaitingAcceptance(lane.state) &&
          member.name !== before.owner_seat
        ) {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'lane.review_sent_back',
            target: lane.id,
            result: 'allow',
            detail: { lane: lane.id, reviewer: member.name, owner: before.owner_seat },
          });
        }
        // A resolve/abandon is a board-shape change — worth a team-visible note, same as an open.
        if (LANE_TERMINAL_STATES.has(lane.state) && !LANE_TERMINAL_STATES.has(before.state)) {
          const verb = lane.state === 'abandoned' ? 'abandoned' : 'resolved';
          deliverLaneTeamAct(ctx, team, member, `[lane] ${verb} "${lane.title}"`, {
            lane_resolve: { lane: lane.id, title: lane.title, state: lane.state },
          });
          // The close's whole audit — verified-ness, reason, the ADR 172/173 abstentions, the ADR
          // 188 grade, and the ADR 109 merge join — lives in `recordLaneClose` because an acceptor's
          // `accept` act closes lanes too (ADR 202) and the two paths must derive it identically.
          recordLaneClose(ctx.db, team.id, member, before, lane, body.merged);
        }
        return sendJson(res, 200, { lane, warnings, ...(review ? { review } : {}) });
      }

      // The mid-loop interrupt line (ADR 088): a silent-or-one-line probe a PostToolUse hook runs at
      // every tool boundary. Sub-50ms and side-effect-light — one unread-inbox read, the interrupt
      // predicate, and (only when raised) a deduped audit row. Never advances the read cursor: reading
      // is the agent's explicit follow-up (`musterd inbox`). The line is **daemon-composed** from the
      // envelope's structured fields (sender, act, count) — never `env.body` (§4 injection surface).
      if (method === 'GET' && rest === '/inbox/interrupt-check') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const cursor = getCursor(ctx.db, member.id);
        const rows = listInbox(ctx.db, member, { unreadOnly: true, cursorTs: cursor.last_read_ts });
        const messages = rows.map((r) => {
          const from = getMemberById(ctx.db, r.from_member);
          const to = r.to_member ? getMemberById(ctx.db, r.to_member) : null;
          return rowToEnvelope(r, team.slug, from?.name ?? '?', to?.name ?? null);
        });
        const pending = pendingInterrupts(messages, member.name);
        recordInterruptCheck(pending.length > 0 ? 'raised' : 'silent');
        if (pending.length === 0) return sendJson(res, 200, { raised: false });
        const latest = pending[0]!;
        // Audit the delivery once per (recipient, act) — who grabbed the mic, when, at whom (§Obs).
        if (!hasInterruptRaised(ctx.db, team.id, member.name, latest.id)) {
          appendAudit(ctx.db, team.id, {
            actor: latest.from,
            action: 'interrupt.raised',
            target: member.name,
            result: 'allow',
            detail: {
              act: latest.id,
              act_kind: latest.act,
              tier: raiseClass(latest),
              count: pending.length,
            },
          });
        }
        return sendJson(res, 200, {
          raised: true,
          line: composeInterruptLine(latest, pending.length),
          count: pending.length,
          act: { id: latest.id, from: latest.from, act: latest.act },
        });
      }

      if (method === 'GET' && rest === '/inbox') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const unread = url.searchParams.get('unread') === '1';
        const since = url.searchParams.get('since');
        const limitRaw = Number(url.searchParams.get('limit') ?? '');
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
        const cursor = getCursor(ctx.db, member.id);
        const rows = listInbox(ctx.db, member, {
          unreadOnly: unread,
          cursorTs: cursor.last_read_ts,
          ...(since ? { since: Number(since) } : {}),
          ...(limit ? { limit } : {}),
        });
        const toEnvelope = (r: (typeof rows)[number]) => {
          const from = getMemberById(ctx.db, r.from_member);
          const to = r.to_member ? getMemberById(ctx.db, r.to_member) : null;
          return rowToEnvelope(r, team.slug, from?.name ?? '?', to?.name ?? null);
        };
        const messages = rows.map(toEnvelope);

        // ADR 211 §3: pendingness is unread-by-cursor OR deferred-and-raised. The cursor is a single
        // monotonic ts and is NOT touched here — a raised act is re-included after the query, so an
        // act the cursor already sailed past still comes back. That is the whole primitive.
        //
        // The fold reads the PARTY-SCOPED TEAM TIMELINE, not the inbox: `listInbox` excludes the
        // member's own sends (`from_member != me`), and a deferring `wait` is the member's own send,
        // so folding over the inbox would find no deferrals at all. The scan is bounded — a deferral
        // older than this many messages stops being tracked, which degrades to today's behaviour
        // (the act is simply unread) rather than to a wrong answer.
        const scan = listTeamMessages(ctx.db, team.id, {
          forMemberId: member.id,
          limit: DEFERRAL_SCAN_LIMIT,
        }).map(toEnvelope);
        const held = deferrals(scan, member.name);
        const raised = raisedDeferrals(scan, member.name);
        if (raised.size > 0) {
          const shown = new Set(messages.map((m) => m.id));
          for (const r of listInbox(ctx.db, member, {})) {
            if (raised.has(r.id) && !shown.has(r.id)) messages.push(toEnvelope(r));
          }
          messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
        }
        const deferred = [...held.values()].map((d) => ({
          target: d.target,
          until: d.until,
          raised: raised.has(d.target),
        }));

        // `total` is the full inbox size (visibility-scoped) so a bounded client can show "N of total".
        return sendJson(res, 200, {
          messages,
          cursor,
          total: countInbox(ctx.db, member),
          deferred,
        });
      }

      // The team timeline for the firehose's history backfill (ADR 061), then live-tailed via
      // `subscribe team-all`. Recipient-scoped (need-to-know): a caller sees only envelopes it is a
      // party to (sender/recipient/team/broadcast) unless it has full visibility — an admin, or a
      // **full-grade** observer, i.e. the trusted local dashboard (ADR 128 + ADR 136).
      //
      // A **public-grade** observer (a shared watch-link) is scoped like anyone else, and that alone
      // yields exactly the public timeline: it can never be a sender (observers are read-only), and
      // team/broadcast fanout excludes it, so the party predicate collapses to
      // `to_kind IN ('team','broadcast')` — plus anything explicitly addressed to it, which is
      // legitimately its own mail. No separate "public" query: not exempting it *is* the scoping.
      if (method === 'GET' && rest === '/messages') {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const since = url.searchParams.get('since');
        const limit = url.searchParams.get('limit');
        const scoped = !hasFullMessageVisibility(member);
        const rows = listTeamMessages(ctx.db, team.id, {
          ...(since ? { since: Number(since) } : {}),
          ...(limit ? { limit: Math.min(Math.max(Number(limit), 1), 1000) } : {}),
          ...(scoped ? { forMemberId: member.id } : {}),
        });
        const messages = rows.map((r) => {
          const from = getMemberById(ctx.db, r.from_member);
          const to = r.to_member ? getMemberById(ctx.db, r.to_member) : null;
          return rowToEnvelope(r, team.slug, from?.name ?? '?', to?.name ?? null);
        });
        return sendJson(res, 200, { messages });
      }

      if (method === 'POST' && rest === '/inbox/cursor') {
        const { team, member } = authTouch(ctx, slug, req);
        const body = (await readJson(req)) as { last_read_message_id?: string };
        if (!body.last_read_message_id)
          throw new MusterdError('bad_request', 'last_read_message_id required');
        const row = ctx.db
          .prepare<[string], { ts: number }>('SELECT ts FROM messages WHERE id = ?')
          .get(body.last_read_message_id);
        if (!row) throw new MusterdError('not_found', 'unknown message id');
        const prev = getCursor(ctx.db, member.id);
        const cursor = setCursor(ctx.db, member.id, body.last_read_message_id, row.ts);
        // seen_latency (ADR 090): each act this advance crossed was just "seen" — emit the
        // send→seen histogram, the read-side twin of loop_latency. Watermark semantics: every act
        // covered by one advance shares this instant. Scope lives in crossedBySeen (store).
        for (const m of crossedBySeen(ctx.db, team.id, member.id, prev.last_read_ts, row.ts)) {
          recordSeenLatency(
            slug,
            member.name,
            m.act,
            m.urgent,
            Math.max(0, cursor.updated_at - m.ts),
          );
        }
        return sendJson(res, 200, { cursor });
      }

      // The per-act delivery ledger (ADR 090): where in logged→seen→answered each recipient sits,
      // derived from the log + cursors + the interrupt audit — never stored.
      if (method === 'GET' && rest.startsWith('/messages/') && rest.endsWith('/delivery')) {
        const { team, member } = authTouch(ctx, slug, req);
        assertSeatCanRead(member);
        const id = rest.slice('/messages/'.length, -'/delivery'.length);
        const ledger = actDelivery(ctx.db, team.id, id);
        if (!ledger) throw new MusterdError('not_found', 'unknown message id');
        return sendJson(res, 200, ledger);
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

      // Seat memory (ADR 093): a seat's private continuity blob. All three are seat-authenticated and
      // operate on the caller's OWN seat only — the URL carries no member name, and there is no
      // cross-seat read path (team admins included, ADR 093 §4). `authMember` resolves the seat from
      // the presented token; a mismatched/absent token is its own 401/403.
      if (method === 'PUT' && rest === '/memory') {
        const { team, member } = authMember(ctx.db, slug, bearer(req), actingSeat(req));
        assertSeatCanRead(member); // inert seats (disabled/banned/archived) can't touch memory either
        const parsed = parseOrBadRequest(MemorySaveBody, await readJson(req));
        const input = { headline: parsed.headline, body: parsed.body ?? '' };
        saveMemory(ctx.db, member.id, input); // enforces the caps, throws bad_request with the limit named
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'memory.save',
          target: member.name,
          result: 'allow',
          // Sizes only, never the content (hard rule 5): the audit log is not a copy of the note.
          detail: {
            size_bytes: Buffer.byteLength(input.body, 'utf8'),
            headline_len: input.headline.length,
          },
        });
        return sendNoContent(res);
      }

      // `?envelope=1` returns the headline-only envelope (headline + age + size, never the body) —
      // the ADR 093 §3 delivery shape for surfaces that render the one-line pointer without occupying
      // (`musterd status`). The bare GET stays the explicit full-body read.
      if (method === 'GET' && rest === '/memory') {
        const { member } = authMember(ctx.db, slug, bearer(req), actingSeat(req));
        assertSeatCanRead(member);
        if (url.searchParams.get('envelope') === '1') {
          const env = memoryEnvelope(ctx.db, member.id);
          if (!env) throw new MusterdError('not_found', 'no memory saved for this seat');
          return sendJson(res, 200, env);
        }
        const mem = getMemory(ctx.db, member.id);
        if (!mem) throw new MusterdError('not_found', 'no memory saved for this seat');
        return sendJson(res, 200, mem);
      }

      if (method === 'DELETE' && rest === '/memory') {
        const { team, member } = authMember(ctx.db, slug, bearer(req), actingSeat(req));
        assertSeatCanRead(member);
        const existed = clearMemory(ctx.db, member.id);
        // Idempotent: DELETE always 204s. Only audit an actual clear (nothing happened otherwise).
        if (existed) {
          appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'memory.clear',
            target: member.name,
            result: 'allow',
          });
        }
        return sendNoContent(res);
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
        markSignedOff(ctx.db, member.id);
        clearBound(ctx.db, member.id);
        ctx.hub.broadcastTeam(team.id, {
          type: 'presence',
          member: member.name,
          status: 'offline',
        });
        return sendJson(res, 200, { ok: true, member: member.name });
      }

      /* ─── human credential rotate-in-place ─────────────────────────────────────────────────────
       * `credential_hash` is one column and `mintCredential` overwrites it, so before this route a
       * human who lost their `mscr_` was unrecoverable short of DB surgery — the state the founder's
       * own dogfood team was in, which made ADR 170's premise ("the CLI already holds your
       * credential") false on the very machine it shipped from.
       *
       * Rotate-in-place, mirroring the agent-key rotate: mint, audit, shown once, the old secret dead
       * at the next claim (live sessions ride out — same as `key.rotate`). The two-credential schema
       * ADR 170 deferred stays deferred; "I lost it" is exactly what rotation serves.
       *
       * The bar is `authProvision` (localhost unauthenticated, admin credential off-host — ADR 134),
       * NOT admin-only, and that is the load-bearing call rather than a shortcut: the primary caller
       * has lost the very credential admin auth would demand, so admin-only is circular precisely
       * when the admin is the one locked out. Re-minting for an existing human is not a more powerful
       * act than minting for a new one, which already sits at this bar. The residual risk — any local
       * process can rotate any human's credential — is ADR 134's accepted boundary, and rotation is
       * self-announcing: an audit row lands and the old secret stops working.
       *
       * Humans only. An agent seat authenticates with the team agent key (ADR 069/075) and has no
       * credential to lose; minting one for it would manufacture exactly the human-seat authority the
       * claim-kind guard refuses.
       */
      const credentialRotateMatch = rest.match(/^\/members\/([^/]+)\/credential\/rotate$/);
      if (method === 'POST' && credentialRotateMatch) {
        const team = requireTeam(ctx.db, slug);
        authProvision(ctx, slug, req);
        const targetName = decodeURIComponent(credentialRotateMatch[1]!);
        const target = getMemberByName(ctx.db, team.id, targetName);
        if (!target || target.left_at !== null) {
          throw new MusterdError('not_found', `no member "${targetName}" in ${slug}`);
        }
        if (target.kind !== 'human') {
          throw new MusterdError(
            'bad_request',
            `"${target.name}" is an agent seat — agents authenticate with the team agent key, not a ` +
              `per-seat credential, so there is nothing here to rotate (POST /teams/${slug}/agent-key/rotate rotates the key).`,
          );
        }
        const { credential } = mintCredential(ctx.db, target.id);
        // Attribute honestly: an off-host caller is an authenticated admin (authProvision just proved
        // it); a loopback caller is anonymous by design, so the actor is null and `via` says where the
        // authority came from. `detail` never carries the secret or its hash.
        appendAudit(ctx.db, team.id, {
          actor: tryAuth(ctx, slug, req)?.name ?? null,
          action: 'credential.rotate',
          target: target.name,
          result: 'allow',
          detail: {
            via: isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy) ? 'local' : 'admin',
          },
        });
        return sendJson(res, 200, { member: target.name, credential });
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
      return serveStatic(req, ctx.config.webRoot, path, res);
    }

    throw new MusterdError('not_found', `no route for ${method} ${path}`);
  } catch (err) {
    sendError(res, err);
  }
}
