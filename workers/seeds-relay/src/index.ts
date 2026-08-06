/**
 * musterd seeds relay (ADR 248) — an always-on Cloudflare Worker that captures raw ideas
 * ("seeds") from two channels and buffers them, untouched, for the daemon to pull.
 *
 * The relay's one job is capture. It verifies the sender, stores the RAW seed
 * `{ body, ts, source }`, and acknowledges. It never interprets, enriches, tags, or
 * deduplicates — the buffer is the source of record and must stay verbatim, because it is
 * what lets an idea survive a shut laptop (the lane the daemon later opens is the working
 * artifact; neither is ever written back to the other).
 *
 * Channels:
 *  - `POST /ingest/twilio` — inbound SMS. Twilio HMAC-SHA1 signature verification; reply is
 *    an EMPTY TwiML ack (no outbound SMS, by design — confirmations differ by channel).
 *  - `POST /ingest/slack` — Slack Events API for the dedicated seeds channel. v0 signing
 *    verification + 5-minute staleness window; handles the `url_verification` handshake;
 *    ignores bot/edited/threaded events so the webhook confirmation cannot loop. Confirms
 *    with "🌱 saved" via the incoming webhook (same webhook the ADR 149 ask stream uses).
 *
 * Pull (the daemon's side of the one-way flow):
 *  - `GET /seeds?after=<id>` — bearer-token (PULL_TOKEN) list of buffered seeds with id
 *    strictly greater than `after`, oldest first. Nothing is deleted or marked on pull; the
 *    daemon keeps its own cursor, and the buffer keeps everything.
 *
 * Cloned from sandrise workers/exploring-ingest (signature verification, responders, route
 * guard); all podcast enrichment dropped.
 */

export interface Env {
  SEEDS_KV: KVNamespace;
  /** Secrets (wrangler secret put): */
  TWILIO_AUTH_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
  PULL_TOKEN?: string;
  /** Vars: */
  ENABLE_TWILIO?: string;
  ENABLE_SLACK?: string;
  /** Restrict Slack capture to one channel id; unset = accept any channel the app is in. */
  SLACK_SEEDS_CHANNEL?: string;
}

type SeedSource = 'sms' | 'slack';

/** The raw seed, exactly as buffered. `meta` is channel addressing, never content. */
export interface Seed {
  id: string;
  body: string;
  ts: number;
  source: SeedSource;
  meta: Record<string, string>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SEED_PREFIX = 'seed:';

/** Sortable id: ms timestamp (fixed width, so lexicographic = chronological) + random tail. */
function seedId(now: number): string {
  return `${now.toString().padStart(14, '0')}-${crypto.randomUUID()}`;
}

async function bufferSeed(env: Env, seed: Omit<Seed, 'id'>): Promise<Seed> {
  const full: Seed = { id: seedId(seed.ts), ...seed };
  await env.SEEDS_KV.put(SEED_PREFIX + full.id, JSON.stringify(full));
  return full;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/ingest/twilio') {
        if (env.ENABLE_TWILIO !== 'true') return new Response('Twilio channel disabled', { status: 403 });
        return await handleTwilio(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/ingest/slack') {
        if (env.ENABLE_SLACK !== 'true') return new Response('Slack channel disabled', { status: 403 });
        return await handleSlack(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/seeds') {
        return await handlePull(request, env, url);
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) return new Response(error.message, { status: error.status });
      console.error('[SeedsRelay] unexpected', error);
      // Twilio retries on 5xx; a transient failure should be retried, not dropped.
      return new Response('Internal error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Twilio (SMS)

async function handleTwilio(request: Request, env: Env): Promise<Response> {
  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) throw new HttpError('Twilio auth token missing', 500);

  const rawBody = await request.text();
  await verifyTwilioSignature(request, rawBody, token);

  const params = new URLSearchParams(rawBody);
  const body = params.get('Body')?.trim();
  if (body) {
    await bufferSeed(env, {
      body,
      ts: Date.now(),
      source: 'sms',
      meta: compact({ from: params.get('From'), to: params.get('To') }),
    });
  }
  // Empty TwiML ack: received, no outbound SMS (SMS gets no confirmation, by design).
  return new Response('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'application/xml' },
  });
}

async function verifyTwilioSignature(request: Request, rawBody: string, token: string): Promise<void> {
  const signature = request.headers.get('x-twilio-signature');
  if (!signature) throw new HttpError('Missing Twilio signature.', 401);

  // Twilio signs: full URL + form params sorted by key, concatenated key+value.
  const url = new URL(request.url);
  const params = new URLSearchParams(rawBody);
  const entries: [string, string][] = [];
  params.forEach((value, key) => entries.push([key, value]));
  const paramsString = entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}${value}`)
    .join('');
  const data = `${url.origin}${url.pathname}${paramsString}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  if (!timingSafeEqual(arrayBufferToBase64(digest), signature)) {
    throw new HttpError('Invalid Twilio signature.', 401);
  }
}

// ---------------------------------------------------------------------------
// Slack (Events API on the dedicated seeds channel)

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    thread_ts?: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
  };
}

async function handleSlack(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) throw new HttpError('Slack signing secret missing', 500);

  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) throw new HttpError('Missing Slack headers', 401);
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60 * 5) {
    throw new HttpError('Stale Slack request', 401);
  }

  const rawBody = await request.text();
  await verifySlackSignature(rawBody, timestamp, signature, signingSecret);

  const envelope = JSON.parse(rawBody) as SlackEventEnvelope;

  // Events API subscription handshake.
  if (envelope.type === 'url_verification' && envelope.challenge) {
    return new Response(JSON.stringify({ challenge: envelope.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const event = envelope.event;
  // Only fresh, human, top-level channel messages are seeds. Skipping bot messages is what
  // prevents the "🌱 saved" webhook confirmation from re-entering as a new event; skipping
  // subtypes drops edits/deletes/joins.
  const isSeedMessage =
    envelope.type === 'event_callback' &&
    event?.type === 'message' &&
    !event.subtype &&
    !event.bot_id &&
    !event.thread_ts &&
    typeof event.text === 'string' &&
    event.text.trim().length > 0 &&
    (!env.SLACK_SEEDS_CHANNEL || event.channel === env.SLACK_SEEDS_CHANNEL);

  if (isSeedMessage) {
    await bufferSeed(env, {
      body: event.text!.trim(),
      ts: Date.now(),
      source: 'slack',
      meta: compact({ user: event.user ?? null, channel: event.channel ?? null, event_ts: event.ts ?? null }),
    });
    // Confirm in-channel, detached: a slow/dead webhook must not fail (or slow) the capture.
    if (env.SLACK_WEBHOOK_URL) {
      ctx.waitUntil(
        fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '🌱 saved' }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined),
      );
    }
  }

  // Slack wants a fast 200 for every delivery, seed or not, or it retries.
  return new Response('ok', { status: 200 });
}

async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<void> {
  const base = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(base));
  if (!timingSafeEqual(`v0=${bufferToHex(digest)}`, signature)) {
    throw new HttpError('Invalid Slack signature.', 401);
  }
}

// ---------------------------------------------------------------------------
// Pull (daemon side)

const PULL_PAGE_LIMIT = 100;

async function handlePull(request: Request, env: Env, url: URL): Promise<Response> {
  const token = env.PULL_TOKEN;
  if (!token) throw new HttpError('Pull token missing', 500);
  const auth = request.headers.get('authorization') ?? '';
  if (!timingSafeEqual(auth, `Bearer ${token}`)) throw new HttpError('Unauthorized', 401);

  const after = url.searchParams.get('after') ?? '';
  const afterKey = after ? SEED_PREFIX + after : '';

  // KV list is lexicographic and seed ids are timestamp-prefixed, so key order is capture
  // order. Volume is personal-idea scale; if a page of 1000 keys ever becomes the limit,
  // the buffer has outgrown KV and the ADR says to revisit, not to paginate here.
  const seeds: Seed[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SEEDS_KV.list({ prefix: SEED_PREFIX, cursor });
    for (const entry of page.keys) {
      if (afterKey && entry.name <= afterKey) continue;
      if (seeds.length >= PULL_PAGE_LIMIT) break;
      const value = await env.SEEDS_KV.get(entry.name);
      if (value) seeds.push(JSON.parse(value) as Seed);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && seeds.length < PULL_PAGE_LIMIT);

  return new Response(JSON.stringify({ seeds }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Shared helpers

function compact(record: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value) out[key] = value;
  }
  return out;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Constant-time string comparison (both inputs are attacker-influenced strings). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
