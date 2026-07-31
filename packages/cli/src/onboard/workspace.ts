import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { gitToplevel } from '@musterd/protocol/project';

/**
 * Provision an *isolated workspace* for a new agent (ADR 065). The thrash this avoids: in Claude Code
 * one folder = one `-s local` MCP registration = one identity, so two live agents cannot share a
 * folder — they fight over the single `.musterd/binding.json`. Each agent therefore gets its own
 * working directory. In a git repo that's a **worktree** (own branch + own checked-out tree, so two
 * agents can edit in parallel without colliding); outside git it's a sibling folder.
 */
export type WorkspaceKind = 'here' | 'worktree' | 'folder';

export interface Workspace {
  /** Absolute path the agent's binding + MCP registration will live in. */
  dir: string;
  kind: WorkspaceKind;
  /** The branch checked out in the worktree (worktree kind only). */
  branch?: string;
  /** True when this call created the directory (false when an existing one was reused). */
  created: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export interface WorkspaceOpts {
  /** Bind the current folder instead of making a new one (the legacy single-folder behavior). */
  here?: boolean;
  /** An explicit target directory (created if missing). */
  path?: string;
  /** Base directory to resolve from; defaults to process.cwd(). */
  cwd?: string;
  /** Team slug — used for the seat's synthetic git-identity email domain (ADR 109). */
  team?: string;
}

/**
 * Seat-attributed commits (ADR 109 / ADR 196): give the worktree its own git identity so `git log`
 * answers "which seat wrote this" natively. `--worktree` (not `--local`) is load-bearing — repo-local
 * config is shared across all worktrees, so without `extensions.worktreeConfig` the last-provisioned
 * seat would silently rename every other seat's commits. Best-effort: identity is attribution, never
 * a gate on provisioning or re-bind.
 *
 * Call on every agent re-bind (`claim` / `join`), not only at provision — otherwise a folder that
 * moves to another team keeps `seat@oldTeam.musterd` and splits one seat across two emails on `main`
 * (ADR 196). Agent seats only; never call for a human credential (`mscr_`).
 *
 * `top` is resolved from `dir` rather than passed in, because the callers that most need this are the
 * ones that never computed a toplevel: `--here` and `--path` (§ {@link provisionWorkspace}). Outside a
 * repo there is no toplevel and nothing to write, which is fine — a plain folder has no git identity
 * to carry.
 */
export function setSeatGitIdentity(name: string, dir: string, team?: string): void {
  try {
    const top = gitToplevel(dir);
    if (!top) return; // a plain folder: nothing to attribute
    git(['config', 'extensions.worktreeConfig', 'true'], top);
    git(['config', '--worktree', 'user.name', `${name} (musterd seat)`], dir);
    git(['config', '--worktree', 'user.email', `${name}@${team ?? 'seats'}.musterd`], dir);
  } catch {
    /* attribution only — never fail the workspace for it */
  }
}

/**
 * Decide + create the workspace directory for an agent named `name`. Pure-ish: the only side effects
 * are `git worktree add` / `mkdir`. Never throws for "already there" — an existing target is reused so
 * re-running is idempotent.
 */
export function provisionWorkspace(name: string, opts: WorkspaceOpts = {}): Workspace {
  const cwd = opts.cwd ?? process.cwd();

  /*
   * `--here` and `--path` used to return before writing any identity, and those are exactly the paths
   * a REPAIR takes: `musterd agent <seat> --path <ws>` is the documented fix for an expired grant, so
   * it runs against worktrees already in use. The result was that fixing a broken credential silently
   * stripped the seat's attribution, and every later commit from that seat was authored as the human —
   * which is how two live seats ended up with zero Co-authored-by trailers across dozens of merges.
   */
  if (opts.here) {
    setSeatGitIdentity(name, cwd, opts.team);
    return { dir: cwd, kind: 'here', created: false };
  }

  if (opts.path) {
    const dir = isAbsolute(opts.path) ? opts.path : resolvePath(cwd, opts.path);
    const created = !existsSync(dir);
    if (created) mkdirSync(dir, { recursive: true });
    setSeatGitIdentity(name, dir, opts.team);
    return { dir, kind: 'folder', created };
  }

  const top = gitToplevel(cwd);
  if (top) {
    const dir = join(dirname(top), `${basename(top)}-${name}`);
    const branch = `agent/${name}`;
    if (existsSync(dir)) {
      // Reuse path repairs identity too, so pre-109 worktrees pick it up on re-run.
      setSeatGitIdentity(name, dir, opts.team);
      return { dir, kind: 'worktree', branch, created: false };
    }
    try {
      // New branch off HEAD so the agent has its own line to commit on.
      git(['worktree', 'add', '-b', branch, dir, 'HEAD'], top);
    } catch {
      // Branch already exists (e.g. a prior run): attach a worktree to it.
      git(['worktree', 'add', dir, branch], top);
    }
    setSeatGitIdentity(name, dir, opts.team);
    return { dir, kind: 'worktree', branch, created: true };
  }

  // Not a git repo — a plain sibling folder.
  const base = resolvePath(cwd);
  const dir = join(dirname(base), `${basename(base)}-${name}`);
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true });
  return { dir, kind: 'folder', created };
}
