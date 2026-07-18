import { type GateCheckRequest, type GateDecision } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { appendAudit } from '../store/audit.js';
import { laneCoveringPath } from '../store/lanes.js';
import type { MemberRow, TeamRow } from '../store/rows.js';

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

/** Gate B — policy-classed action→ask (costly action). Foundation ships the warn path; the block path
 *  (dedup on fingerprint → emit species:approve/tier:blocking ask → re-check for a human accept on
 *  re-attempt) lands in stanley's Gate B lane. Fails open until then. */
export function gateB(ctx: GateContext): GateDecision {
  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${ctx.req.class}' is a declared costly action — raise an ask (species:approve) before it when it's irreversible`,
    };
  }
  // block: Gate B decision not yet implemented — fail open, never strand a seat on an unfinished gate.
  return {
    decision: 'allow',
    outcome: 'allowed',
    reason: `gate B (action→ask) block path not yet implemented for '${ctx.req.class}' — allowing`,
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
