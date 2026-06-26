import type { Lifecycle } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { log } from '../log.js';
import {
  addMember,
  getMemberByName,
  leaveMember,
  listMembers,
  type MemberIdentityFields,
  reviveMember,
  updateMemberIdentity,
} from '../store/members.js';
import { createTeam, getTeamBySlug, updateTeam } from '../store/teams.js';
import { type LoadedSeat, loadTeamSpec, type TeamSpec } from './load.js';

/**
 * Reconcile the durable files into the db projection (ADR 058 / projection-reconcile.md). This is a
 * **match-by-name delta**, never a truncate-and-reload: `id` and `token_hash` are daemon-private
 * anchors that must survive a reconcile (the message log and live tokens depend on them). The loop is
 * declarative and idempotent — re-running it converges to the same state, which is what makes the
 * flaky `fs.watch` trigger safe.
 */

export interface ReconcileResult {
  slug: string;
  added: string[];
  updated: string[];
  revived: string[];
  removed: string[];
  /** Tokens minted this pass (ADD + REVIVE), keyed by seat name — surfaced for project-and-return. */
  minted: Record<string, string>;
  /** Fail-closed parse errors carried from the spec (skipped seats). */
  errors: string[];
}

function resolveLifecycle(
  seat: LoadedSeat['seat'],
  teamLifecycle: Lifecycle,
): { lifecycle: Lifecycle; lifecycleUntil: number | null } {
  const lifecycle = (seat.lifecycle ?? teamLifecycle) as Lifecycle;
  const lifecycleUntil = lifecycle === 'until' && seat.until ? Date.parse(seat.until) : null;
  return { lifecycle, lifecycleUntil };
}

/** Reconcile one team spec into the db. Returns the delta applied + any tokens minted. */
export function reconcileTeam(db: Database, spec: TeamSpec): ReconcileResult {
  const teamLifecycle = spec.team.lifecycle as Lifecycle;
  // Upsert the team identity (durable fields only; id + created_at preserved).
  let team = getTeamBySlug(db, spec.team.slug);
  if (!team) {
    team = createTeam(db, {
      slug: spec.team.slug,
      display: spec.team.display ?? null,
      defaultLifecycle: teamLifecycle,
    });
  } else {
    updateTeam(db, team.id, {
      display: spec.team.display ?? null,
      defaultLifecycle: teamLifecycle,
    });
  }

  const result: ReconcileResult = {
    slug: spec.team.slug,
    added: [],
    updated: [],
    revived: [],
    removed: [],
    minted: {},
    errors: [...spec.errors],
  };
  const desired = new Set(spec.seats.map((s) => s.name));

  for (const { name, seat } of spec.seats) {
    const { lifecycle, lifecycleUntil } = resolveLifecycle(seat, teamLifecycle);
    const fields: MemberIdentityFields = {
      kind: seat.kind,
      role: seat.role ?? '',
      lifecycle,
      lifecycleUntil,
    };
    const existing = getMemberByName(db, team.id, name); // includes tombstoned rows
    if (!existing) {
      // ADD — the only path (besides REVIVE) that originates a secret.
      const { token } = addMember(db, team, {
        name,
        kind: fields.kind,
        role: fields.role,
        lifecycle: fields.lifecycle,
        lifecycleUntil: fields.lifecycleUntil,
      });
      result.added.push(name);
      result.minted[name] = token;
    } else if (existing.left_at !== null) {
      // REVIVE — same id (log continuity), re-minted token (deletion was a revocation), back to declared.
      const token = reviveMember(db, existing.id, fields);
      result.revived.push(name);
      result.minted[name] = token;
    } else if (
      existing.kind !== fields.kind ||
      existing.role !== fields.role ||
      existing.lifecycle !== fields.lifecycle ||
      existing.lifecycle_until !== fields.lifecycleUntil
    ) {
      // UPDATE in place — id, token_hash, bound_at preserved (live session unaffected).
      updateMemberIdentity(db, existing.id, fields);
      result.updated.push(name);
    }
  }

  // REMOVE — a live member with no file is soft-tombstoned (never hard-deleted: the message log FK
  // and the audit history require the row to persist; auth already excludes left_at rows).
  for (const m of listMembers(db, team.id)) {
    if (!desired.has(m.name)) {
      leaveMember(db, m.id);
      result.removed.push(m.name);
    }
  }
  return result;
}

/**
 * Find the roster spec that declares `slug`, if any (ADR 058 per-team cutover). Returns the spec when
 * the team is **file-backed** (some root's `team.toml` carries this slug), else null — the signal the
 * provisioning route uses to choose project-and-return vs. the legacy db-originate path.
 */
export function teamSpecForSlug(roots: string[], slug: string): TeamSpec | null {
  for (const root of roots) {
    let spec: TeamSpec | null = null;
    try {
      spec = loadTeamSpec(root);
    } catch {
      continue; // invalid team.toml — not a usable backing for this slug
    }
    if (spec && spec.team.slug === slug) return spec;
  }
  return null;
}

/**
 * Reconcile every roster root into the one global projection. A team whose `team.toml` is invalid is
 * skipped with its prior projection intact (fail-closed); db-only teams (no root) are never touched.
 */
export function reconcileAll(db: Database, roots: string[]): ReconcileResult[] {
  const results: ReconcileResult[] = [];
  for (const root of roots) {
    let spec: TeamSpec | null = null;
    try {
      spec = loadTeamSpec(root);
    } catch (e) {
      log.warn({ msg: 'reconcile_team_invalid', root, err: (e as Error).message });
      continue;
    }
    if (!spec) continue;
    try {
      results.push(reconcileTeam(db, spec));
    } catch (e) {
      log.warn({ msg: 'reconcile_failed', root, err: (e as Error).message });
    }
  }
  return results;
}
