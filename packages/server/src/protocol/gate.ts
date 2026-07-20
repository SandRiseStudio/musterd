import {
  type AskSpecies,
  ASK_TOP_TIER,
  askContractText,
  type GateCheckRequest,
  type GateDecision,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { appendAudit } from '../store/audit.js';
import { findGateAsk, gateAskHumanAnswer } from '../store/gateAsk.js';
import { laneCoveringPath } from '../store/lanes.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { routeEnvelope } from './route.js';

/**
 * PreToolUse gate adjudication (ADR 150 — structural inducement). The daemon side of the two enforcement
 * gates: the hook has already matched the tool call against a declared class CLIENT-side and POSTed the
 * shapes here (`GateCheckRequest`); this module makes the decision **atomically server-side** and records
 * one shapes-only audit row. Dispatch is by `req.kind`: `contended-surface` → Gate A (lane-ownership),
 * `costly-action` → Gate B (action→ask).
 *
 * **The warn path is the same for both gates and lives here in the foundation** — warn posture (the
 * ADR 083 default) always proceeds, records `outcome: 'warned'`, and surfaces an advisory. Only the
 * `block`-posture decision is gate-specific, so that is what `gateA`/`gateB` own. Until a gate's block
 * path is implemented it **fails open** (allows): an unfinished gate must never wedge an agent — the
 * ADR's guard metric is "enforcement must not raise interventions-to-done by stranding a seat on a gate
 * it cannot satisfy." The block logic lands in the Gate A (izzo) and Gate B (stanley) lanes on top.
 */

export interface GateContext {
  /** The full server bundle (db, hub, config). Gate A needs only `srv.db` (a lane-board read); Gate B's
   *  deny-is-emit raises its ask through `routeEnvelope`, which needs `srv.hub`/`srv.config` for the
   *  ADR 147/149 admin-push + Slack surfaces — hence the whole `Ctx`, not a bare `db`. */
  srv: Ctx;
  team: TeamRow;
  /** The acting seat — the request is member-authed AS this seat, so a Gate B ask emitted here is
   *  raised "through the seat's own credential" (ADR 150). */
  member: MemberRow;
  req: GateCheckRequest;
}

/**
 * Gate A — lane-ownership (ADR 150). An edit to a declared **contended surface** requires the acting
 * seat to own a claimed lane whose `surface_globs` cover the target path. The check is one lane-board
 * read: does this seat hold a contending lane covering `req.target`?
 *   - **Owns it** → allow, quietly (`allowed`, no nag) — under either posture. Ownership IS the point;
 *     a seat that claimed its lane should never be warned or blocked.
 *   - **Doesn't own it, `warn`** → allow with the advisory (`warned`) — ADR 083 default preserved.
 *   - **Doesn't own it, `block`** → deny with a repair string that names the reality: another seat's
 *     lane already covers it ("owned by X — coordinate / take a different surface"), or nothing does
 *     ("claim one first"). Claiming becomes the only path to the edit — the forcing function.
 * `req.target` arrives repo-relative (the hook normalizes it) so it compares against lane globs, which
 * are repo-relative by convention.
 */
export function gateA(ctx: GateContext): GateDecision {
  const { db } = ctx.srv;
  const { id: teamId, slug } = ctx.team;
  const path = ctx.req.target;
  const cls = ctx.req.class;

  const owned = laneCoveringPath(db, teamId, slug, path, { owner: ctx.member.name });
  if (owned) {
    return {
      decision: 'allow',
      outcome: 'allowed',
      reason: `owned: '${cls}' is covered by your lane "${owned.title}"`,
    };
  }

  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${cls}' is a declared contended surface and you have no claimed lane covering it — open one so the team can see this edit (lane_open "<what>" --surface ${path} --claim)`,
    };
  }

  // block: the forcing function. Name whether someone else holds it, or it's simply unclaimed.
  const otherLane = laneCoveringPath(db, teamId, slug, path);
  const detail = otherLane
    ? `it is owned by ${otherLane.owner_seat ?? 'another seat'} (lane "${otherLane.title}") — coordinate with them, take a different surface, or hand off`
    : `no lane covers it — claim one first: lane_open "<what>" --surface ${path} --claim`;
  return {
    decision: 'deny',
    outcome: 'denied',
    reason: `blocked: '${cls}' is a declared contended surface you have not claimed a lane for. ${detail}`,
  };
}

/**
 * The denial's repair string — the agent's marching orders at the point of block. Parity with the ADR 147
 * ask contract an ask-raiser would get (the shared `askContractText`, so gate-blocked and self-raised
 * agents read the same thing), plus the two things the deny alone must add: **what the block is for**
 * (a human will review this consequential action) and **that routing around defeats it** — the finding-006
 * datum that agents met a blocked push by landing the change via a local merge, pricing the hold at zero.
 */
function blockingContractReason(cls: string, askId: string): string {
  return (
    `blocked pending human approval — '${cls}' is a declared costly action your team gated for human ` +
    `review; ask ${askId} raised (species:approve). ${askContractText(askId, ASK_TOP_TIER)} ` +
    `Re-try the action to re-check. Landing this another way — a local merge, a different command, an ` +
    `alternate path — bypasses the very review this block exists for; hold or hand the work off instead.`
  );
}

/** Raise the gate-ask through the acting seat's own credential (member-authed `routeEnvelope`): a
 *  top-tier `approve` ask carrying `meta.gate = { class, fingerprint }` so re-attempts converge (dedup
 *  reads it back) and a gate-emitted ask is distinguishable from an agent-authored one. Returns the ask
 *  id. Reuses the one validate→persist→deliver path, so admin push (ADR 147), Slack (ADR 149), and the
 *  `ask.raised` lifecycle row all fall out for free — the deny IS the emission. */
function emitGateAsk(ctx: GateContext): string {
  const { srv, team, member, req } = ctx;
  const id = ulid();
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: member.name,
    to: { kind: 'team' },
    act: 'ask',
    body: `Approval needed for costly action '${req.class}': ${req.target}`,
    meta: {
      species: 'approve' satisfies AskSpecies,
      tier: ASK_TOP_TIER,
      gate: { class: req.class, fingerprint: req.fingerprint },
    },
  });
  routeEnvelope(srv, team, member, env);
  return id;
}

/**
 * Gate B — policy-classed action→ask (ADR 150). The block path is **deny IS emit**: a denied costly
 * action routes itself through the ADR 147 ask stream, so the ask exists whether or not the agent would
 * have raised one. The gate keeps ADR 147's clock discipline — no daemon timer, no hook timer; each
 * re-attempt of the action re-runs this decision:
 *   - **warn** → allow with an advisory (`warned`), no ask — an approval nobody requested is noise.
 *   - **block, first attempt for this fingerprint** → emit the ask, deny (`denied_ask_raised`).
 *   - **block, re-attempt, human accepted** → allow (`released`), standing per-fingerprint.
 *   - **block, re-attempt, human declined** → deny (`denied_declined`) — do not re-raise.
 *   - **block, re-attempt, still unanswered** → deny (`denied_awaiting`), contract restated, no 2nd ask.
 * Release requires a **human** accept (ADR 150 defers admin-only release to `multi-human-admin`).
 */
export function gateB(ctx: GateContext): GateDecision {
  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${ctx.req.class}' is a declared costly action — raise an ask (species:approve) before it when it's irreversible`,
    };
  }

  const { db } = ctx.srv;
  const existing = findGateAsk(db, ctx.team.id, ctx.req.fingerprint);
  if (existing) {
    // Re-attempt of an already-raised action: re-check the ask thread rather than raise a second ask.
    const answer = gateAskHumanAnswer(db, ctx.team.id, existing.id);
    if (answer?.act === 'accept') {
      return {
        decision: 'allow',
        outcome: 'released',
        reason: `'${ctx.req.class}' approved by ${answer.by} — proceeding (ask ${existing.id})`,
        ask_ref: existing.id,
      };
    }
    if (answer?.act === 'decline') {
      return {
        decision: 'deny',
        outcome: 'denied_declined',
        reason: `'${ctx.req.class}' declined by ${answer.by} — do not re-raise; take a different approach or hand off (ask ${existing.id})`,
        ask_ref: existing.id,
      };
    }
    // Still open, unanswered — restate the contract, do NOT emit another ask.
    return {
      decision: 'deny',
      outcome: 'denied_awaiting',
      reason: blockingContractReason(ctx.req.class, existing.id),
      ask_ref: existing.id,
    };
  }

  // First attempt for this fingerprint — emit the ask, then deny with the blocking contract.
  const askId = emitGateAsk(ctx);
  return {
    decision: 'deny',
    outcome: 'denied_ask_raised',
    reason: blockingContractReason(ctx.req.class, askId),
    ask_ref: askId,
  };
}

/**
 * Adjudicate a matched tool call and record the decision. Writes exactly one `lane.gate` / `action.gate`
 * audit row — **shapes only**: `target` is the legible class name (never the raw path/command), `detail`
 * carries class + fingerprint + posture + tool + outcome. The raw `req.target` is used solely to make the
 * decision (and, for a future Gate B, to fill an ask body) and is never persisted to audit.
 */
export function adjudicateGate(
  srv: Ctx,
  team: TeamRow,
  member: MemberRow,
  req: GateCheckRequest,
): GateDecision {
  const ctx: GateContext = { srv, team, member, req };
  const decision = req.kind === 'contended-surface' ? gateA(ctx) : gateB(ctx);
  const action = req.kind === 'contended-surface' ? 'lane.gate' : 'action.gate';
  appendAudit(srv.db, team.id, {
    actor: member.name,
    action,
    target: req.class,
    result: decision.decision === 'allow' ? 'allow' : 'deny',
    detail: {
      class: req.class,
      fingerprint: req.fingerprint,
      posture: req.posture,
      tool: req.tool,
      outcome: decision.outcome,
      ...(decision.ask_ref ? { ask_ref: decision.ask_ref } : {}),
    },
  });
  return decision;
}
