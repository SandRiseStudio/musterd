import {
  ErrorBodySchema,
  SeedListSchema,
  SeedResultSchema,
  PROTOCOL_VERSION,
  type AskContract,
  type DeliveryHint,
  type ClaimTarget,
  type Envelope,
  type Goal,
  type Lane,
  isWireAttestationSource,
  type LaneWarning,
  type MemberSummary,
  type MemoryEnvelope,
  type NextBrief,
  type Report,
  type Seed,
  type SubmitSeedBrief,
  type PromoteSeed,
  type TeamMemorySearchResponse,
  TeamMemorySearchResponseSchema,
  type ToolTelemetryReport,
  type WakeContextPacket,
  type WakeContextRequest,
  WakeContextRequestSchema,
  WakeContextResponseSchema,
  type WSServerFrame,
} from '@musterd/protocol';
import { WebSocket } from 'ws';
import { clearGrantFromBinding } from './binding.js';
import { refreshAttestation, type McpConfig } from './config.js';
import { reconcileCursorCapture } from './cursorCapture.js';
import { SessionAttestation } from './sessionLiveness.js';

/**
 * What the daemon says about a `handoff`'s lane (ADR 231). Either `lane` — attached because the
 * sender held exactly one live lane — or `warning`, when they held several and the daemon refused to
 * guess. Absent when the sender holds none (the legal lane-less handoff) or the daemon predates 231.
 */
export type HandoffLaneAck =
  | { lane: string; branch: string | null; source: 'derived' }
  | { warning: string };

/** A refuse whose cause is a bad *grant*, not a bad seat — drop the grant and retry bare (ADR 193). */
function isStaleGrantRefusal(frame: { code: string; message: string }): boolean {
  if (frame.code === 'expired_grant') return true;
  return /grant (expired|revoked|consumed|not_found)/i.test(`${frame.code} ${frame.message}`);
}

function wsBase(server: string): string {
  return server.replace(/^http/, 'ws');
}

/** Presence heartbeat cadence, and the window in which a tool call still counts as proof of life
 *  (ADR 164): one beat, so every check is judged against activity since the previous one. */
export const HEARTBEAT_MS = 15_000;

/**
 * Whether a non-live ladder verdict should actually release the seat — **activity outranks
 * inference** (ADR 164, seat-drop fault B2).
 *
 * Every rung below `ppid` is an inference about whether the harness is still there, drawn from disk:
 * a transcript that stopped growing, an `ended_at` that may have been written for a neighbour session
 * which briefly owned the slot. A tool call is not an inference — the harness called us. So a session
 * that acted within the last heartbeat cannot be dead, whatever the ladder read.
 *
 * `ppid` is exempt: being re-parented to launchd is process fact, not inference, and an orphaned
 * adapter is orphaned however recently it acted.
 */
export function shouldReleaseOnVerdict(
  rung: string | undefined,
  lastActivityAt: number,
  now: number,
  heartbeatMs = HEARTBEAT_MS,
): boolean {
  if (rung === 'ppid') return true;
  return now - lastActivityAt >= heartbeatMs;
}

/**
 * Retry schedule for a request whose connection was refused (§ {@link connectionNeverEstablished}).
 *
 * A daemon bounce is a real, routine hole in HTTP availability: measured 2026-07-29 at **849ms** (16
 * consecutive 50ms polls) against a throwaway daemon killed and relaunched the way `service refresh`
 * does it. The auto-refresher has driven that bounce **116 times** on the dogfood machine and every
 * single one went through live sessions — its quiet-period guard has never once deferred, because on
 * a 12-seat box "some seat is connected" is the steady state, not the exception. Without a retry, an
 * act unlucky enough to land in that sub-second window simply fails, and the agent is told its work
 * did not go through.
 *
 * The sum covers the measured outage about twice over, while a daemon that is genuinely gone still
 * fails in under two seconds instead of hanging.
 *
 * Applied to WRITES only (§ {@link worthRetrying}).
 */
export const RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * Only a write earns a retry, and the asymmetry is the point: losing an act is the damage this fix
 * exists to prevent, while a lost read costs nothing — the next inbox poll or health check fetches it
 * again a moment later.
 *
 * It also protects the hot path. `GET /inbox/interrupt-check` runs at *every tool boundary* (ADR 088),
 * so retrying reads would add the whole retry budget to every single tool call whenever the daemon is
 * genuinely stopped — trading a rare lost act for a permanently sluggish session, which is a worse
 * bargain than the bug.
 */
function worthRetrying(method: string): boolean {
  return method !== 'GET';
}

/**
 * True only when the TCP connection was never established, which is the one case where re-sending is
 * provably safe: the request never reached the server, so it cannot have been acted on once already.
 *
 * A **reset** connection is deliberately excluded. That one was live, the daemon may well have
 * processed the body before dying, and re-posting it would duplicate the act — a second copy of a
 * message, or a second lane claim. Node's fetch reports refusal and reset with the *same*
 * `TypeError: fetch failed` message and puts the real code only on `cause.code`, so this has to read
 * the cause. The CLI's `isConnRefused()` text-matches ECONNREFUSED *and* ECONNRESET *and* the bare
 * "fetch failed" string: right for "can't reach the daemon", unusable as a retry predicate.
 */
function connectionNeverEstablished(err: unknown): boolean {
  return (err as { cause?: { code?: string } } | null | undefined)?.cause?.code === 'ECONNREFUSED';
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
  /** The ADR 164 session ladder, created lazily on the first heartbeat tick. */
  private session: SessionAttestation | null = null;
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
  /** The Team Role charter delivered by authenticated occupancy; never sourced from Workspace files. */
  private charterText: string | null = null;
  /** Why the last join attempt failed — surfaced by the dormant tool guards so a silent autojoin
   * failure (e.g. wrong-db token rejection) is visible to the agent, not just "call team_join". */
  private lastJoinErrorMsg: string | null = null;
  private releasedByLivenessFlag = false;
  private lastActivityAt = 0;
  /** One drop-and-bare-retry per join attempt when a grant is refused as stale (ADR 193). */
  private staleGrantRetried = false;
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

  /**
   * Whether this session **holds its seat** — the question the acting tools actually mean, and
   * deliberately not the same as {@link joined}.
   *
   * `joined` is WEBSOCKET state: `ws.on('close')` clears it and `scheduleReconnect` backs off 1s →
   * 30s before the socket returns. But acts do not travel over that socket — `sendEnvelope`,
   * `fetchInbox` and the memory calls are all HTTP, and the server keeps the seat through a
   * disconnect (the ADR 010 reclaim grace). So gating acts on `joined` refused work that would have
   * succeeded, and told the agent it had never joined because somebody restarted the daemon. That is
   * how a handoff note was lost on 2026-07-28.
   *
   * Holding a seat is two facts, both durable across a socket flap: this session **occupied** one
   * (`member` is set, assigned by the server's `occupied` frame), and it has not **given it up** —
   * `wantPresence` goes false exactly on the deliberate exits (`leave`, `close`) and on the terminal
   * refusals (`refused`, `superseded`), so a newest-wins takeover still stops this session acting.
   */
  get holdsSeat(): boolean {
    return this.claimed && this.wantPresence;
  }

  /** The claimed seat's member name, or undefined while pending (unclaimed). */
  get member(): string | undefined {
    return this.config.member;
  }

  /** This session's pending-presence disambiguation code (ADR 033). */
  /** This adapter dist's own build ref (ADR 135) — what the running process booted with. */
  get build(): string | undefined {
    return this.config.build;
  }
  get claimCode(): string {
    return this.config.claimCode;
  }

  /** The memory envelope the last occupy delivered (ADR 093), or null when the seat has no note. */
  get memory(): MemoryEnvelope | null {
    return this.memoryEnvelope;
  }

  /** The Team Role charter the last authenticated occupancy delivered, if the Member has one. */
  get charter(): string | null {
    return this.charterText;
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

  /**
   * Record a join failure the socket frames never saw — a transport-level one (connection refused,
   * socket hang up) that rejects `join()` before any `error` frame arrives. Without this the
   * dormant-guard message degrades to a bare "call team_join first" for exactly the failure a reader
   * most needs explained, which is what made the seat-drop incident read as a mystery rather than as
   * a failed autojoin. Cleared like the others, by the next successful join.
   */
  noteJoinFailure(message: string): void {
    this.lastJoinErrorMsg = message;
  }

  // reason: returns parsed JSON of varying shape; callers narrow at each call site.

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        // Built inside the loop so each attempt gets a FRESH abort signal — a timeout signal hoisted
        // out would already be spent by the time a retry used it, aborting instantly.
        res = await fetch(this.config.server + path, {
          method,
          headers: {
            'content-type': 'application/json',
            // v0.3 (ADR 075): authenticate with the team agent key (Bearer); the server dispatches on the
            // prefix → the live-presence occupancy this session holds. Roster/health stay auth-optional.
            ...(this.config.agent_key ? { authorization: `Bearer ${this.config.agent_key}` } : {}),
            // The agent key authenticates the harness, not a seat — reads carry the occupied seat so the
            // server can assert occupancy (SPEC A.7 §253). A send conveys it via the envelope `from`.
            ...(this.config.member ? { 'x-musterd-seat': this.config.member } : {}),
            // Ambient occupancy (ADR 275 / ADR 057): label the one-shot touch with the surface
            // this adapter attests — capture, not a stale binding declaration. Honored only when
            // no resident WS session owns liveness (`touchAmbientPresence` is a no-op under one).
            ...(this.config.surface ? { 'x-musterd-surface': this.config.surface } : {}),
            ...(opts.headers ?? {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
        });
        break;
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !worthRetrying(method) || !connectionNeverEstablished(err)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      throw new Error(parsed.success ? parsed.data.error.message : `server error ${res.status}`);
    }
    return json;
  }

  async health(): Promise<{ ok?: boolean; build?: string }> {
    return (await this.request('GET', '/health')) as { ok?: boolean; build?: string };
  }

  private daemonBuildMemo: { value: string | undefined; at: number } | null = null;

  /**
   * The daemon's build ref from `/health` (ADR 130/134) — the reference every client compares its own
   * stamp against. Memoized for 60s: cheap on chatty tools, yet a daemon `service refresh` mid-session
   * is picked up on the next poll rather than never. Auth-optional endpoint, so this works pre-join.
   * Errors → undefined (the skew check stays silent rather than guessing).
   */
  async daemonBuild(): Promise<string | undefined> {
    const now = Date.now();
    if (this.daemonBuildMemo && now - this.daemonBuildMemo.at < 60_000) {
      return this.daemonBuildMemo.value;
    }
    let value: string | undefined;
    try {
      value = (await this.health()).build;
    } catch {
      value = undefined;
    }
    this.daemonBuildMemo = { value, at: now };
    return value;
  }

  /** POST the envelope. On an `ask`, the daemon's ack additionally carries the derived tier contract
   *  with the reachability projection (`unblocker_reachable`, ADR 153) — a fact only the daemon can
   *  compute; callers fall back to the pure local contract when an older daemon omits it. A directed
   *  act to a live recipient may also carry a `delivery_hint` (ADR 167): a daemon-composed nudge the
   *  sender can relay over the harness's session messaging. A `handoff` may carry `handoff_lane`
   *  (ADR 231): either the lane the daemon attached because the sender held exactly one, or a
   *  warning that they hold several and the `why` cannot tell which. All additive — older daemons
   *  omit them. */
  sendEnvelope(envelope: Envelope): Promise<{
    ask_contract?: AskContract;
    delivery_hint?: DeliveryHint;
    handoff_lane?: HandoffLaneAck;
  }> {
    return this.request('POST', `/teams/${this.config.team}/messages`, { envelope }) as Promise<{
      ask_contract?: AskContract;
      delivery_hint?: DeliveryHint;
      handoff_lane?: HandoffLaneAck;
    }>;
  }

  roster(role?: string): Promise<{
    members: MemberSummary[];
    /** The team's role library (ADR 227 discovery): name + one-line summary. Absent from an older
     *  daemon — every consumer degrades to members-only. */
    roles?: Array<{ name: string; summary: string | null }>;
  }> {
    // ADR 227 close-out: the role filter rides the wire so the daemon can see (and audit) the
    // discovery query. An older daemon ignores the param and returns the unfiltered roster —
    // callers keep a defensive local pass.
    const q = role ? `?role=${encodeURIComponent(role)}` : '';
    return this.request('GET', `/teams/${this.config.team}/members${q}`);
  }

  async fetchInbox(
    unreadOnly = true,
    /** The newest N — the slice this surface actually renders. Naming it keeps `GET /inbox`'s
     *  default PREFIX bound out of the way: an agent checking once a turn must be handed the newest
     *  acts, not the stalest (ADR 287). What the bound cuts comes back as `unread_remaining`. */
    limit?: number,
  ): Promise<{
    messages: Envelope[];
    cursor: { last_read_ts: number };
    /** Ids of asks this seat has already replied to (by `meta.in_reply_to`). Server-computed
     *  because the inbox excludes our own sends, so the reply that answers an ask is invisible
     *  here — see the note on `GET /inbox`. Absent from an older daemon; callers degrade to
     *  treating everything as open, which is the pre-existing behaviour. */
    answered?: string[];
    /** ADR 254: eligible-set acts in this inbox that someone else has already answered, and who.
     *  Server-computed for the same reason as `answered`, and more so: the discharging reply is a DM
     *  to the asker, so a second eligible seat is not a party to it and cannot see it at any price.
     *  Absent from an older daemon; callers degrade to showing the act as still owed. */
    discharged?: { id: string; by: string }[];
    /** Unread this reply could not carry. Non-zero means the read cursor must not move past what
     *  was rendered — see `planInboxCheck`. Absent from an older daemon ⇒ nothing was cut. */
    unread_remaining?: number;
  }> {
    const p = new URLSearchParams();
    if (unreadOnly) p.set('unread', '1');
    if (limit !== undefined) p.set('limit', String(limit));
    const q = p.toString();
    return this.request('GET', `/teams/${this.config.team}/inbox${q ? `?${q}` : ''}`);
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

  updateLane(
    id: string,
    patch: unknown,
  ): Promise<{
    lane: Lane;
    warnings: LaneWarning[];
    /** value-layer design: advisory lines for THIS caller only (e.g. the ship nudge) — never a wake. */
    notices?: string[];
    /** ADR 283: present when THIS patch closed the lane — what the close recorded. Absent from an
     *  older daemon and from every non-terminal patch; absence means "no verdict to report", so a
     *  reader must fall back rather than invent one. `verified: false` alone cannot separate the
     *  by-design exemption from the ADR 172 degradation — that is what `reason` is for. */
    closed?: { verified: boolean; reason: string };
    /** ADR 169: present when the patch entered ready_for_review — the review routing. */
    review?: {
      reviewer?: string;
      route?: string;
      self_close_sanctioned?: boolean;
      /** The lane was ALREADY awaiting acceptance — this is a report of the standing state (who was
       *  asked at the original submit), not a fresh routing decision. Set on repeat submits, e.g.
       *  recording a merge SHA after the PR lands. A standing report must never be read as "nobody
       *  was asked": that misread sanctioned self-close against lanes with a pending acceptor. */
      standing?: boolean;
      /** ADR 234 increment 2: the submit was acceptance-exempt (declared low stakes) — no ask
       *  exists and none is coming; self-close is the designed path, not a degradation. */
      acceptance_exempt?: boolean;
      /** ADR 235: the team has an acceptance backstop, so silence no longer means self-close.
       *  Absent from an older daemon and from the no-acceptor branch — absent means "no backstop
       *  to rely on", which is the pre-235 advice, so the fallback is the safe one. */
      backstop?: { armed: boolean; grace_ms: number };
    };
  }> {
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

  // ── Shared Seeds (ADR 319). Parse every daemon response at this wire boundary.
  async seeds(): Promise<Seed[]> {
    return SeedListSchema.parse(await this.request('GET', `/teams/${this.config.team}/seeds`))
      .seeds;
  }

  async seed(id: string): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request('GET', `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}`),
    ).seed;
  }

  async claimSeed(id: string): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request(
        'POST',
        `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}/claim`,
        {},
      ),
    ).seed;
  }

  async askSeed(id: string, body: string): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request(
        'POST',
        `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}/clarification`,
        { body },
      ),
    ).seed;
  }

  async answerSeed(id: string, body: string): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request(
        'POST',
        `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}/answer`,
        { body },
      ),
    ).seed;
  }

  async submitSeed(id: string, body: SubmitSeedBrief): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request(
        'POST',
        `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}/brief`,
        body,
      ),
    ).seed;
  }

  async promoteSeed(id: string, body: PromoteSeed): Promise<Seed> {
    return SeedResultSchema.parse(
      await this.request(
        'POST',
        `/teams/${this.config.team}/seeds/${encodeURIComponent(id)}/promote`,
        body,
      ),
    ).seed;
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

  /** Record a goal outcome note (value-layer design). `goal: null` = not yet declared (queued). */
  goalOutcome(body: { goal_id: string; outcome: string }): Promise<{ goal: Goal | null }> {
    return this.request('POST', `/teams/${this.config.team}/goals/outcome`, body);
  }

  /** Retract a Goal (goal-retract design). `goal: null` = not yet declared (signal queued). */
  goalRetract(body: { goal_id: string }): Promise<{ goal: Goal | null }> {
    return this.request('POST', `/teams/${this.config.team}/goals/retract`, body);
  }

  /** The insight report (ADR 050/084) — one server-side projection. */
  report(): Promise<Report> {
    return this.request('GET', `/teams/${this.config.team}/report`);
  }

  /**
   * The batched tool-call telemetry flush (ADR 144 inc 1). Presence-neutral by contract
   * (x-musterd-no-touch): a background timer must never fake liveness. Hard-capped so a dead
   * daemon can't hang the graceful teardown's final flush.
   */
  async reportToolTelemetry(report: ToolTelemetryReport): Promise<void> {
    await this.request('POST', `/teams/${this.config.team}/telemetry/tool-calls`, report, {
      headers: { 'x-musterd-no-touch': '1' },
      timeoutMs: 1500,
    });
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

  /** ADR 209's recipient-scoped, body-free wake orientation index. */
  async wakeContext(request: WakeContextRequest): Promise<WakeContextPacket> {
    const target = WakeContextRequestSchema.safeParse(request);
    if (!target.success) throw new Error('wake context requires exactly one act_id or lane_id');
    const json = await this.request('POST', `/teams/${this.config.team}/wake-context`, target.data);
    const response = WakeContextResponseSchema.safeParse(json);
    if (!response.success)
      throw new Error('wake-context response did not match the protocol schema');
    return response.data.context;
  }

  /** ADR 327: team-memory search — the read side of `insight` acts, via the daemon's derived FTS
   * fold. Parsed against the protocol schema so an older daemon (no route) fails loudly here
   * rather than leaking shape guesses into a tool result. */
  async teamMemorySearch(queryParams: string): Promise<TeamMemorySearchResponse> {
    const json = await this.request(
      'GET',
      `/teams/${this.config.team}/memory/search?${queryParams}`,
    );
    const response = TeamMemorySearchResponseSchema.safeParse(json);
    if (!response.success) throw new Error('team memory search response did not match the schema');
    return response.data;
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
    this.staleGrantRetried = false;
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
          reject(new Error(this.lastJoinErrorMsg ?? this.unexplainedTimeout()));
        }, timeoutMs);
        this.joinTimer.unref?.();
      }
      this.openSocket();
    });
  }

  /**
   * What to say when join() times out with nothing else to go on. Only an actually-opened request
   * licenses naming an approval: the old unconditional "timed out waiting for admin approval" was a
   * guess that read as a finding, and it sent a live diagnosis hunting for a `requests` row that had
   * never existed. An unexplained timeout must read as unexplained.
   */
  private unexplainedTimeout(): string {
    return this.pendingRequestId
      ? `timed out waiting for admin approval (request ${this.pendingRequestId})`
      : `no answer from the server on the claim — it was never accepted, refused, or queued ` +
          `(${this.config.server}); check the daemon log for a claim.failed row`;
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

  /** Write Cursor capture if the live `.txt` disagrees, then re-read attestation (ADR 270). */
  private refreshObservedModel(): void {
    reconcileCursorCapture(this.config.bindingDir);
    refreshAttestation(this.config);
  }

  /**
   * The ADR 164 ladder, run on the heartbeat tick. Returns true when this tick must NOT heartbeat.
   *
   * Almost everything ends in `dormant` — presence released, tools still registered, ADR 108
   * autojoin re-occupying on the next tool call. Dormancy is recoverable and an exit is not, and a
   * live probe showed how easily a "definitive" signal can be wrong about a session that is in fact
   * alive. Only `exit` (the process re-parented, so nothing spawned us any more) tears the process
   * down. Never throws: any failure to judge leaves the heartbeat alone.
   */
  private attestSession(): boolean {
    let verdict;
    try {
      this.session ??= new SessionAttestation({
        bindingDir: this.config.bindingDir ?? process.cwd(),
      });
      verdict = this.session.check();
    } catch {
      return false; // fail open — an unjudgeable session is not evidence of a dead one
    }
    if (verdict.verdict === 'live') return false;
    // Activity outranks inference — see shouldReleaseOnVerdict. Without this, the re-arm below only
    // recovers from a wrong verdict every 15s; with it, a working session never gets one.
    if (!shouldReleaseOnVerdict(verdict.rung, this.lastActivityAt, Date.now())) return false;
    process.stderr.write(
      `musterd: session no longer live (${verdict.rung}) — releasing seat presence\n`,
    );
    this.leave();
    // Mark WHY the seat was released, after `leave()` (which clears the flag for the deliberate
    // case). ADR 164 promises "a dormant adapter comes back on its next tool call" — this flag is
    // what lets the arming layer keep that promise, and it must distinguish a ladder demotion from
    // an explicit `team_leave`, which is meant to stay left. The reason also reaches the agent: the
    // demotion used to be announced only on stderr, a channel no session reads, while the tool-facing
    // message said "you haven't joined the team yet" — the opposite of what happened.
    this.releasedByLivenessFlag = true;
    this.lastJoinErrorMsg =
      `seat presence was released because this session looked inactive ` +
      `(${verdict.rung ?? 'unknown'} check); a tool call is evidence otherwise, so the next one re-joins`;
    if (verdict.verdict === 'exit') this.onReplaced?.();
    return true;
  }

  /**
   * True when the ADR 164 liveness ladder released this seat — as opposed to a deliberate
   * `team_leave`. A tool call arriving afterwards is direct evidence the session is alive, which
   * outranks the ladder's inference, so the arming layer re-joins on it. Cleared by the next
   * successful occupy, and never set by `leave()` itself.
   */
  get releasedByLiveness(): boolean {
    return this.releasedByLivenessFlag;
  }

  /** Record that the harness just called a tool — the only first-hand evidence this process gets
   *  that its session is alive. Consulted by {@link attestSession}; see the note there. */
  noteActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  /** Release the seat (back to dormant). The server keeps a 45s reclaim grace; tools stay registered. */
  leave(): void {
    this.releasedByLivenessFlag = false; // a deliberate release; attestSession re-sets it after
    this.wantPresence = false;
    this.joinedFlag = false;
    this.memoryEnvelope = null; // occupy-scoped: stale once the seat is released
    this.charterText = null;
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
    const sendClaim = (includeGrant: boolean) => {
      this.refreshObservedModel();
      ws.send(
        JSON.stringify({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: this.config.team,
          key: this.config.agent_key,
          target: this.claimTarget(),
          ...(includeGrant && this.config.grant !== undefined ? { grant: this.config.grant } : {}),
          surface: this.config.surface,
          provenance: this.config.provenance,
          workspace: this.config.workspace,
          ...(this.config.driver ? { driver: this.config.driver } : {}),
          ...(this.config.model
            ? {
                model: this.config.model,
                // The tier rides with the id, never alone: `model_source` describes `model` and is
                // meaningless without it. `unknown` is not on the wire — no model, no stamp.
                ...(isWireAttestationSource(this.config.modelSource)
                  ? { model_source: this.config.modelSource }
                  : {}),
              }
            : {}),
          ...(this.config.build ? { build: this.config.build } : {}),
          ...(this.config.epoch != null ? { epoch: this.config.epoch } : {}),
          // ADR 241: the correlation token, when a wake spawned this session. Absent otherwise —
          // never a placeholder, because the host treats a match as proof of authorship.
          ...(this.config.wakeLease ? { wake_lease: this.config.wakeLease } : {}),
        }),
      );
    };
    ws.on('open', () => {
      this.backoff = 1000;
      // A reconnect is a second chance to attest truthfully — re-read before claiming (ADR 158 §7).
      // v0.3 (ADR 075/078): present the team agent key + a claim target (replaces `hello {token}`).
      sendClaim(true);
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
        this.releasedByLivenessFlag = false;
        this.staleGrantRetried = false;
        this.lastJoinErrorMsg = null;
        this.pendingRequestId = null;
        this.waitOnPending = false;
        this.config.member = frame.seat.name;
        this.charterText = frame.charter?.trim() || null;
        // The continuity envelope (ADR 093): headline + age, never the body — team_join renders it
        // as the one-line pointer; the body is fetched only by an explicit team_memory_read.
        this.memoryEnvelope = frame.memory ?? null;
        // Resume token (ADR 087): the first approval delivers a reusable grant here — keep it so
        // `persistBinding` writes it into `binding.grant` and reconnects re-occupy without approval.
        if (frame.grant) this.config.grant = frame.grant;
        // The seat's effective capabilities (ADR 144 inc 5), same handling as the grant/model above:
        // learned at claim, persisted by `persistBinding`, and read at the NEXT boot to scope the
        // rendered tool surface before this session can ask. Never consulted for enforcement here.
        // Synced unconditionally: a frame that omits capabilities (an older daemon) must CLEAR the
        // cached record, not preserve it — a stale `can_message:'none'` would otherwise mute the
        // surface across every future occupy, when unknown is defined to fail open (full surface).
        this.config.capabilities = frame.seat.capabilities;
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'team' }));
        this.heartbeat = setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            // Attest the SESSION before asserting presence (ADR 164). A heartbeat vouches for a
            // session, not for the process sending it; an adapter that outlived its harness must
            // stop claiming the seat rather than hold it `working` forever.
            if (this.attestSession()) return;
            // Reconcile Cursor capture then re-read (ADR 270 / ADR 158 §7): hookless cursor-agent
            // never writes model_observed, so a re-read alone would keep the desktop leftover.
            this.refreshObservedModel();
            ws.send(
              JSON.stringify({
                type: 'heartbeat',
                // Re-affirm the attested model each heartbeat (ADR 101) so a mid-occupancy switch
                // or an attestation the claim missed lands without a reconnect; the server no-ops
                // when unchanged.
                ...(this.config.model
                  ? {
                      model: this.config.model,
                      // The tier rides with the id, never alone: `model_source` describes `model` and is
                      // meaningless without it. `unknown` is not on the wire — no model, no stamp.
                      ...(isWireAttestationSource(this.config.modelSource)
                        ? { model_source: this.config.modelSource }
                        : {}),
                    }
                  : {}),
                // Occupancy follows capture (ADR 275): refreshAttestation just updated
                // config.surface from the slot; send it so the presence row does not keep the
                // claim-time declaration. Absent on CLI/web heartbeats ⇒ no change.
                surface: this.config.surface,
              }),
            );
          }
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
        this.pendingJoin?.resolve();
        this.pendingJoin = null;
      } else if (frame.type === 'refused') {
        // Stale grant (ADR 193): a grant is an optimisation, not the authenticator. Drop it from
        // memory + binding and re-claim bare once on this same socket — do NOT clear wantPresence
        // (that is what stranded restarted adapters as pending presence forever).
        if (this.config.grant && !this.staleGrantRetried && isStaleGrantRefusal(frame)) {
          this.staleGrantRetried = true;
          delete this.config.grant;
          try {
            clearGrantFromBinding(this.config.bindingDir);
          } catch {
            // in-memory drop still heals this process; disk write failure is non-fatal
          }
          this.lastJoinErrorMsg = `${frame.code}: ${frame.message} — dropped stale grant, retrying without it`;
          if (ws.readyState === ws.OPEN) sendClaim(false);
          return;
        }
        // Terminal denial (seat occupied / not admin / bad key, etc.) — stop holding the seat
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
      } else if (frame.type === 'error' && frame.code !== 'superseded') {
        // EVERY server error settles an in-flight claim. This branch used to match `superseded`
        // alone, so a claim that failed for any other reason — a constraint the storage layer
        // refused, a bad grant, an internal fault — had its diagnosis delivered here and dropped one
        // line before it would have been reported (found 2026-08-12, ADR 251 live wake: the server
        // said "CHECK constraint failed: surface" and the agent was told it had timed out waiting
        // for an approval nobody requested).
        const msg = `${frame.code}: ${frame.message}`;
        this.lastJoinErrorMsg = msg;
        if (this.pendingJoin || !this.joinedFlag) {
          // The claim never completed: this socket is unauthenticated and useless. Stop holding the
          // seat and don't thrash — a reconnect would hit the same fault (ADR 108 autojoin brings
          // the seat back on the next tool call, once the cause is actually fixed).
          this.wantPresence = false;
          this.pendingRequestId = null;
          this.waitOnPending = false;
          this.pendingJoin?.reject(new Error(msg));
          this.pendingJoin = null;
          ws.close();
        }
        // Already occupied: an error about some later frame is NOT a reason to tear down a working
        // session. Recorded above so the next join()/timeout can name it.
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
    this.memoryEnvelope = null;
    this.charterText = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
