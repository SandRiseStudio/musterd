// Browser live client for the musterd team firehose (ADR 061).
//
// A port of the CLI's `watch()` (packages/cli/src/client.ts) to the browser `WebSocket`, with two
// differences that make it a *dashboard* client rather than an inbox watcher:
//   1. it subscribes with scope `team-all` (the firehose) so it receives EVERY envelope on the team,
//      not just messages addressed to this seat;
//   2. it backfills history over HTTP first (`GET /teams/:slug/messages`) so the view isn't empty,
//      then live-tails — the canonical "GET history, then subscribe, dedupe by id" pattern.
import {
  AuditResponseSchema,
  PROTOCOL_VERSION,
  type AuditEntry,
  type Envelope,
  type MemberSummary,
} from '@musterd/protocol';

// Re-export so the audit view + route keep importing the entry type from this client module.
export type { AuditEntry };

export interface LiveConfig {
  team: string;
  /** The seat we authenticate as (an observer seat). */
  as: string;
  token: string;
}

export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

/** Terminal auth failures — don't reconnect into them (a `superseded` reconnect war is the worst case). */
const TERMINAL_CODES = new Set(['unauthorized', 'forbidden', 'superseded', 'version_mismatch']);

/**
 * The dashboard talks to the daemon **same-origin** — no `server` URL. In dev a Vite proxy forwards
 * `/teams` + `/ws` to the daemon (and strips the browser Origin so the ADR 040 gate sees a clean
 * loopback client); in prod the daemon serves the web and these paths from one origin. This sidesteps
 * CORS and the WS Origin gate entirely.
 */
export function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

async function apiGet<T>(cfg: LiveConfig, path: string): Promise<T> {
  const res = await fetch(path, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      // Label our ambient presence as the web surface (ADR 057); never touch-suppress — we want the
      // dashboard to read present.
      'x-musterd-surface': 'web',
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

/** Full team roster with presence/activity (`GET /teams/:slug`). */
export async function fetchRoster(cfg: LiveConfig): Promise<MemberSummary[]> {
  const r = await apiGet<{ members: MemberSummary[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}`,
  );
  return r.members;
}

/** Whole-team history for backfill (`GET /teams/:slug/messages`, the firehose's history side). */
export async function fetchHistory(
  cfg: LiveConfig,
  opts: { since?: number; limit?: number } = {},
): Promise<Envelope[]> {
  const q = new URLSearchParams();
  if (opts.since != null) q.set('since', String(opts.since));
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString();
  const r = await apiGet<{ messages: Envelope[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/messages${qs ? `?${qs}` : ''}`,
  );
  return r.messages;
}

/** A fetch error that carries the daemon's error code so the view can tailor copy (401 vs 403). */
export class AuditFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuditFetchError';
  }
}

/**
 * The **admin-only** governance audit log (`GET /teams/:slug/audit`, ADR 071). Newest-first; pages
 * older via `before` (ms-epoch). Requires a seat with `is_admin`/`visibility_level: admin` — a 401
 * (no token) or 403 (non-admin) surfaces as an {@link AuditFetchError} so the route can explain it.
 */
export async function fetchAudit(
  cfg: LiveConfig,
  opts: { limit?: number; before?: number } = {},
): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.before != null) q.set('before', String(opts.before));
  const qs = q.toString();
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/audit${qs ? `?${qs}` : ''}`,
    { headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' } },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  // Validate the wire against the shared schema at the boundary (same contract the CLI parses, ADR 074).
  return AuditResponseSchema.parse(json).audit;
}

/** A single pending/settled claim request as returned by GET /requests. */
export interface ClaimRequest {
  id: string;
  team_id: string;
  kind: string;
  from_conn_id: string;
  target_seat: string | null;
  target_role: string | null;
  surface: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decided_by: string | null;
  ts: number;
  expires_at: number;
}

/**
 * P3.2 (ADR 077): fetch claim requests for a team. Admin-only (403 if the caller lacks is_admin).
 * Optionally filter by `status` (pending|approved|denied|expired).
 */
export async function fetchRequests(
  cfg: LiveConfig,
  opts: { status?: string; limit?: number; before?: number } = {},
): Promise<ClaimRequest[]> {
  const q = new URLSearchParams();
  if (opts.status) q.set('status', opts.status);
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.before != null) q.set('before', String(opts.before));
  const qs = q.toString();
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/requests${qs ? `?${qs}` : ''}`,
    { headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' } },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return (json as { requests: ClaimRequest[] }).requests;
}

/**
 * P3.2 (ADR 077): approve or deny a pending claim request. Admin-only.
 * On approve, `lifetime` controls how long the issued grant is valid.
 */
export async function decideRequest(
  cfg: LiveConfig,
  requestId: string,
  decision: { approve: boolean; lifetime?: 'once' | 'ttl' | 'standing'; ttl_hours?: number },
): Promise<{ request_id: string; approve: boolean; delivered: boolean }> {
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/requests/${encodeURIComponent(requestId)}/decide`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
        'x-musterd-surface': 'web',
      },
      body: JSON.stringify(decision),
    },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as { request_id: string; approve: boolean; delivered: boolean };
}

/**
 * Provision a hidden read-only observer seat (ADR 063) and return its token. Lets the dashboard be
 * "enter a team and watch" — no pre-made seat. The endpoint is unauthenticated (localhost-trust, like
 * team creation); the seat is hidden from the roster and can't send.
 */
export async function provisionObserver(team: string, name: string): Promise<string> {
  const res = await fetch(`/teams/${encodeURIComponent(team)}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind: 'human', observer: true }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (json as { token: string }).token;
}

export interface LiveHandlers {
  onEnvelope: (env: Envelope) => void;
  onPresence: (member: string, status: string, surface?: string) => void;
  onStatus: (status: ConnStatus) => void;
  onError?: (message: string) => void;
}

/**
 * A self-healing live socket: hello → subscribe `team-all` → stream `deliver`/`presence`, with a
 * 15s heartbeat and capped exponential-backoff reconnect. `close()` stops reconnecting.
 */
export class LiveClient {
  private ws: WebSocket | undefined;
  private hb: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private backoff = 1000;

  constructor(
    private cfg: LiveConfig,
    private h: LiveHandlers,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private open(): void {
    this.h.onStatus('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: PROTOCOL_VERSION,
          team: this.cfg.team,
          as: this.cfg.as,
          token: this.cfg.token,
          surface: 'web',
          provenance: 'session',
        }),
      );
    };

    ws.onmessage = (ev: MessageEvent) => {
      let frame: { type: string; [k: string]: unknown };
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case 'welcome':
          ws.send(JSON.stringify({ type: 'subscribe', scope: 'team-all' }));
          this.hb = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
          }, 15_000);
          break;
        case 'subscribed':
          this.backoff = 1000; // a clean handshake resets backoff
          this.h.onStatus('live');
          break;
        case 'deliver':
          this.h.onEnvelope(frame.envelope as Envelope);
          break;
        case 'presence':
          this.h.onPresence(
            frame.member as string,
            frame.status as string,
            frame.surface as string | undefined,
          );
          break;
        case 'error': {
          const code = frame.code as string;
          this.h.onError?.(frame.message as string);
          if (TERMINAL_CODES.has(code)) {
            this.stopped = true; // don't reconnect into an auth failure
            this.h.onStatus('error');
            ws.close();
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      this.clearHeartbeat();
      if (this.stopped) {
        this.h.onStatus('closed');
        return;
      }
      this.h.onStatus('reconnecting');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires next and owns reconnect; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.backoff, 15_000);
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = undefined;
    }
  }
}
