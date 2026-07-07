import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  BindingSchema,
  bindingSeat,
  type Binding,
  type MemberSummary,
} from '@musterd/protocol';
import type { BindingRef } from '../config.js';

/**
 * Folder-suitability guard (ADR 020). `musterd init` binds an agent to the *folder* it runs in
 * (a Claude Code `-s local` config + a `.musterd/binding.json` + an `AGENTS.md` primer), so a
 * wrong-folder run is an easy multi-artifact slip whose only undo is manual — the 2026-06-15
 * dogfood that wired a member into the musterd source repo (implementation-plan §4.A finding c).
 *
 * This is the *pure* heuristic layer: it inspects the target folder and returns human-readable
 * warnings; the interactive confirm lives in `init.ts`. Keeping the logic out of the @clack prompt
 * layer is what makes it unit-testable. Every check is best-effort and non-throwing — a guard
 * failure must never block a genuine run (init must stay runnable in any folder the user means,
 * including this repo, for dogfooding).
 */
export interface InitTargetReport {
  warnings: string[];
}

/** Inspect `cwd` for signs it isn't the project the user meant to set up an agent in. */
export function inspectInitTarget(cwd: string): InitTargetReport {
  const warnings: string[] = [];

  // (1) The musterd source checkout itself — the exact dogfound slip.
  if (isMusterdSourceTree(cwd)) {
    warnings.push(
      'This folder looks like the musterd source tree — init would wire an agent into the repo itself, not your project.',
    );
  }

  // (2) Already bound to a member here — init will mint a new member and repoint the binding.
  const bound = readBindingAt(cwd);
  if (bound) {
    warnings.push(
      `This folder is already bound to ${bound.seat} on ${bound.team} — init will mint a new member and repoint the binding here. ` +
        `If ${bound.seat} is a live session, give the new agent its own workspace instead: ` +
        `musterd agent <name> (adds the seat + a git worktree + binding), or run from a separate worktree.`,
    );
  }

  // An unrelated AGENTS.md is intentionally *not* warned here: the primer step (init.ts §5b) asks
  // about appending in context ("Append a musterd primer to the AGENTS.md already here?"), so a
  // duplicate up-front warning would fire before any prompt and read as alarming (2026-06-23 dogfood).

  return { warnings };
}

/**
 * Live-binding clobber guard (ADR 066, amended by ADR 105). A `claim`/`init` in a folder already bound
 * to a *different* member silently repoints `.musterd/binding.json`, evicting that member from the
 * folder. That is benign when the bound member is offline (a stale seat to reclaim), but a real
 * collision when it is *currently live* — two sessions would then drive one working tree, the exact risk
 * ADR 065's one-command worktrees exist to avoid (and the one this very dogfood session hit sharing a
 * tree). A seat that is **held within its ADR 010 reclaim grace** (`reclaimable`) counts as occupied
 * too: it reads `offline` on the roster but is a reservation that may be reconnecting, so clobbering it
 * is the same collision a moment deferred (ADR 105 / issue #153).
 *
 * Pure + roster-driven, so it is unit-testable without a daemon: the caller passes the folder's
 * current binding and the roster. Returns the bound member to warn about (with where it is live, when
 * known, and whether the block is a reclaim-grace reservation), or null when there is nothing to
 * clobber. A claim that re-occupies the folder's own seat (target === bound) is never a clobber.
 */
export function liveBindingClobber(
  binding: Binding | null,
  members: MemberSummary[],
  target: string | null,
): { member: string; workspace?: string; reclaimable?: boolean } | null {
  const bound = binding ? bindingSeat(binding) : undefined;
  if (!bound) return null;
  if (target !== null && bound === target) return null; // re-occupying our own seat
  const m = members.find((x) => x.name === bound);
  if (!m) return null; // bound name not on this team's roster — nothing live to evict
  const livePresence = m.presences.find((p) => p.status !== 'offline');
  const live = m.presence !== 'offline' || (m.activity != null && m.activity !== 'offline');
  // A held-within-grace seat (ADR 010 reservation) is occupied for the guard's purposes even though it
  // reads `offline` — but a genuinely-live presence takes precedence when we describe *where* it is.
  const reclaimableOnly = !live && m.reclaimable === true;
  if (!live && !reclaimableOnly) return null;
  if (reclaimableOnly) return { member: bound, reclaimable: true };
  return livePresence?.workspace
    ? { member: bound, workspace: livePresence.workspace }
    : { member: bound };
}

/** The monorepo root (by package name) or its `packages/{cli,server}` layout. */
function isMusterdSourceTree(cwd: string): boolean {
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === 'musterd-monorepo') return true;
    }
  } catch {
    // unreadable/!JSON package.json — fall through to the layout check
  }
  return (
    existsSync(join(cwd, 'packages', 'cli', 'package.json')) &&
    existsSync(join(cwd, 'packages', 'server', 'package.json'))
  );
}

/** Read the binding *in this exact folder* (not a parent), via the shared protocol schema. */
function readBindingAt(cwd: string): { seat: string; team: string } | null {
  try {
    const path = join(cwd, BINDING_DIR, BINDING_FILE);
    if (!existsSync(path)) return null;
    const b = BindingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    // A role-pool / chat binding has no fixed seat name to compare against.
    const seat = bindingSeat(b);
    if (!seat) return null;
    return { seat, team: b.team };
  } catch {
    return null;
  }
}

/**
 * Cross-folder name-reuse check (ADR 020). Given the candidate member name and the global config's
 * binding registry, return the *other* folder this name is already bound in (if any). Pure: the
 * caller passes the registry, so this is unit-testable without touching disk. This is the one
 * collision case the per-folder guard above can't see — there is no other global index of bindings.
 * The same-folder entry (a re-run in this folder) is intentionally ignored; that's heuristic (2).
 */
export function nameBoundElsewhere(
  name: string,
  cwd: string,
  bindings: Record<string, BindingRef>,
): { folder: string; team: string } | null {
  const here = resolve(cwd);
  for (const [folder, ref] of Object.entries(bindings)) {
    if (ref.seat === name && resolve(folder) !== here) {
      return { folder, team: ref.team };
    }
  }
  return null;
}
