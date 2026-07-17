import {
  AuditResponseSchema,
  DecideResponseSchema,
  ErrorBodySchema,
  ActDeliverySchema,
  GoalListSchema,
  GoalSchema,
  GrantMintSchema,
  LaneBoardSchema,
  LaneResultSchema,
  NextBriefSchema,
  PROTOCOL_VERSION,
  ReportSchema,
  resolveAttestedModel,
  resolveAttestedProvenance,
  TOKEN_PREFIXES,
  type Policy,
  RequestsResponseSchema,
  EnrollResidencyResponseSchema,
  ResidencyListResponseSchema,
  SessionAttestationResponseSchema,
  WakeLeasesResponseSchema,
  type EnrollResidencyBody,
  type EnrollResidencyResponse,
  type ResidencyListResponse,
  type SessionAttestationBody,
  type SessionAttestationResponse,
  type WakeLeasesResponse,
  type WakeReportBody,
  type ActDelivery,
  type AuditResponse,
  type ClaimTarget,
  type DeclareGoal,
  type DecideRequest,
  type DecideResponse,
  type Envelope,
  type Goal,
  type GoalList,
  type GrantMint,
  type IssueGrant,
  type LaneBoard,
  type LaneResult,
  type Member,
  type MemberKind,
  type MemberSummary,
  type MemoryEnvelope,
  type NextBrief,
  type OpenLane,
  type RefusedCode,
  type Report,
  type RequestsResponse,
  type Surface,
  type UpdateLane,
  type WSServerFrame,
} from '@musterd/protocol';
import { WebSocket } from 'ws';
import { buildClaimFrame, parseClaimResponse } from './claim-client.js';
import type { ClaimOutcome } from './claim-client.js';
import { CliError, exitForCode, isConnRefused } from './errors.js';
import { cliBuild } from './version.js';

/** The `/inbox/interrupt-check` response (ADR 088). `raised: false` is the silent common path. */
export interface InterruptCheck {
  raised: boolean;
  /** The daemon-composed one-line notice (never the raw message body). Present iff `raised`. */
  line?: string;
  /** How many interrupt-class acts are waiting. Present iff `raised`. */
  count?: number;
  /** The most-recent interrupt act's structured header. Present iff `raised`. */
  act?: { id: string; from: string; act: string };
}

export interface HttpClientOpts {
  server: string;
  /** The Bearer secret (v0.3, ADR 075): a team agent key (`mskey_`) or human credential (`mscr_`).
   *  The server dispatches on the prefix → live-presence occupancy; replaces the v0.2 seat token. */
  key?: string;
  /**
   * The seat this client acts as (v0.3, ADR 075 / SPEC A.7 §253). An agent key authenticates the
   * *harness*, not a seat, so reads (inbox/availability/audit — no envelope `from`) carry the seat in
   * `x-musterd-seat`; the server asserts that seat is occupied by this key. A `send` conveys it via the
   * envelope `from` instead. Unused on the mskd_ token path (the token already is the seat).
   */
  seat?: string;
  /** This client's surface, sent as `x-musterd-surface` so ambient presence labels it (ADR 057). */
  surface?: string;
  /**
   * Suppress the ambient presence touch (ADR 057) for this client's requests via `x-musterd-no-touch`.
   * For background pollers that read on a member's behalf — the notifier — which must not make an
   * away/idle human look present and so silence the very notification they were owed.
   */
  noTouch?: boolean;
}

export class HttpClient {
  constructor(private opts: HttpClientOpts) {}

  /** A clone of this client that never writes ambient presence — for background polling (notify). */
  presenceNeutral(): HttpClient {
    return new HttpClient({ ...this.opts, noTouch: true });
  }

  // reason: returns parsed JSON of varying shape; callers narrow at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      // ADR 119: re-attest on every ambient HTTP touch when the env declares a model, so
      // fire-and-exit CLI sends keep stamping after the claim presence expires (issue #172).
      // ADR 121: only agent keys (mskey_) forward the header — a human credential (mscr_) is not a
      // harness, so MUSTERD_MODEL in the human's shell must not stamp their occupancy.
      const attestedModel =
        this.opts.key?.startsWith(TOKEN_PREFIXES.agent_key) === true
          ? resolveAttestedModel(process.env)
          : undefined;
      // ADR 131 §6 (increment 5): provenance rides the same gate as model — a wake-spawned
      // session's hook/one-shot CLI commands inherit MUSTERD_PROVENANCE from the actuator, so
      // their ambient touches label the seat `wake` instead of the `session` default (the inc-4
      // mislabel: verify credited a wake against a session-labelled ambient row).
      const attestedProvenance =
        this.opts.key?.startsWith(TOKEN_PREFIXES.agent_key) === true
          ? resolveAttestedProvenance(process.env)
          : undefined;
      res = await fetch(this.opts.server + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.opts.key ? { authorization: `Bearer ${this.opts.key}` } : {}),
          ...(this.opts.seat ? { 'x-musterd-seat': this.opts.seat } : {}),
          ...(this.opts.surface ? { 'x-musterd-surface': this.opts.surface } : {}),
          ...(this.opts.noTouch ? { 'x-musterd-no-touch': '1' } : {}),
          ...(attestedModel !== undefined ? { 'x-musterd-model': attestedModel } : {}),
          ...(attestedProvenance !== undefined
            ? { 'x-musterd-provenance': attestedProvenance }
            : {}),
          // ADR 135: build attestation rides every request, for EVERY credential — no ADR 121 gate.
          // The model gate exists because a model is a harness fact a human must not stamp; build
          // attests the *binary* itself, which a human's (possibly stale) CLI genuinely has.
          ...(cliBuild() !== undefined ? { 'x-musterd-build': cliBuild()! } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (isConnRefused(err)) {
        throw new CliError(
          `can't reach team server at ${this.opts.server} — is the daemon running? (musterd serve)`,
          7,
        );
      }
      throw err;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      if (parsed.success) {
        throw new CliError(
          parsed.data.error.message,
          exitForCode(parsed.data.error.code),
          parsed.data.error.code,
        );
      }
      throw new CliError(`server error (${res.status})`, 1);
    }
    return json;
  }

  health(): Promise<{
    ok: boolean;
    v: string;
    db?: string;
    schema?: number;
    connections?: number;
    /** The commit the daemon's dist was built from (ADR 130/134) — the client-skew reference. */
    build?: string;
  }> {
    return this.request('GET', '/health');
  }
  createTeam(slug: string, creator: { name: string; role?: string }, display?: string) {
    return this.request('POST', '/teams', {
      slug,
      display,
      creator: { name: creator.name, kind: 'human', role: creator.role },
    });
  }
  addMember(slug: string, body: Record<string, unknown>) {
    return this.request('POST', `/teams/${slug}/members`, body);
  }
  roster(slug: string): Promise<{ members: MemberSummary[] }> {
    return this.request('GET', `/teams/${slug}/members`);
  }
  send(slug: string, envelope: Envelope) {
    return this.request('POST', `/teams/${slug}/messages`, { envelope });
  }
  inbox(
    slug: string,
    opts: { unread?: boolean; limit?: number } = {},
  ): Promise<{ messages: Envelope[]; cursor: { last_read_ts: number }; total?: number }> {
    const q = new URLSearchParams();
    if (opts.unread) q.set('unread', '1');
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/teams/${slug}/inbox${qs ? `?${qs}` : ''}`);
  }
  /**
   * The mid-loop interrupt-line probe (ADR 088): is an interrupt-class (urgent, directed) act waiting
   * for this seat? Sub-50ms, read-only, cursor-untouched. Returns `{ raised: false }` on the common
   * silent path, or the **daemon-composed** one-line notice + the act's structured header when raised.
   */
  interruptCheck(slug: string): Promise<InterruptCheck> {
    return this.request('GET', `/teams/${slug}/inbox/interrupt-check`);
  }
  /** Whole-team timeline (the firehose's history side, ADR 061) — every envelope, not just my inbox. */
  messages(
    slug: string,
    opts: { since?: number; limit?: number } = {},
  ): Promise<{ messages: Envelope[] }> {
    const q = new URLSearchParams();
    if (opts.since) q.set('since', String(opts.since));
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/teams/${slug}/messages${qs ? `?${qs}` : ''}`);
  }
  markRead(slug: string, lastReadMessageId: string) {
    return this.request('POST', `/teams/${slug}/inbox/cursor`, {
      last_read_message_id: lastReadMessageId,
    });
  }
  presence(
    slug: string,
    surface: string,
    status?: string,
  ): Promise<{ presence: { id: string; surface: string; status: string }; member: string }> {
    return this.request('POST', `/teams/${slug}/presence`, { surface, status });
  }
  setAvailability(
    slug: string,
    body: { status: string; until?: number | null },
  ): Promise<{ member: MemberSummary }> {
    return this.request('POST', `/teams/${slug}/availability`, body);
  }
  // ── Seat memory (ADR 093): the caller's OWN seat's continuity note — seat-authenticated, no
  // cross-seat path. Save is last-write-wins (caps enforced server-side with the limit named).
  saveMemory(slug: string, input: { headline: string; body?: string }): Promise<void> {
    return this.request('PUT', `/teams/${slug}/memory`, input);
  }
  getMemory(slug: string): Promise<{ headline: string; body: string; saved_at: number }> {
    return this.request('GET', `/teams/${slug}/memory`);
  }
  /** Envelope only (headline + age + size, never the body) — for the status/claim one-liner. */
  getMemoryEnvelope(slug: string): Promise<MemoryEnvelope> {
    return this.request('GET', `/teams/${slug}/memory?envelope=1`);
  }
  clearMemory(slug: string): Promise<void> {
    return this.request('DELETE', `/teams/${slug}/memory`);
  }
  reclaim(slug: string, member: string): Promise<{ ok: boolean; member: string }> {
    return this.request('POST', `/teams/${slug}/members/${encodeURIComponent(member)}/reclaim`);
  }
  /** Release the caller's own seat (ADR 058 unbind): clear bound_at + presence; seat stays declared. */
  unbind(slug: string): Promise<{ ok: boolean; member: string }> {
    return this.request('POST', `/teams/${slug}/unbind`);
  }
  removeMember(
    slug: string,
    member: string,
  ): Promise<{ ok: boolean; member: string; kind: MemberKind }> {
    return this.request('POST', `/teams/${slug}/members/${encodeURIComponent(member)}/remove`);
  }
  /**
   * The governance audit log (ADR 071) — admin-only `GET /teams/:slug/audit`. Newest-first, capped;
   * `limit` (1..500) and `before` (<ms-epoch>) page older entries. The response is parsed through
   * `AuditResponseSchema` at this boundary (ADR 074) so a malformed body never reaches the command.
   */
  async audit(
    slug: string,
    opts: { limit?: number; before?: number; authorized_by?: string } = {},
  ): Promise<AuditResponse> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', String(opts.before));
    if (opts.authorized_by) q.set('authorized_by', opts.authorized_by);
    const qs = q.toString();
    const json = await this.request('GET', `/teams/${slug}/audit${qs ? `?${qs}` : ''}`);
    const parsed = AuditResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('audit response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /**
   * Issue a grant (ADR 076/077) — `POST /teams/:slug/grants`, admin-only. Mints an `msgr_` token that
   * authorizes claiming the given seat/role; returned **once**. A `standing` grant survives until
   * revoked, so a persistent agent seat re-occupies on relaunch without an approval request.
   */
  async issueGrant(slug: string, body: IssueGrant): Promise<GrantMint> {
    const json = await this.request('POST', `/teams/${slug}/grants`, body);
    const parsed = GrantMintSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('grant response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  // ── Coordination lanes, Phase 1 (ADR 083). Mutations return { lane, warnings } — warn-only.
  async openLane(slug: string, body: OpenLane): Promise<LaneResult> {
    const json = await this.request('POST', `/teams/${slug}/lanes`, body);
    const parsed = LaneResultSchema.safeParse(json);
    if (!parsed.success) throw new CliError('lane response did not match the protocol schema', 1);
    return parsed.data;
  }

  async updateLane(slug: string, id: string, patch: UpdateLane): Promise<LaneResult> {
    const json = await this.request(
      'PATCH',
      `/teams/${slug}/lanes/${encodeURIComponent(id)}`,
      patch,
    );
    const parsed = LaneResultSchema.safeParse(json);
    if (!parsed.success) throw new CliError('lane response did not match the protocol schema', 1);
    return parsed.data;
  }

  async laneBoard(
    slug: string,
    q: { project?: string; mine?: boolean; open?: boolean; goal?: string } = {},
  ): Promise<LaneBoard> {
    const params = new URLSearchParams();
    if (q.project) params.set('project', q.project);
    if (q.mine) params.set('mine', '1');
    if (q.open) params.set('open', '1');
    if (q.goal) params.set('goal', q.goal);
    const qs = params.toString();
    const json = await this.request('GET', `/teams/${slug}/lanes${qs ? `?${qs}` : ''}`);
    const parsed = LaneBoardSchema.safeParse(json);
    if (!parsed.success) throw new CliError('lanes response did not match the protocol schema', 1);
    return parsed.data;
  }

  /** The orientation brief (ADR 049/084) — `GET /teams/:slug/next`, one server-side projection. */
  async next(slug: string): Promise<NextBrief> {
    const json = await this.request('GET', `/teams/${slug}/next`);
    const parsed = NextBriefSchema.safeParse(json);
    if (!parsed.success) throw new CliError('next response did not match the protocol schema', 1);
    return parsed.data;
  }

  /** Declared Goals (ADR 048's general-team seam, resolved by ADR 084) — a `message` to `@team`. */
  async declareGoal(slug: string, body: DeclareGoal): Promise<Goal> {
    const json = await this.request('POST', `/teams/${slug}/goals`, body);
    const parsed = GoalSchema.safeParse((json as { goal: unknown }).goal);
    if (!parsed.success) throw new CliError('goal response did not match the protocol schema', 1);
    return parsed.data;
  }

  async goals(slug: string): Promise<GoalList> {
    const json = await this.request('GET', `/teams/${slug}/goals`);
    const parsed = GoalListSchema.safeParse(json);
    if (!parsed.success) throw new CliError('goals response did not match the protocol schema', 1);
    return parsed.data;
  }

  /** The per-act delivery ledger (ADR 090) — `GET /teams/:slug/messages/:id/delivery`. */
  async delivery(slug: string, messageId: string): Promise<ActDelivery> {
    const json = await this.request('GET', `/teams/${slug}/messages/${messageId}/delivery`);
    const parsed = ActDeliverySchema.safeParse(json);
    if (!parsed.success)
      throw new CliError('delivery response did not match the protocol schema', 1);
    return parsed.data;
  }

  /** The insight report (ADR 050/084) — `GET /teams/:slug/report`, one server-side projection. */
  async report(slug: string): Promise<Report> {
    const json = await this.request('GET', `/teams/${slug}/report`);
    const parsed = ReportSchema.safeParse(json);
    if (!parsed.success) throw new CliError('report response did not match the protocol schema', 1);
    return parsed.data;
  }

  /**
   * The P3.2 request lane (ADR 077) — `GET /teams/:slug/requests`, admin-only. `pendingOnly` maps to
   * `?status=pending`. Parsed through `RequestsResponseSchema` (ADR 074).
   */
  async requests(slug: string, opts: { pendingOnly?: boolean } = {}): Promise<RequestsResponse> {
    const qs = opts.pendingOnly ? '?status=pending' : '';
    const json = await this.request('GET', `/teams/${slug}/requests${qs}`);
    const parsed = RequestsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('requests response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /**
   * Decide a pending request (ADR 077) — `POST /teams/:slug/requests/:id/decide`, admin-only. An
   * approve issues a grant of the given lifetime and, if the requesting session is still live (a WS
   * claim hold), pushes it the terminal `occupied` frame directly — `delivered` tells the caller
   * whether that happened or the requester will need to re-claim.
   */
  async decideRequest(slug: string, id: string, body: DecideRequest): Promise<DecideResponse> {
    const json = await this.request(
      'POST',
      `/teams/${slug}/requests/${encodeURIComponent(id)}/decide`,
      body,
    );
    const parsed = DecideResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('decide response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /**
   * Enroll a seat into harness residency (ADR 131) — `POST /teams/:slug/residency/enroll`,
   * admin-authorized. The response carries the standing resume grant token **once**; the caller
   * (`musterd residency on`) writes it into the seat's `binding.grant`.
   */
  async enrollResidency(slug: string, body: EnrollResidencyBody): Promise<EnrollResidencyResponse> {
    const json = await this.request('POST', `/teams/${slug}/residency/enroll`, body);
    const parsed = EnrollResidencyResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('residency enroll response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /** The residency kill switch (ADR 131) — `POST /teams/:slug/residency/revoke` (seat or admin). */
  async revokeResidency(slug: string, seat: string): Promise<{ ok: boolean }> {
    return (await this.request('POST', `/teams/${slug}/residency/revoke`, { seat })) as {
      ok: boolean;
    };
  }

  /**
   * The host's lease poll (ADR 131 §4) — `POST /teams/:slug/residency/wake-leases`, agent-key
   * auth. One transaction server-side: derive due wakes, insert leases, return orders. The orders
   * carry structured fields only (never message bodies) — parsed here so a drifted daemon can't
   * hand the actuator an unvetted shape.
   */
  async wakeLeases(slug: string, host: string): Promise<WakeLeasesResponse> {
    const json = await this.request('POST', `/teams/${slug}/residency/wake-leases`, { host });
    const parsed = WakeLeasesResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('wake-leases response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /** The host's outcome report (ADR 131 §6) — `POST /teams/:slug/residency/wake-report`. Settles
   *  the lease and writes the `residency.woke`/`wake_failed` row the rate policy derives from. */
  async wakeReport(
    slug: string,
    body: WakeReportBody,
  ): Promise<{ ok: boolean; lease_id: string; status: string }> {
    return (await this.request('POST', `/teams/${slug}/residency/wake-report`, body)) as {
      ok: boolean;
      lease_id: string;
      status: string;
    };
  }

  /**
   * The resumable attestation push (ADR 131 §5, increment 4) — `POST /teams/:slug/residency/session`,
   * agent-key auth. Harness CLASS + event only; a session id or transcript path structurally cannot
   * cross (the body schema has no field for them). Callers use `.presenceNeutral()` — capture must
   * never flip the roster (ADR 057) and never claims (ADR 108).
   */
  async attestSession(
    slug: string,
    body: SessionAttestationBody,
  ): Promise<SessionAttestationResponse> {
    const json = await this.request('POST', `/teams/${slug}/residency/session`, body);
    const parsed = SessionAttestationResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('session attestation response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /** The team's residency enrollments (ADR 131) — `GET /teams/:slug/residency`. */
  async residency(slug: string): Promise<ResidencyListResponse> {
    const json = await this.request('GET', `/teams/${slug}/residency`);
    const parsed = ResidencyListResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError('residency response did not match the protocol schema', 1);
    }
    return parsed.data;
  }

  /** The team governance policy (SPEC A.6) — `GET /teams/:slug/policy`, admin. The read half of
   *  `musterd residency policy`: read → merge → set, so one knob changes without re-stating the rest. */
  async getPolicy(slug: string): Promise<{ policy: Policy }> {
    return (await this.request('GET', `/teams/${slug}/policy`)) as { policy: Policy };
  }

  /** Set the team governance policy — `POST /teams/:slug/policy`, admin, audited `policy.change`. */
  async setPolicy(slug: string, policy: Policy): Promise<{ policy: Policy }> {
    return (await this.request('POST', `/teams/${slug}/policy`, policy)) as { policy: Policy };
  }

  /**
   * The v0.3 stateless claim mirror (SPEC A.7, ADR 075/077) — `POST /teams/:slug/claim`. One-shot path
   * for a harness that can't hold a WS: authenticate with the team agent key (in the body, not a
   * Bearer token) + ask to occupy a seat. Response bodies ARE the WS frame shapes, so `parseClaimResponse`
   * handles HTTP + WS with one code path: 200 → occupied, 202 → pending (request opened, admins
   * decide), 4xx → refused (the body is a RefusedFrame, NOT an ErrorBody — so this does NOT use the
   * shared `request()` which throws on 4xx). 5xx/network → CliError. Additive + unwired: the live
   * `claim`/`join` token path is untouched until the P3 atomic cutover.
   */
  async claim(
    slug: string,
    input: { key: string; target: ClaimTarget; grant?: string; surface: Surface },
  ): Promise<ClaimOutcome> {
    // Validate the frame shape against the protocol schema (ADR 078); send the HTTP body Cleo's
    // endpoint expects ({ key, target, grant?, surface } — no WS type/v).
    // Model attestation (ADR 101): resolved from the env; absent reads as `unknown`.
    const model = resolveAttestedModel(process.env);
    const frame = buildClaimFrame({
      team: slug,
      key: input.key,
      target: input.target,
      surface: input.surface,
      ...(input.grant !== undefined ? { grant: input.grant } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(cliBuild() !== undefined ? { build: cliBuild()! } : {}),
    });
    const body = {
      key: frame.key,
      target: frame.target,
      ...(frame.grant !== undefined ? { grant: frame.grant } : {}),
      surface: frame.surface,
      ...(frame.model !== undefined ? { model: frame.model } : {}),
      ...(frame.build !== undefined ? { build: frame.build } : {}),
      ...(frame.epoch !== undefined ? { epoch: frame.epoch } : {}),
    };
    let res: Response;
    try {
      res = await fetch(this.opts.server + `/teams/${slug}/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.surface ? { 'x-musterd-surface': this.opts.surface } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (isConnRefused(err)) {
        throw new CliError(
          `can't reach team server at ${this.opts.server} — is the daemon running? (musterd serve)`,
          7,
        );
      }
      throw err;
    }
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (res.status === 200 || res.status === 202 || (res.status >= 400 && res.status < 500)) {
      try {
        return parseClaimResponse(json);
      } catch {
        // A 4xx that isn't a refused frame (e.g. a plain ErrorBody) falls back to the standard map.
        const errBody = ErrorBodySchema.safeParse(json);
        if (errBody.success) {
          throw new CliError(errBody.data.error.message, exitForCode(errBody.data.error.code));
        }
        throw new CliError(`claim failed (${res.status})`, 1);
      }
    }
    throw new CliError(`server error (${res.status})`, 1);
  }
}

export interface WatchOpts {
  wsUrl: string;
  team: string;
  as: string;
  token: string;
  surface: string;
  /** Attach-time context (ADR 014): why this watch session exists + its workspace label. */
  provenance?: string;
  workspace?: string;
  /** `team` (default) = my inbox stream; `team-all` = the whole-team firehose (ADR 061). */
  scope?: 'team' | 'team-all';
  onDeliver: (env: Envelope) => void;
  onPresence?: (member: string, status: string, surface?: string) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** Open a live WS presence session and stream deliveries (used by `inbox --watch`). */
export function watch(opts: WatchOpts): { close: () => void } {
  const ws = new WebSocket(opts.wsUrl);
  let heartbeat: NodeJS.Timeout | undefined;

  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        team: opts.team,
        as: opts.as,
        token: opts.token,
        surface: opts.surface,
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
      }),
    );
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as WSServerFrame;
    switch (frame.type) {
      case 'welcome':
        ws.send(JSON.stringify({ type: 'subscribe', scope: opts.scope ?? 'team' }));
        heartbeat = setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat' })), 15_000);
        heartbeat.unref?.();
        opts.onReady?.();
        break;
      case 'deliver':
        opts.onDeliver(frame.envelope);
        break;
      case 'presence':
        opts.onPresence?.(frame.member, frame.status, frame.surface);
        break;
      case 'error':
        opts.onError?.(frame.message);
        break;
    }
  });
  ws.on('error', (err) => opts.onError?.(err.message));

  return {
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      ws.close();
    },
  };
}

/** Minimal socket surface `watchClaim` drives — the `ws` WebSocket shape it uses. Injectable for tests. */
export interface ClaimSocket {
  on(event: 'open' | 'message' | 'error', cb: (arg?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface WatchClaimOpts {
  wsUrl: string;
  team: string;
  /** Agent join key (mskey_) — the P3 authenticator, replaces `watch`'s `token`. */
  key: string;
  /** The seat/role/observe target (SPEC A.3). */
  target: ClaimTarget;
  /** Pre-issued grant (msgr_); omit to open a claim request (A.5, the pending path). */
  grant?: string;
  surface: string;
  /** Attach-time context (ADR 014), sticky for the session — same as `watch`. */
  provenance?: string;
  workspace?: string;
  /** Harness-attested model id (ADR 101). Defaults to the env resolution (`MUSTERD_MODEL` /
   *  `ANTHROPIC_MODEL`); absent reads as `unknown` server-side, never blocks. */
  model?: string;
  /** `team` (default) = my inbox stream; `team-all` = the whole-team firehose (ADR 061). */
  scope?: 'team' | 'team-all';
  onDeliver: (env: Envelope) => void;
  onPresence?: (member: string, status: string, surface?: string) => void;
  /** Claim succeeded — the session holds the seat (replaces `watch`'s `onReady`). `seat` is the
   *  occupied Member; `presenceId` the live presence id; `grant` is the ADR 087 resume token delivered
   *  on first approval (persist into `binding.grant`). Fires on the initial `occupied` AND on the
   *  server-pushed `occupied` that resolves a `pending` (spec-gap 3). */
  onOccupied?: (
    seat: Member,
    presenceId: string,
    grant?: string,
    memory?: MemoryEnvelope | null,
  ) => void;
  /** No grant — the server opened a claim request (A.5); the socket stays open for the pushed terminal. */
  onPending?: (requestId: string, message: string) => void;
  /** Claim denied — terminal. `claimable` + `hint` carry the no-dead-end next step (ADR 055). */
  onRefused?: (code: RefusedCode, message: string, claimable: string[], hint: string) => void;
  onError?: (message: string) => void;
  /** Injectable socket factory; defaults to a real `ws` WebSocket. */
  createSocket?: (url: string) => ClaimSocket;
}

/**
 * The v0.3 live claim session (SPEC A.3, ADR 075/078) — the P3 successor to `watch()`. Opens a WS,
 * sends a `claim` frame (not `hello`), and drives the handshake state machine: `occupied` →
 * subscribe + heartbeat (the live inbox stream, mirroring `watch`'s `welcome` path); `refused` →
 * terminal denial; `pending` → the socket stays open and the server **pushes** the terminal
 * `occupied`/`refused` when an admin decides (spec-gap 3, no client polling). Flip-territory: this
 * is the live auth path; `claim`/`join` wire to it (replacing the hello/token `watch`) in the atomic
 * cutover. Design call for review: post-`occupied` the client sends `subscribe` (mirroring `watch`) —
 * if Cleo's claim handler auto-subscribes on `occupied`, this is a harmless redundancy.
 */
export function watchClaim(opts: WatchClaimOpts): { close: () => void } {
  const ws = (opts.createSocket ?? defaultClaimSocket)(opts.wsUrl);
  // Model attestation (ADR 101): explicit opt wins, else the shared env resolution — resolved once
  // so a reconnecting frame attests the same value.
  const attestedModel = opts.model ?? resolveAttestedModel(process.env);
  let heartbeat: NodeJS.Timeout | undefined;
  let subscribed = false;

  const subscribe = () => {
    if (subscribed) return;
    ws.send(JSON.stringify({ type: 'subscribe', scope: opts.scope ?? 'team' }));
    subscribed = true;
    heartbeat = setInterval(
      () =>
        ws.send(
          JSON.stringify({
            type: 'heartbeat',
            // Re-affirm the attested model each heartbeat (ADR 101); the server no-ops when unchanged.
            ...(attestedModel !== undefined ? { model: attestedModel } : {}),
          }),
        ),
      15_000,
    );
    heartbeat.unref?.();
  };

  ws.on('open', () => {
    ws.send(
      JSON.stringify(
        buildClaimFrame({
          team: opts.team,
          key: opts.key,
          target: opts.target,
          surface: opts.surface as Surface,
          ...(opts.grant !== undefined ? { grant: opts.grant } : {}),
          ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
          // Model attestation (ADR 101): explicit opt wins, else the shared env resolution.
          ...(attestedModel !== undefined ? { model: attestedModel } : {}),
          // Build attestation (ADR 135): this CLI dist's own stamp.
          ...(cliBuild() !== undefined ? { build: cliBuild()! } : {}),
        }),
      ),
    );
  });

  ws.on('message', (data) => {
    const raw = JSON.parse((data as { toString: () => string }).toString()) as { type?: string };
    if (raw.type === 'occupied' || raw.type === 'refused' || raw.type === 'pending') {
      const o = parseClaimResponse(raw);
      if (o.state === 'occupied') {
        opts.onOccupied?.(o.seat, o.presenceId, o.grant, o.memory);
        subscribe();
      } else if (o.state === 'refused') {
        opts.onRefused?.(o.code, o.message, o.claimable, o.hint);
      } else {
        opts.onPending?.(o.requestId, o.message);
      }
      return;
    }
    const frame = raw as WSServerFrame;
    switch (frame.type) {
      case 'deliver':
        opts.onDeliver(frame.envelope);
        break;
      case 'presence':
        opts.onPresence?.(frame.member, frame.status, frame.surface);
        break;
      case 'error':
        opts.onError?.(frame.message);
        break;
    }
  });

  ws.on('error', (err) => opts.onError?.((err as Error)?.message ?? String(err)));

  return {
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      ws.close();
    },
  };
}

function defaultClaimSocket(url: string): ClaimSocket {
  return new WebSocket(url) as unknown as ClaimSocket;
}
