import {
  ErrorBodySchema,
  PROTOCOL_VERSION,
  type ClaimTarget,
  type Envelope,
  type Goal,
  type Lane,
  type LaneWarning,
  type MemberSummary,
  type MemoryEnvelope,
  type NextBrief,
  type Report,
  type WSServerFrame,
} from '@musterd/protocol';
import { WebSocket } from 'ws';
import type { McpConfig } from './config.js';

function wsBase(server: string): string {
  return server.replace(/^http/, 'ws');
}

/**
 * HTTP client + background WS that holds presence and buffers inbound deliveries.
 * The buffer is a convenience; the server log + cursor are authoritative, so a
 * dropped socket never loses messages (they resurface via the inbox cursor).
 */
export class MusterdClient {
  private buffer: Envelope[] = [];
  private seen = new Set<string>();
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private closed = false;
  /** True while the member should hold presence — gates reconnect, cleared by leave()/close(). */
  private wantPresence = false;
  private joinedFlag = false;
  /** Resolves/rejects the in-flight join() on the first welcome / error frame. */
  private pendingJoin: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Bounds a parked join() waiting on admin approval (ADR 087) — cleared on any terminal frame. */
  private joinTimer: NodeJS.Timeout | null = null;
  /** True for a blocking join() (team_join): a `pending` frame parks (waits for the pushed decision)
   *  instead of rejecting. False for best-effort autojoin, which stays a pending presence on `pending`. */
  private waitOnPending = false;
  /** The open claim request id while parked on `pending` (surfaced by team_join on a wait timeout). */
  private pendingRequestId: string | null = null;
  /** The seat's memory envelope delivered on the occupied frame (ADR 093) — headline + age + size,
   * never the body. Rendered by team_join as the one-line pointer; null when nothing is saved. */
  private memoryEnvelope: MemoryEnvelope | null = null;
  /** Why the last join attempt failed — surfaced by the dormant tool guards so a silent autojoin
   * failure (e.g. wrong-db token rejection) is visible to the agent, not just "call team_join". */
  private lastJoinErrorMsg: string | null = null;
  /** Invoked when this session is superseded by a successor **in its own workspace** (ADR 092): the
   * adapter has been replaced by a reload and should exit cleanly rather than linger dormant. Wired by
   * the MCP entrypoint to the graceful-shutdown-then-exit path; unset in tests / library use. */
  onReplaced?: () => void;

  constructor(private config: McpConfig) {}

  /** Whether this session currently occupies its member's seat (claimed presence, got welcome). */
  get joined(): boolean {
    return this.joinedFlag;
  }

  /** Whether this session has claimed a seat yet (it has occupied one — the resolved seat is set). */
  get claimed(): boolean {
    return Boolean(this.config.member);
  }

  /** The claimed seat's member name, or undefined while pending (unclaimed). */
  get member(): string | undefined {
    return this.config.member;
  }

  /** This session's pending-presence disambiguation code (ADR 033). */
  get claimCode(): string {
    return this.config.claimCode;
  }

  /** The memory envelope the last occupy delivered (ADR 093), or null when the seat has no note. */
  get memory(): MemoryEnvelope | null {
    return this.memoryEnvelope;
  }

  /**
   * Bind this session to a freshly-claimed seat (claim-on-first-use, ADR 032). After this, `join()`
   * occupies it and the act tools can send as it. Refuses to silently swap a live seat — claim only
   * applies to a pending or already-matching session.
   */
  setIdentity(member: string): void {
    if (this.config.member && this.config.member !== member && this.joinedFlag) {
      throw new Error(`already live as ${this.config.member}; leave before claiming ${member}`);
    }
    this.config.member = member;
  }

  /** Mint (or look up the roster of) seats with no identity — the unauthenticated local floor. */
  async addMember(name: string, role?: string): Promise<{ token: string }> {
    return this.request('POST', `/teams/${this.config.team}/members`, {
      name,
      kind: 'agent',
      ...(role ? { role } : {}),
    });
  }

  /** The most recent join failure message, or null if none / since cleared by a successful join. */
  get lastJoinError(): string | null {
    return this.lastJoinErrorMsg;
  }

  // reason: returns parsed JSON of varying shape; callers narrow at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.config.server + path, {
      method,
      headers: {
        'content-type': 'application/json',
        // v0.3 (ADR 075): authenticate with the team agent key (Bearer); the server dispatches on the
        // prefix → the live-presence occupancy this session holds. Roster/health stay auth-optional.
        ...(this.config.agent_key ? { authorization: `Bearer ${this.config.agent_key}` } : {}),
        // The agent key authenticates the harness, not a seat — reads carry the occupied seat so the
        // server can assert occupancy (SPEC A.7 §253). A send conveys it via the envelope `from`.
        ...(this.config.member ? { 'x-musterd-seat': this.config.member } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      throw new Error(parsed.success ? parsed.data.error.message : `server error ${res.status}`);
    }
    return json;
  }

  async health(): Promise<void> {
    await this.request('GET', '/health');
  }

  sendEnvelope(envelope: Envelope) {
    return this.request('POST', `/teams/${this.config.team}/messages`, { envelope });
  }

  roster(): Promise<{ members: MemberSummary[] }> {
    return this.request('GET', `/teams/${this.config.team}/members`);
  }

  async fetchInbox(
    unreadOnly = true,
  ): Promise<{ messages: Envelope[]; cursor: { last_read_ts: number } }> {
    const q = unreadOnly ? '?unread=1' : '';
    return this.request('GET', `/teams/${this.config.team}/inbox${q}`);
  }

  markRead(messageId: string) {
    return this.request('POST', `/teams/${this.config.team}/inbox/cursor`, {
      last_read_message_id: messageId,
    });
  }

  // ── Coordination lanes, Phase 1 (ADR 083). Every mutation returns { lane, warnings } — warn-only.
  openLane(body: unknown): Promise<{ lane: Lane; warnings: LaneWarning[] }> {
    return this.request('POST', `/teams/${this.config.team}/lanes`, body);
  }

  updateLane(id: string, patch: unknown): Promise<{ lane: Lane; warnings: LaneWarning[] }> {
    return this.request(
      'PATCH',
      `/teams/${this.config.team}/lanes/${encodeURIComponent(id)}`,
      patch,
    );
  }

  laneBoard(
    q: {
      project?: string | undefined;
      mine?: boolean | undefined;
      open?: boolean | undefined;
      goal?: string | undefined;
    } = {},
  ): Promise<{ lanes: Lane[]; warnings: LaneWarning[] }> {
    const params = new URLSearchParams();
    if (q.project) params.set('project', q.project);
    if (q.mine) params.set('mine', '1');
    if (q.open) params.set('open', '1');
    if (q.goal) params.set('goal', q.goal);
    const qs = params.toString();
    return this.request('GET', `/teams/${this.config.team}/lanes${qs ? `?${qs}` : ''}`);
  }

  /** The orientation brief (ADR 049/084) — one server-side projection, rendered by CLI + MCP alike. */
  next(): Promise<NextBrief> {
    return this.request('GET', `/teams/${this.config.team}/next`);
  }

  /** Declared Goals (ADR 048's general-team seam, resolved by ADR 084). */
  goals(): Promise<{ goals: Goal[] }> {
    return this.request('GET', `/teams/${this.config.team}/goals`);
  }

  declareGoal(body: unknown): Promise<{ goal: Goal }> {
    return this.request('POST', `/teams/${this.config.team}/goals`, body);
  }

  /** The insight report (ADR 050/084) — one server-side projection. */
  report(): Promise<Report> {
    return this.request('GET', `/teams/${this.config.team}/report`);
  }

  // ── Seat memory (ADR 093): the seat's private continuity blob, seat-authenticated — the server
  // resolves the seat from the token + x-musterd-seat header, so these operate on the caller's OWN
  // seat only. Save is last-write-wins; the body travels only over the explicit read.
  async saveMemory(input: { headline: string; body?: string }): Promise<void> {
    await this.request('PUT', `/teams/${this.config.team}/memory`, input);
    // Keep the occupy-delivered envelope current so an already-joined team_join shows the note just
    // saved, not the one from occupy time (last-write-wins mirrors the server row).
    this.memoryEnvelope = {
      headline: input.headline,
      saved_at: Date.now(),
      size_bytes: Buffer.byteLength(input.body ?? '', 'utf8'),
    };
  }

  readMemory(): Promise<{ headline: string; body: string; saved_at: number }> {
    return this.request('GET', `/teams/${this.config.team}/memory`);
  }

  /**
   * Claim the member's seat: open the WS, `hello`, and resolve once the server sends `welcome`.
   * Rejects if the seat is already live in another session (`member_busy`) or the hello is refused.
   * Idempotent while already joined. Explicit activation — nothing claims presence before this (M3).
   */
  join(timeoutMs?: number): Promise<void> {
    if (this.joinedFlag) return Promise.resolve();
    if (!this.config.agent_key) {
      return Promise.reject(
        new Error('no agent key — set MUSTERD_AGENT_KEY (the team agent key) to claim a seat'),
      );
    }
    if (!this.claimTarget()) {
      return Promise.reject(
        new Error(
          'no seat to claim — name one with team_join {as} or set MUSTERD_CLAIM=seat:<name>',
        ),
      );
    }
    this.wantPresence = true;
    this.waitOnPending = (timeoutMs ?? 0) > 0;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const clearTimer = () => {
        if (this.joinTimer) clearTimeout(this.joinTimer);
        this.joinTimer = null;
      };
      // One blocking call (ADR 087): resolve on `occupied`, reject on a terminal refusal — and, when a
      // claim parks on `pending`, keep waiting for the admin's pushed decision instead of returning.
      this.pendingJoin = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimer();
          resolve();
        },
        reject: (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(e);
        },
      };
      if (timeoutMs && timeoutMs > 0) {
        this.joinTimer = setTimeout(() => {
          // Timed out waiting for approval. Detach this call but leave the socket OPEN so a later
          // approval still occupies in the background (the pushed `occupied` sets joined + persists the
          // resume token); a follow-up team_join then reports "already joined".
          this.pendingJoin = null;
          if (settled) return;
          settled = true;
          this.joinTimer = null;
          reject(new Error(this.lastJoinErrorMsg ?? 'timed out waiting for admin approval'));
        }, timeoutMs);
        this.joinTimer.unref?.();
      }
      this.openSocket();
    });
  }

  /** The open claim request id while this session is parked awaiting approval (ADR 087), or null. */
  get awaitingRequestId(): string | null {
    return this.pendingRequestId;
  }

  /** The seat/role this session claims: a resolved seat re-occupies itself; else the claim policy. */
  private claimTarget(): ClaimTarget | null {
    if (this.config.member) return { seat: this.config.member };
    const c = this.config.claim;
    if (c.mode === 'seat') return { seat: c.name };
    if (c.mode === 'role') return { role: c.role };
    return null; // `chat` — assign-in-chat, no auto-claim target
  }

  /** Release the seat (back to dormant). The server keeps a 45s reclaim grace; tools stay registered. */
  leave(): void {
    this.wantPresence = false;
    this.joinedFlag = false;
    this.memoryEnvelope = null; // occupy-scoped: stale once the seat is released
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws?.close();
    this.ws = null;
  }

  /** Open the background WS and send hello; (re)used by join() and reconnect. */
  private openSocket(): void {
    if (this.closed) return;
    const ws = new WebSocket(wsBase(this.config.server) + '/ws');
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      // v0.3 (ADR 075/078): present the team agent key + a claim target (replaces `hello {token}`).
      ws.send(
        JSON.stringify({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: this.config.team,
          key: this.config.agent_key,
          target: this.claimTarget(),
          ...(this.config.grant !== undefined ? { grant: this.config.grant } : {}),
          surface: this.config.surface,
          provenance: this.config.provenance,
          workspace: this.config.workspace,
          ...(this.config.driver ? { driver: this.config.driver } : {}),
        }),
      );
    });
    ws.on('message', (data) => {
      let frame: WSServerFrame;
      try {
        frame = JSON.parse(data.toString()) as WSServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'occupied') {
        // Claim succeeded — the server resolved + assigned the seat (a role pool's `<role>-<n>` too).
        this.joinedFlag = true;
        this.lastJoinErrorMsg = null;
        this.pendingRequestId = null;
        this.waitOnPending = false;
        this.config.member = frame.seat.name;
        // The continuity envelope (ADR 093): headline + age, never the body — team_join renders it
        // as the one-line pointer; the body is fetched only by an explicit team_memory_read.
        this.memoryEnvelope = frame.memory ?? null;
        // Resume token (ADR 087): the first approval delivers a reusable grant here — keep it so
        // `persistBinding` writes it into `binding.grant` and reconnects re-occupy without approval.
        if (frame.grant) this.config.grant = frame.grant;
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'team' }));
        this.heartbeat = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
        }, 15_000);
        this.heartbeat.unref?.();
        this.pendingJoin?.resolve();
        this.pendingJoin = null;
      } else if (frame.type === 'refused') {
        // Terminal denial (seat occupied / not admin / expired grant, etc.) — stop holding the seat
        // and don't thrash reconnecting (a reconnect would just be refused again).
        this.wantPresence = false;
        this.pendingRequestId = null;
        this.waitOnPending = false;
        const msg = `${frame.code}: ${frame.message}`;
        this.lastJoinErrorMsg = msg;
        this.pendingJoin?.reject(new Error(msg));
        this.pendingJoin = null;
        ws.close();
      } else if (frame.type === 'pending') {
        // No grant — the server opened a claim request (A.5) and holds this socket open.
        this.pendingRequestId = frame.request_id;
        this.lastJoinErrorMsg = `pending approval — request ${frame.request_id} (an admin must approve)`;
        if (this.waitOnPending) {
          // Blocking team_join (ADR 087, spec-gap 3): park — keep the socket + pendingJoin so the
          // admin's pushed terminal `occupied`/`refused` resolves this same call. No reject, no close,
          // no reconnect thrash. join()'s timeout bounds the wait; a later push still occupies silently.
        } else {
          // Best-effort autojoin: stay a pending presence (the marker + resolution-watcher path handle
          // the eventual claim). Reject so startup doesn't hang, and don't hold the socket.
          this.wantPresence = false;
          this.pendingJoin?.reject(new Error(this.lastJoinErrorMsg));
          this.pendingJoin = null;
          ws.close();
        }
      } else if (frame.type === 'error' && frame.code === 'superseded') {
        // Newest-wins (ADR 017): a newer session of this seat took it over. Stop holding and do **not**
        // reconnect — otherwise two sessions of one identity ping-pong displacing each other forever
        // (the claim-supersede war). Terminal, like refused/pending.
        this.wantPresence = false;
        this.joinedFlag = false;
        this.pendingRequestId = null;
        this.waitOnPending = false;
        this.lastJoinErrorMsg = `${frame.code}: ${frame.message}`;
        this.pendingJoin?.reject(new Error(this.lastJoinErrorMsg));
        this.pendingJoin = null;
        ws.close();
        // ADR 092: a *same-workspace* takeover means this process is a reload orphan — its host is gone
        // and a dormant adapter has no purpose. Signal the entrypoint to exit cleanly (drop presence,
        // flush telemetry, exit 0). A cross-workspace takeover stays dormant (a genuinely different
        // session on another machine/branch) — unchanged.
        if (frame.same_workspace) this.onReplaced?.();
      } else if (frame.type === 'deliver') {
        this.push(frame.envelope);
      }
    });
    ws.on('close', () => {
      this.joinedFlag = false;
      this.pendingRequestId = null;
      this.waitOnPending = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.pendingJoin) {
        this.pendingJoin.reject(new Error('connection closed before join completed'));
        this.pendingJoin = null;
        this.wantPresence = false;
        return;
      }
      this.scheduleReconnect();
    });
    ws.on('error', () => {
      /* the close handler rejects/reschedules */
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.wantPresence) return;
    const delay = Math.min(this.backoff, 30_000);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    const t = setTimeout(() => this.openSocket(), delay);
    t.unref?.();
  }

  private push(env: Envelope): void {
    if (this.seen.has(env.id)) return;
    this.seen.add(env.id);
    this.buffer.push(env);
  }

  /** Drain buffered live deliveries (dedup by id is already applied). */
  drainBuffer(): Envelope[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  markSeen(id: string): void {
    this.seen.add(id);
  }

  close(): void {
    this.closed = true;
    this.wantPresence = false;
    this.joinedFlag = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
