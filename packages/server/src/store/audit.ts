import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { log } from '../log.js';

/**
 * The v0.3 governance audit log (ADR 071, P2 of ADR 069). Append-only: every governed decision writes one
 * row — the coordination-governance trace no single-agent observability tool can produce, and a direct
 * feed for the batond flywheel (ADR 051). There is intentionally no update/delete API.
 */

/** A dotted governance verb. P2 emits the first five; P3 adds grant/claim/account-status/key/policy/request. */
export type AuditAction =
  | 'urgent.flagged'
  | 'urgent.denied'
  | 'send.denied'
  | 'member.reclaim'
  | 'member.remove'
  | 'observe.denied'
  // P3.1 (ADR 076): admin governance ops.
  | 'grant.issue'
  | 'grant.revoke'
  | 'key.rotate'
  | 'policy.change'
  | 'account_status.change'
  // P3.2 (ADR 077): claim handshake + request lane.
  | 'claim.occupied'
  | 'claim.refused'
  | 'claim.pending'
  // ADR 146 (dogfood-approval-grant, on ADR 145 §7): an agent harness re-occupied an already-bound
  // named seat under the `standing_reseat_known_agents` policy — the routine re-seat that used to open
  // a `claim.pending` request and wait on an admin. `result: allow`, actor/target = the seat name,
  // `detail` carries `{ surface, policy: 'standing_reseat_known_agents' }`. This row IS the
  // notification-not-a-decision record: the durable audit that a known teammate re-took its own seat
  // without an approval round-trip (the loud admin surface for it rides the ask-stream, ADR 145 §3).
  | 'claim.reseated'
  // ADR 092: a same-workspace successor found a live predecessor (drift signal), then reaped it once
  // it proved durable (the orphaned-adapter reap; `detail.same_workspace` distinguishes it from the
  // cross-workspace newest-wins path, which does not audit).
  | 'claim.duplicate_workspace'
  | 'claim.superseded'
  | 'request.decide'
  | 'request.expired'
  // ADR 088: an interrupt-class act was surfaced to a busy agent at a tool boundary (delivery, not
  // send — `urgent.flagged` audits the send). One row per (recipient, act): who grabbed the mic, when,
  // at whom. The raised→read pair (this row, then the recipient's inbox read of `detail.act`) is the
  // delivery-confirmation signal.
  | 'interrupt.raised'
  // ADR 093: a seat wrote or cleared its private memory blob. `detail` carries sizes only
  // (`size_bytes`, `headline_len`) — never the headline or body text (the no-secrets hard rule 5).
  | 'memory.save'
  | 'memory.clear'
  // ADR 101: a harness attested (or re-attested) the model on an occupancy. `detail` carries
  // `{ occupancy, old, new, source: 'claim'|'heartbeat'|'ambient' }` — this append-only trail IS the
  // occupancy's model-switch history (the ADR keeps no history column). `ambient` is ADR 119: a
  // CLI/HTTP one-shot carrying `x-musterd-model` after the claim presence expired.
  | 'occupancy.model_attested'
  // ADR 109: a lane carrying a branch reached a terminal state — the seat attests the landed merge.
  // actor = the resolving seat, target = the branch, `detail` carries the attested (never verified)
  // `{ pr, sha, authorized_by }` — the join table between seats, main SHAs, and authorizing humans.
  // ADR 169: `attested_by` credits the worker when a counterpart performs the closing act on a
  // stage-one (ready_for_review-captured) attestation.
  | 'git.pr_merged'
  // ADR 169: the two-stage close instrument. `lane.ready_for_review` is the worker's "technically
  // complete" claim (detail: { lane, owner, merged? }). `lane.closed` is EVERY terminal edge —
  // verified-ness is DERIVED here and only here (detail: { lane, state, closed_by, owner_at_close,
  // verified, reason: counterpart_confirm|review_timeout|self_close|abandoned, worker_family,
  // reviewer_family?, time_in_review_ms? }); owner_at_close is pinned so a post-close handoff can
  // never flip a verdict. `lane.review_sent_back` is the review catch — a counterpart returned a
  // ready_for_review lane to a live state (detail: { lane, reviewer, owner }).
  | 'lane.ready_for_review'
  | 'lane.closed'
  | 'lane.review_sent_back'
  // ADR 131: harness residency — the six wake-ledger verbs. `enrolled`/`revoked` are the
  // authorization events (actor = the deciding caller, detail carries `authorized_by`, ADR 127).
  // `wake_leased` is the daemon ordering an actuation (actor null — machine decision); `woke` /
  // `wake_failed` record the host's reported outcome with detail
  // `{ act, sender, grant_id, lease_id, session: 'fresh'|'resumed' }` — these rows ARE the rate
  // policy (cooldown / hourly cap / per-act attempt cap are derived from them, never stored).
  // `wake_exhausted` is the terminal per-act row: attempt cap hit, stop waking for this act.
  | 'residency.enrolled'
  | 'residency.revoked'
  | 'residency.wake_leased'
  | 'residency.woke'
  | 'residency.wake_failed'
  | 'residency.wake_exhausted'
  // ADR 131 increment 4: `wake_deferred` — the host skipped an actuation because a live local
  // session already held the workspace (the local-session guard; roster-offline ≠ workspace-idle).
  // Deliberately OUTSIDE the rate/attempt derivations (those count woke+wake_failed only): a
  // deferral burns no budget, it only snoozes lease derivation for `WAKE_DEFER_SNOOZE_MS`.
  // `session_captured`/`session_ended` record the resumable attestation pushes from the
  // SessionStart/SessionEnd hooks — detail carries `{ harness, enrolled }`, harness CLASS only:
  // a session id or transcript path never reaches the daemon.
  | 'residency.wake_deferred'
  | 'residency.session_captured'
  | 'residency.session_ended'
  // ADR 131 increment 5: the SUPPLEMENTARY cost record. The primary wake report lands at roster
  // verification (~seconds, inside the lease TTL); harness-attested cost only exists when the run
  // exits, often minutes later — so the host posts a second report for the already-settled lease
  // and it lands here, detail `{ act, lease_id, cost_usd?, duration_ms? }`. Deliberately OUTSIDE
  // the rate/attempt derivations (one actuation must not count twice); the wake metrics dedupe
  // cost by lease_id, preferring this row over the primary's.
  | 'residency.wake_cost'
  // ADR 144 increment 1: a seat's adapter attested what its rendered MCP tool surface weighs —
  // once per session, on the first telemetry flush. detail carries `{ tools, bytes, est_tokens,
  // breakdown? }` (byte counts and tool names only, never content). Append-only like the model/
  // build attestations: the row history IS the before/after for the surface-redesign increments.
  | 'mcp.surface_rendered'
  // ADR 147 (human-ask-stream, on ADR 145 §3.1): the four lifecycle rows of a to-human `ask`. These
  // shapes only (species/tier/ask_ref/until and the risk/approach the *agent* authored), never bodies
  // (ADR 051). `raised` = an ask was sent (detail `{ species, tier }`); `deferred` = a human replied
  // "deciding — check back in ⟨until⟩" via `wait` (detail `{ ask_ref, until }`); `held` = a top-tier ask
  // timed out unanswered and the agent is holding, not proceeding (detail `{ ask_ref }`); `risk_accepted`
  // = a below-top ask timed out and the agent proceeded, recording what it risked (detail
  // `{ ask_ref, risk, chosen_approach, human_unreachable: true }`). The raised→terminal pair is the whole
  // stream's trace; `risk_accepted` is the auditable risk-acceptance ADR 145 §3.1 promised.
  | 'ask.raised'
  | 'ask.deferred'
  | 'ask.held'
  | 'ask.risk_accepted'
  // ADR 153 (reachability-gated hold): the top tier's second NON-proceed terminal. A `blocking` ask
  // timed out unanswered AND no unblocker was reachable (no admin human present/notifiable, no live
  // teammate with an open sanctioned route-around), so the agent stranded — recorded WIP on its lane,
  // released it, closed the unit — instead of pinning itself on a hold that cannot pay off. Detail
  // `{ ask_ref, reason: 'no_reachable_unblocker' }`. Guard metric: no `ask.stranded` is EVER followed
  // by the blocked action executing — a strand that proceeds is the same wedge breach as a held that
  // proceeds.
  | 'ask.stranded'
  // ADR 149 (ask-surfaces): the loud reach's attempt + outcome — one row per Slack webhook POST the
  // daemon fired for a raised ask, detail `{ surface: 'slack', ok, status? }`. Never the URL (a
  // secret) and never the body (delivery carries bodies; audit never does, ADR 051). Zero rows on a
  // team that never set `ask_slack_webhook` is itself the guard metric that the default is off.
  | 'ask.surfaced'
  // ADR 150 (structural inducement — PreToolUse enforcement gates): one decision row per intercepted
  // tool call that matched a declared enforcement class. `lane.gate` = Gate A (lane-ownership on a
  // contended surface); `action.gate` = Gate B (policy-classed action→ask). Both are SHAPES ONLY —
  // detail carries `{ class, fingerprint, posture, outcome, ...}` (the legible class name the team
  // declared + the sha256 fingerprint), NEVER the target path or command text (ADR 051; the raw text
  // reaches the daemon only to make the decision + fill an ask body, and dies there). `result` is
  // `allow` when the call proceeds (warn posture, or an owned lane, or a released ask), `deny` when it
  // was blocked. The Gate B ask lifecycle rides the existing `ask.*` rows unchanged — the deny-emit-hold
  // is a hook behavior, not a new act. "Which costly actions proceeded un-asked" is one query:
  // `action.gate` rows with `detail.outcome = 'warned'` beside the `ask.*` the block posture provoked.
  | 'lane.gate'
  | 'action.gate'
  // ADR 163 (actor attestation): who did it, never whether it was allowed. These rows are NOT gate
  // decisions — they carry no posture and no outcome, because nothing about them can change whether a
  // call proceeds. That is exactly why they may fire on UNDECLARED calls where `lane.gate`/`action.gate`
  // may not (ADR 150 §Gate B as amended by 163: the boundary governs mediation, not observation).
  // `actor.subagent_write` = a write-shaped tool call carrying an `agent_id`, i.e. a subagent wrote
  // under its parent seat's identity; detail `{ actor_id, actor_type, tool, target }`. Reads never fire.
  // `actor.subagent_spawn` = a subagent was spawned at all; detail `{ spawn_type, spawn_model? }` —
  // the DENOMINATOR the write count is read against. `result` is always `allow`: an observer never
  // denies. NOTE the write count is a LOWER BOUND — Bash write-shape is a heuristic command match, so
  // a subagent writing via `python -c` or an MCP filesystem tool produces no row (ADR 163 recall arm).
  | 'actor.subagent_write'
  | 'actor.subagent_spawn'
  // ADR 167 (harness-native session messaging): a seat called the harness's own session-to-session
  // send (`ccd_session_mgmt.send_message`) — the identityless side channel, now ledger-visible. Same
  // observer family as the two ADR 163 rows above: no posture, no outcome, `result` always `allow`.
  // Detail is SHAPES ONLY, reduced client-side: `{ tool, body_fingerprint?, session_ref?, nudge_ref?,
  // nudge?, verbatim? }` — the body and the raw target session id never reach the daemon at all (ADR
  // 051/128, and the SessionCapture never-crosses-the-wire contract). `nudge_ref` is a ULID the body
  // carried; when it resolves to a real message the row is a sanctioned delivery-rail relay
  // (`nudge: true`, with `verbatim` saying whether the composed line was relayed unmodified — ADR 167
  // increment 2); rows without it are the organic/side-channel population increment 1 exists to count.
  | 'actor.session_message'
  // The inverse of team create: an admin soft-archived the whole team (`POST /teams/:slug/archive`).
  // target = the slug. The row lands in the archived team's own log — readable again only at the db
  // (requireTeam refuses archived teams), but the history survives, which is the point of soft.
  | 'team.archive';

export interface AuditEntry {
  /** Seat name that initiated the op; null for system/reaper writes. */
  actor: string | null;
  action: AuditAction;
  /** Affected seat/resource name; null when not seat-scoped. */
  target: string | null;
  /** The authorization outcome. An executed governance op is `allow`. */
  result: 'allow' | 'deny';
  /** JSON-serializable context (`{ reason }`, `{ fallback: 'no-admin' }`, …); never secrets. */
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  team_id: string;
  ts: number;
  actor: string | null;
  action: string;
  target: string | null;
  result: 'allow' | 'deny';
  detail: string | null;
  created_at: number;
}

/**
 * Append an audit entry. **Best-effort observability, never a gate**: a failure here is logged and
 * swallowed so it can never break the request path it is recording.
 */
export function appendAudit(db: Database, teamId: string, entry: AuditEntry): void {
  try {
    const now = Date.now();
    const row: AuditRow = {
      id: ulid(),
      team_id: teamId,
      ts: now,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      result: entry.result,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (@id, @team_id, @ts, @actor, @action, @target, @result, @detail, @created_at)`,
    ).run(row);
  } catch (err) {
    log.warn({ msg: 'audit_append_failed', action: entry.action, err: String(err) });
  }
}

/**
 * Has an `interrupt.raised` row already been written for this (recipient, act)? The interrupt line is
 * re-probed at *every* tool boundary, so an urgent act sits raised across many checks until read —
 * this dedup keeps the governance log to one legible row per delivered act (ADR 088) instead of one
 * per tool call. DB-backed (not in-memory) so it survives a daemon restart. Best-effort: a read error
 * degrades to "not yet raised" (at worst one extra row), never a gate on the probe.
 */
export function hasInterruptRaised(
  db: Database,
  teamId: string,
  target: string,
  actId: string,
): boolean {
  try {
    const row = db
      .prepare<[string, string, string], { one: number }>(
        `SELECT 1 AS one FROM audit
          WHERE team_id = ? AND action = 'interrupt.raised' AND target = ?
            AND json_extract(detail, '$.act') = ? LIMIT 1`,
      )
      .get(teamId, target, actId);
    return row != null;
  } catch {
    return false;
  }
}

/** Read the audit log for a team, newest-first, capped. `before` pages older than a given ts.
 *  `authorized_by` keeps rows whose detail.authorized_by matches (ADR 127). */
export function listAudit(
  db: Database,
  teamId: string,
  opts: { limit?: number; before?: number; authorized_by?: string } = {},
): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const by = opts.authorized_by;
  if (by != null && by.length > 0) {
    if (opts.before != null) {
      return db
        .prepare<[string, number, string, number], AuditRow>(
          `SELECT * FROM audit WHERE team_id = ? AND ts < ?
             AND json_extract(detail, '$.authorized_by') = ?
           ORDER BY ts DESC, id DESC LIMIT ?`,
        )
        .all(teamId, opts.before, by, limit);
    }
    return db
      .prepare<[string, string, number], AuditRow>(
        `SELECT * FROM audit WHERE team_id = ?
           AND json_extract(detail, '$.authorized_by') = ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(teamId, by, limit);
  }
  if (opts.before != null) {
    return db
      .prepare<
        [string, number, number],
        AuditRow
      >('SELECT * FROM audit WHERE team_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(teamId, opts.before, limit);
  }
  return db
    .prepare<
      [string, number],
      AuditRow
    >('SELECT * FROM audit WHERE team_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(teamId, limit);
}
