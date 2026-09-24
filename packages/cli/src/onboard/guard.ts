import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
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

/**
 * A binding never sits above a Workspace (reach-and-boundaries spec §6, ADR 442). Identity resolves
 * by walking UP to the nearest `.musterd/binding.json`, so a binding written at `~`, at `~/musterd`
 * (the roof over every project — `~/musterd/<repo>/<member>` is the member-worktree layout), or in
 * any folder with a Workspace beneath it would silently confer that identity on every *unbound*
 * folder under it. This is the HARD refusal — unlike {@link inspectInitTarget}'s confirm, there is
 * no "yes, I mean it": the wall (ADR 442) is only as good as the rule that no folder confers an
 * identity it was not bound to.
 *
 * Every comparison is by REAL path: a symlinked alias of a refused folder is refused like the real
 * one, and a symlinked cwd is judged where it really lives. The beneath-scan is two levels deep
 * (`<repo>/<member>` and `<repo>/.worktrees/<member>` are both one or two down), skipping
 * `node_modules` and `.git`, and it does not follow symlinks. Non-throwing: a folder that cannot
 * be read is not refused — this guard exists to stop a *layout* slip, never to block a genuine run
 * on a filesystem hiccup.
 */
export interface BindingRefusal {
  /** Why the folder cannot hold a binding, ready to print. */
  reason: string;
  /** The Workspace found beneath the folder, when that is the reason (real path). */
  workspace?: string;
}

const LAYOUT_HINT = 'Bind a member worktree instead: ~/musterd/<repo>/<member>.';

export function bindingRefusal(cwd: string, home: string = homedir()): BindingRefusal | null {
  const here = realpathOr(cwd);
  if (!existsSync(here)) return null;
  if (here === realpathOr(home)) {
    return {
      reason: `${cwd} is your home folder — a binding here would confer one identity on every folder beneath it. ${LAYOUT_HINT}`,
    };
  }
  if (here === realpathOr(join(home, 'musterd'))) {
    return {
      reason: `${cwd} is the roof over every project (~/musterd) and never holds a binding. ${LAYOUT_HINT}`,
    };
  }
  const beneath = workspaceBeneath(here, 2);
  if (beneath) {
    return {
      reason: `a Workspace lies beneath ${cwd} (${beneath}) — a binding here would confer its identity on every unbound folder under it. ${LAYOUT_HINT}`,
      workspace: beneath,
    };
  }
  return null;
}

/** `realpathSync` with the un-resolvable case folded to a plain absolute path (never throws). */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The first folder at most `depth` levels under `dir` holding a `.musterd/binding.json`, or null. */
function workspaceBeneath(dir: string, depth: number): string | null {
  if (depth === 0) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    // Real directories only: a symlinked child is somebody else's folder (and may loop).
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const child = join(dir, e.name);
    if (e.name !== BINDING_DIR && existsSync(join(child, BINDING_DIR, BINDING_FILE))) return child;
    const deeper = workspaceBeneath(child, depth - 1);
    if (deeper) return deeper;
  }
  return null;
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
    if (ref.seat !== name || resolve(folder) === here) continue;
    // A registry entry outlives the folder it names — nothing prunes it when a project is deleted
    // (ADR 162). Warning "already bound in <folder>" about a folder that no longer exists is a lie
    // the human cannot act on, so a vanished folder is not a collision. Cheap: one stat, and only
    // for entries that already matched the name.
    if (!existsSync(folder)) continue;
    return { folder, team: ref.team };
  }
  return null;
}
