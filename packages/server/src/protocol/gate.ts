import type { Database } from 'better-sqlite3';
import { type GateCheckRequest, type GateDecision } from '@musterd/protocol';
import { appendAudit } from '../store/audit.js';
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
  db: Database;
  team: TeamRow;
  /** The acting seat — the request is member-authed AS this seat, so a Gate B ask emitted here is
   *  raised "through the seat's own credential" (ADR 150). */
  member: MemberRow;
  req: GateCheckRequest;
}

/** Gate A — lane-ownership (contended surface). Foundation ships the warn path; the block path (does the
 *  seat own a claimed lane whose globs cover the target?) lands in izzo's Gate A lane. Fails open until then. */
export function gateA(ctx: GateContext): GateDecision {
  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${ctx.req.class}' is a declared contended surface — claim a lane covering it so the team can see this edit (lane_open … --claim)`,
    };
  }
  // block: Gate A decision not yet implemented — fail open, never strand a seat on an unfinished gate.
  return {
    decision: 'allow',
    outcome: 'allowed',
    reason: `gate A (lane-ownership) block path not yet implemented for '${ctx.req.class}' — allowing`,
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
  db: Database,
  team: TeamRow,
  member: MemberRow,
  req: GateCheckRequest,
): GateDecision {
  const ctx: GateContext = { db, team, member, req };
  const decision = req.kind === 'contended-surface' ? gateA(ctx) : gateB(ctx);
  const action = req.kind === 'contended-surface' ? 'lane.gate' : 'action.gate';
  appendAudit(db, team.id, {
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
