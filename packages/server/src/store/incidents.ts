import {
  IncidentPolicySchema,
  LANE_TERMINAL_STATES,
  type BlockedBy,
  type IncidentPolicy,
  type Lane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { appendAudit } from './audit.js';
import { getLane, listLanes, openLane, updateLane } from './lanes.js';
import { getMemberByRole } from './members.js';
import { getPolicy } from './teams.js';

/**
 * Incident convergence (spec 2026-08-14; increment 1 = ADR 266, increment 2 = ADR 270). A
 * `blocked_by` report on a `status_update` lands here: below the threshold it pools; at the
 * threshold the pool becomes ONE `kind:'incident'` lane (unowned, high stakes, no surface globs —
 * diagnosis localizes the surface later); past it, reports append to the open lane so resolve can
 * fan out to every parked ref. Increment 2 adds the claim window below: what happens when that lane
 * sits unowned.
 *
 * Clustering is on `gate` exact-match only — check-name granularity is what N seats can state
 * identically without coordinating (the motivating episode printed two element-level signatures for
 * one defect). `sig` is carried for the eventual owner and never matched on.
 */

/**
 * Increment 1's hardcoded threshold, kept as the schema default's twin so the constant and the
 * policy default cannot drift apart. Read the policy (`getPolicy(db, teamId).incident`), never this.
 */
export const CLUSTER_THRESHOLD = IncidentPolicySchema.parse({}).cluster_threshold;

export type IncidentOutcome =
  | { kind: 'disabled' } // the team opted out (policy incident.enabled = false)
  | { kind: 'recorded' } // pooled below threshold
  | { kind: 'opened'; lane: Lane } // this report tripped the threshold
  | { kind: 'appended'; lane: Lane }; // matched an already-open incident

/** The team's incident knobs, defaults applied on read (never on write — ADR 185). */
export function incidentPolicy(db: Database, teamId: string): IncidentPolicy {
  return getPolicy(db, teamId).incident;
}

/** The derived, deterministic lane title — also the open-incident lookup key. */
function incidentTitle(gate: string): string {
  return `incident: ${gate}`;
}

function detailLine(
  seat: string,
  r: { sig?: string | null | undefined; ref?: string | null | undefined },
): string {
  return `${seat}: ${r.sig ?? '(no sig)'}${r.ref ? ` [${r.ref}]` : ''}`;
}

/** Open (non-terminal) incident lanes for a team, oldest first. */
export function openIncidents(db: Database, teamId: string, teamSlug: string): Lane[] {
  return listLanes(db, teamId, teamSlug)
    .filter((l) => l.kind === 'incident' && !LANE_TERMINAL_STATES.has(l.state))
    .sort((a, b) => a.created_at - b.created_at);
}

function findOpenIncident(
  db: Database,
  teamId: string,
  teamSlug: string,
  gate: string,
): Lane | null {
  const title = incidentTitle(gate);
  return openIncidents(db, teamId, teamSlug).find((l) => l.title === title) ?? null;
}

/** Distinct seats that reported into an incident lane (for resolve fan-out and the route hook). */
export function incidentReporters(db: Database, teamId: string, laneId: string): string[] {
  return db
    .prepare<[string, string], { seat: string }>(
      'SELECT DISTINCT seat FROM incident_reports WHERE team_id = ? AND lane_id = ?',
    )
    .all(teamId, laneId)
    .map((r) => r.seat);
}

/** One incident handed to an owner because its claim window closed with nobody on it. */
export interface RoutedIncident {
  lane: Lane;
  owner: string;
}

/** Has this lane already been recorded as unroutable? (One row per lane, not one per tick.) */
function alreadyReportedUnfilled(db: Database, teamId: string, laneId: string): boolean {
  const row = db
    .prepare<
      [string, string],
      { n: number }
    >("SELECT COUNT(*) n FROM audit WHERE team_id = ? AND action = 'incident.route_unfilled' AND target = ?")
    .get(teamId, laneId);
  return (row?.n ?? 0) > 0;
}

/**
 * Close the claim window (spec §3): assign any incident that has sat unowned past
 * `claim_window_ms` to the seat holding `fallback_role`.
 *
 * The WINDOW is the whole point, and it points the other way from what "assign to the platform
 * role" sounds like. **Context beats role** — the seats who hit the red know most about it, and the
 * a11y episode this spec came from was fixed across two surfaces (`scripts/a11y/**`,
 * `packages/web/**`) that no single role seat should own. So any seat may take it first, and this
 * only ever catches what nobody picked up. It never reassigns an owned lane.
 *
 * When nobody holds the role the incident stays unowned rather than landing on an arbitrary seat:
 * an unrouted incident is a real state the banner keeps pointing at, and a lane assigned to someone
 * who never agreed to it looks owned while nobody is on it. That case is recorded once per lane —
 * this runs on every sweeper tick, and a row per tick would bury the ledger it is trying to inform.
 *
 * Idempotent by construction: assignment moves the lane off `owner_seat IS NULL`, so a second pass
 * finds nothing. Nothing here wakes anyone — the wake edge is separate and opt-in.
 */
export function routeUnclaimedIncidents(
  db: Database,
  teamId: string,
  teamSlug: string,
  now: number = Date.now(),
): RoutedIncident[] {
  const policy = incidentPolicy(db, teamId);
  if (!policy.enabled) return [];

  const routed: RoutedIncident[] = [];
  for (const lane of openIncidents(db, teamId, teamSlug)) {
    if (lane.owner_seat) continue; // someone claimed it — context beat role, which is the design
    if (now - lane.created_at < policy.claim_window_ms) continue;

    const owner = getMemberByRole(db, teamId, policy.fallback_role);
    if (!owner) {
      if (!alreadyReportedUnfilled(db, teamId, lane.id)) {
        appendAudit(db, teamId, {
          actor: null,
          action: 'incident.route_unfilled',
          target: lane.id,
          result: 'deny',
          detail: { role: policy.fallback_role, waited_ms: now - lane.created_at },
        });
      }
      continue;
    }

    const assigned = updateLane(db, teamId, lane.id, teamSlug, { owner_seat: owner.name }, now);
    if (!assigned) continue;
    appendAudit(db, teamId, {
      actor: null,
      action: 'incident.routed',
      target: lane.id,
      result: 'allow',
      detail: { role: policy.fallback_role, owner: owner.name, waited_ms: now - lane.created_at },
    });
    routed.push({ lane: assigned, owner: owner.name });
  }
  return routed;
}

/**
 * Record one `blocked_by` report. Always inserts the row (more refs = better fan-out at resolve),
 * then: append to an open incident, or open one at the threshold, or just pool. Rows with
 * `lane_id IS NULL` are the pre-threshold pool; a terminal incident never absorbs new reports —
 * its rows keep their lane_id, so the pool restarts empty after a resolve.
 */
export function recordBlockedReport(
  db: Database,
  teamId: string,
  teamSlug: string,
  seat: string,
  report: BlockedBy,
  messageId: string,
  now: number = Date.now(),
): IncidentOutcome {
  const policy = incidentPolicy(db, teamId);
  // The opt-out is a FULL one: no row is written either. A team that turned this off should not be
  // accumulating a pool that springs into an incident the moment someone turns it back on.
  if (!policy.enabled) return { kind: 'disabled' };
  const open = findOpenIncident(db, teamId, teamSlug, report.gate);
  const insert = (laneId: string | null) =>
    db
      .prepare(
        `INSERT INTO incident_reports (team_id, gate, seat, sig, ref, message_id, lane_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        teamId,
        report.gate,
        seat,
        report.sig ?? null,
        report.ref ?? null,
        messageId,
        laneId,
        now,
      );

  if (open) {
    insert(open.id);
    const appended = updateLane(db, teamId, open.id, teamSlug, {
      detail: `${open.detail ?? ''}\n${detailLine(seat, report)}`.trim(),
    });
    appendAudit(db, teamId, {
      actor: seat,
      action: 'incident.report_appended',
      target: open.id,
      result: 'allow',
      detail: { gate: report.gate, lane: open.id },
    });
    return { kind: 'appended', lane: appended ?? open };
  }

  insert(null);
  const pool = db
    .prepare<[string, string], { seat: string }>(
      'SELECT DISTINCT seat FROM incident_reports WHERE team_id = ? AND gate = ? AND lane_id IS NULL',
    )
    .all(teamId, report.gate)
    .map((r) => r.seat);
  if (pool.length < policy.cluster_threshold) return { kind: 'recorded' };

  const rows = db
    .prepare<
      [string, string],
      { id: number; seat: string; sig: string | null; ref: string | null }
    >('SELECT id, seat, sig, ref FROM incident_reports WHERE team_id = ? AND gate = ? AND lane_id IS NULL ORDER BY id')
    .all(teamId, report.gate);
  const lane = openLane(
    db,
    teamId,
    teamSlug,
    seat, // the reporter whose report tripped the threshold; the lane itself stays unowned
    {
      title: incidentTitle(report.gate),
      kind: 'incident',
      stakes: 'high',
      detail: rows.map((r) => detailLine(r.seat, r)).join('\n'),
    },
    now,
  );
  db.prepare(
    'UPDATE incident_reports SET lane_id = ? WHERE team_id = ? AND gate = ? AND lane_id IS NULL',
  ).run(lane.id, teamId, report.gate);
  appendAudit(db, teamId, {
    actor: seat,
    action: 'incident.opened',
    target: lane.id,
    result: 'allow',
    detail: { gate: report.gate, reporters: pool.length },
  });
  return { kind: 'opened', lane: getLane(db, teamId, lane.id, teamSlug) ?? lane };
}
