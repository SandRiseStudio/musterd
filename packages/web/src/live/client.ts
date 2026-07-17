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
  LaneBoardSchema,
  makeEnvelope,
  PROTOCOL_VERSION,
  type AuditEntry,
  type Envelope,
  type LaneBoard,
  type MemberSummary,
  type Request,
} from '@musterd/protocol';

// Re-export so the audit view + route keep importing the entry type from this client module.
export type { AuditEntry };

export interface LiveConfig {
  team: string;
  /** The seat we authenticate as (an observer seat). */
  as: string;
  /**
   * The credential (mscr_) — the single v0.3 auth secret. It's the HTTP Bearer for the roster/history/
   * audit reads AND the `key` the WS `claim` handshake authenticates with (ADR 077). The legacy per-seat
   * token is no longer accepted by the daemon.
   */
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
    // Carry the daemon's status + code so callers can distinguish a stale-observer 401 (self-heal) from
    // a real failure — a plain Error would erase the signal the route needs to auto-reprovision.
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
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

/** A fetch error that carries the daemon's HTTP status + error code, so a caller can tell a stale-observer
 * 401 from a real failure (and self-heal) and the view can tailor copy (401 vs 403). */
export class LiveFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LiveFetchError';
  }
}

/** The admin audit/requests reads throw this subclass so their `instanceof AuditFetchError` checks keep
 * working; it IS a {@link LiveFetchError} (carries `code` + `status`). */
export class AuditFetchError extends LiveFetchError {
  constructor(message: string, code: string, status: number) {
    super(message, code, status);
    this.name = 'AuditFetchError';
  }
}

/** True for the 401 the daemon returns when an observer credential is stale/invalid — a wiped DB or an
 * expired 24h observer TTL (ADR 064) leaves the cached `mscr_` unrecognised (`unauthorized`). Recoverable
 * by dropping it and provisioning a fresh observer, so `/live` self-heals instead of dead-ending. */
export function isStaleCredential(e: unknown): boolean {
  return e instanceof LiveFetchError && e.status === 401;
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

/** Re-export for routes that import the Request type from this client module. */
export type { Request };

/**
 * The lane board (`GET /teams/:slug/lanes`, ADR 083) — the full set of lanes with live warnings
 * (ADR 084). Member-authed (any seat, not admin), so the read-only observer credential the dashboard
 * already holds is sufficient. Validates the wire against the shared schema at the boundary, and throws
 * a {@link LiveFetchError} on failure so a stale-observer 401 can self-heal (`isStaleCredential`).
 */
export async function fetchLaneBoard(
  cfg: LiveConfig,
  opts: { project?: string; open?: boolean; goal?: string } = {},
): Promise<LaneBoard> {
  const q = new URLSearchParams();
  if (opts.project) q.set('project', opts.project);
  if (opts.open) q.set('open', '1');
  if (opts.goal) q.set('goal', opts.goal);
  const qs = q.toString();
  const json = await apiGet<unknown>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/lanes${qs ? `?${qs}` : ''}`,
  );
  return LaneBoardSchema.parse(json);
}

/**
 * Send an act from the browser as the connected seat (ADR 149 — the /live asks strip's answer path).
 * An ordinary envelope through the member-authed `POST /messages`, so a browser answer is
 * indistinguishable from a CLI one to the daemon (same validation, same ask lifecycle audit). Only
 * meaningful for a **real** seat (the auto-provisioned observer is read-only by construction, ADR 063
 * — the daemon rejects its sends); callers gate the affordance on roster membership. Returns the
 * daemon's ack envelope so the view can fold the answer into its local timeline immediately (the
 * firehose deliberately skips the sender, so the ack is the only copy this client will see).
 */
export async function sendAct(
  cfg: LiveConfig,
  input: {
    act: Envelope['act'];
    to: Envelope['to'];
    body?: string;
    thread?: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<Envelope> {
  const envelope = makeEnvelope({
    id: crypto.randomUUID(),
    team: cfg.team,
    from: cfg.as,
    to: input.to,
    body: input.body ?? '',
    act: input.act,
    thread: input.thread ?? null,
    meta: input.meta ?? null,
  });
  const res = await fetch(`/teams/${encodeURIComponent(cfg.team)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      'x-musterd-surface': 'web',
    },
    body: JSON.stringify({ envelope }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return (json as { ack: Envelope }).ack;
}

/* ─── shared read-only observer seat ──────────────────────────────────────────────────────────────
 * A hidden, self-authorizing read-only seat (ADR 063/077) the browser caches per team, so any read-only
 * surface — /live, /board — is "enter a team and watch" with no pre-made seat. Keyed the same across
 * surfaces so they reuse ONE observer per team rather than minting a seat each. `.v2` = credential-based
 * (ADR 077 claim handshake); bumping it drops legacy token creds. */
export interface ObserverCreds {
  name: string;
  /** The observer seat's credential (mscr_) — the single v0.3 auth secret (HTTP + WS claim). */
  token: string;
}
const observerKey = (team: string) => `musterd.live.observer.v2.${team}`;

export function loadObserver(team: string): ObserverCreds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(observerKey(team));
    if (!raw) return null;
    const creds = JSON.parse(raw) as ObserverCreds;
    return creds && creds.token ? creds : null;
  } catch {
    return null;
  }
}
export function saveObserver(team: string, creds: ObserverCreds) {
  window.localStorage.setItem(observerKey(team), JSON.stringify(creds));
}
export function forgetObserver(team: string) {
  window.localStorage.removeItem(observerKey(team));
}
export function genObserverName(): string {
  return 'web-' + Math.random().toString(36).slice(2, 8);
}

/** Load this browser's cached observer for the team, or provision a fresh one and cache it. Returns the
 * {@link LiveConfig} a read-only surface connects with. This is the operator's OWN dashboard seat, on
 * their own machine — full-grade, so the office/stream still show the directed coordination that is
 * most of what there is to watch (ADR 136). */
export async function acquireObserver(team: string): Promise<LiveConfig> {
  let creds = loadObserver(team);
  if (!creds) {
    const name = genObserverName();
    const token = await provisionObserver(team, name);
    creds = { name, token };
    saveObserver(team, creds);
  }
  return { team, as: creds.name, token: creds.token };
}

/* ─── the shared watch-link seat (ADR 136) ────────────────────────────────────────────────────────
 * A watch link used to carry `acquireObserver`'s credential — the operator's own **full-grade** seat —
 * so handing someone a link handed them every DM on the team. A link now gets its own **public-grade**
 * observer: a distinct seat that sees team/broadcast traffic only. Cached per team so the link is
 * stable (repeated copies hand out the same URL rather than littering seats; idle ones are reaped at
 * the 24h observer TTL, ADR 064). */
const watchLinkKey = (team: string) => `musterd.live.watchlink.v1.${team}`;

/** The team's shared public-grade watch-link seat — cached, or minted on first share.
 *
 * Minting requires a local peer or an admin (ADR 134). The operator clicking "copy watch link" in the
 * daemon-served dashboard is local by construction, so this succeeds exactly where it should. */
export async function acquireWatchLinkObserver(team: string): Promise<ObserverCreds> {
  try {
    const raw = window.localStorage.getItem(watchLinkKey(team));
    if (raw) {
      const creds = JSON.parse(raw) as ObserverCreds;
      if (creds && creds.token) return creds;
    }
  } catch {
    // fall through and mint
  }
  const name = 'watch-' + Math.random().toString(36).slice(2, 8);
  const token = await provisionObserver(team, name, 'public');
  const creds = { name, token };
  window.localStorage.setItem(watchLinkKey(team), JSON.stringify(creds));
  return creds;
}

/** Drop the cached watch-link seat — the link stops working on the next mint (the old seat lingers
 *  until the observer TTL reaps it). */
export function forgetWatchLinkObserver(team: string) {
  window.localStorage.removeItem(watchLinkKey(team));
}

/**
 * List pending (or all) claim requests for the team — admin-only (ADR 077).
 * Uses AuditFetchError so the route can tailor 401/403 copy.
 */
export async function fetchRequests(
  cfg: LiveConfig,
  opts: { pendingOnly?: boolean } = {},
): Promise<Request[]> {
  const q = new URLSearchParams();
  if (opts.pendingOnly) q.set('status', 'pending');
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
  return (json as { requests: Request[] }).requests;
}

/**
 * Admin approve or deny a claim request (ADR 077).
 * Returns { request_id, decision, delivered }.
 */
export async function decideRequest(
  cfg: LiveConfig,
  requestId: string,
  decision:
    | { decision: 'approve'; lifetime: 'once' | 'ttl' | 'standing'; ttl_hours?: number }
    | { decision: 'deny' },
): Promise<{ request_id: string; decision: string; delivered: boolean }> {
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/requests/${encodeURIComponent(requestId)}/decide`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
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
  return json as { request_id: string; decision: string; delivered: boolean };
}

/**
 * Provision a hidden read-only observer seat (ADR 063). Lets the dashboard be "enter a team and watch"
 * — no pre-made seat. The seat is hidden from the roster and can't send. Returns the human credential
 * (mscr_) the v0.3 WS `claim` handshake authenticates with (ADR 077); the observer claims its **own**
 * seat, which is self-authorizing (no grant/approval).
 *
 * Unauthenticated **from a local peer only** — the daemon now enforces the localhost-trust this route
 * always claimed (ADR 134); off-machine callers need an admin credential.
 *
 * `scope` is the observer's grade (ADR 136): `'full'` (default) is the operator's own dashboard on
 * their own machine and sees the whole timeline; `'public'` sees team/broadcast traffic only and is
 * what a **shared watch-link** gets — see {@link acquireWatchLinkObserver}.
 */
export async function provisionObserver(
  team: string,
  name: string,
  scope: 'full' | 'public' = 'full',
): Promise<string> {
  const res = await fetch(`/teams/${encodeURIComponent(team)}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind: 'human', observer: true, observer_scope: scope }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const cred = (json as { human_credential?: string }).human_credential;
  if (!cred) throw new Error('observer provisioning did not return a credential (daemon too old?)');
  return cred;
}

export interface LiveHandlers {
  onEnvelope: (env: Envelope) => void;
  onPresence: (member: string, status: string, surface?: string) => void;
  onStatus: (status: ConnStatus) => void;
  onError?: (message: string) => void;
  /** The WS `claim` was refused for a stale/invalid credential — recoverable by re-provisioning a fresh
   * observer (the route drops the cached credential and reconnects). When set, it's called *instead* of
   * `onError` for that case, so the view auto-heals rather than showing a dead-end. */
  onCredentialInvalid?: () => void;
}

/**
 * A self-healing live socket: `claim` (own observer seat, self-authorizing — ADR 077) → subscribe
 * `team-all` → stream `deliver`/`presence`, with a 15s heartbeat and capped exponential-backoff
 * reconnect. `close()` stops reconnecting. A `refused` (bad/stale credential) is terminal.
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
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: this.cfg.team,
          key: this.cfg.token,
          target: { seat: this.cfg.as },
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
        case 'occupied':
          // The claim succeeded (own observer seat) — subscribe to the firehose + start heartbeating.
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
        case 'refused': {
          // A bad/stale credential (e.g. a wiped DB, an expired observer TTL, or the seat reclaimed).
          // Terminal for this socket — stop, then let the route re-provision a fresh observer and
          // reconnect (onCredentialInvalid) instead of dead-ending on the daemon's hint.
          this.stopped = true;
          this.h.onStatus('error');
          ws.close();
          if (this.h.onCredentialInvalid) {
            this.h.onCredentialInvalid();
          } else {
            const hint = typeof frame.hint === 'string' && frame.hint ? ` — ${frame.hint}` : '';
            this.h.onError?.(`${frame.message as string}${hint}`);
          }
          break;
        }
        case 'pending':
          // No grant → an admin must approve. Never happens for a self-claimed observer seat, but if it
          // does, keep the socket open (the server pushes occupied/refused on decision) and say so.
          this.h.onError?.(String(frame.message ?? 'claim pending — waiting for admin approval'));
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
