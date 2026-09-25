import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
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
  /** The `~` the `~/musterd/<team>/<repo>/<member>` layout hangs off; defaults to `os.homedir()` (tests). */
  home?: string;
  /** The worktree's branch; defaults to `agent/<name>`. */
  branch?: string;
  /**
   * Write the seat's synthetic git identity (ADR 109). Default true; a human's Workspace keeps the
   * person's own git identity — {@link setSeatGitIdentity} is for agent seats only.
   */
  gitIdentity?: boolean;
}

/**
 * Where a member's Workspace lives (ADR 447, superseding the ADR 442 layout note):
 * `~/musterd/<team>/<repo>/<member>`. Team outermost, because a member name means one thing only on
 * its team — two teams can share a repo and a name (`revive/agents/dolly`, `other/agents/dolly`)
 * without colliding — and because a team spans repos more often than a repo spans teams. Grouped by
 * repo beneath that, not by member kind (humans and agents alike), and never a sibling of the
 * checkout it was provisioned from, because that checkout may be the unbound runtime
 * (`~/.musterd/runtime`) whose parent must hold no Workspace.
 *
 * `<repo>` is, in order: the group this checkout already sits in when it is itself a member
 * Workspace of the same team (`~/musterd/revive/agents/nick` → `agents`, so a repo keeps one group
 * however its remote is spelled); else the remote's repo name; else the checkout's basename.
 */
export function memberWorkspaceDir(
  top: string,
  name: string,
  team: string,
  home: string = homedir(),
  remote: string | null = null,
): string {
  const roof = join(home, 'musterd');
  const rel = resolvePath(top).startsWith(roof + '/')
    ? resolvePath(top).slice(roof.length + 1)
    : '';
  const segments = rel.split('/');
  const repo =
    segments.length >= 3 && segments[0] === team && segments[1]
      ? segments[1]
      : (remoteRepoName(remote) ?? basename(resolvePath(top)));
  return join(roof, team, repo, name);
}

/** `git@github.com:Org/musterd.git` / `https://…/Org/musterd` → `musterd`; null when unparseable. */
function remoteRepoName(remote: string | null): string | null {
  if (!remote) return null;
  const tail = remote.trim().replace(/\/+$/, '').split(/[/:]/).pop();
  const name = tail?.replace(/\.git$/, '');
  return name ? name : null;
}

function originUrl(top: string): string | null {
  try {
    return git(['remote', 'get-url', 'origin'], top);
  } catch {
    return null;
  }
}

/**
 * Seat-attributed commits (ADR 109 / ADR 197): give the worktree its own git identity so `git log`
 * answers "which seat wrote this" natively. `--worktree` (not `--local`) is load-bearing — repo-local
 * config is shared across all worktrees, so without `extensions.worktreeConfig` the last-provisioned
 * seat would silently rename every other seat's commits. Best-effort: identity is attribution, never
 * a gate on provisioning or re-bind.
 *
 * Call on every agent re-bind (`claim` / `join`), not only at provision — otherwise a folder that
 * moves to another team keeps `seat@oldTeam.musterd` and splits one seat across two emails on `main`
 * (ADR 197). Agent seats only; never call for a human credential (`mscr_`).
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
  const identity = (dir: string): void => {
    if (opts.gitIdentity !== false) setSeatGitIdentity(name, dir, opts.team);
  };

  /*
   * `--here` and `--path` used to return before writing any identity, and those are exactly the paths
   * a REPAIR takes: `musterd agent <seat> --path <ws>` is the documented fix for an expired grant, so
   * it runs against worktrees already in use. The result was that fixing a broken credential silently
   * stripped the seat's attribution, and every later commit from that seat was authored as the human —
   * which is how two live seats ended up with zero Co-authored-by trailers across dozens of merges.
   */
  if (opts.here) {
    identity(cwd);
    return { dir: cwd, kind: 'here', created: false };
  }

  if (opts.path) {
    const dir = isAbsolute(opts.path) ? opts.path : resolvePath(cwd, opts.path);
    const created = !existsSync(dir);
    if (created) mkdirSync(dir, { recursive: true });
    identity(dir);
    return { dir, kind: 'folder', created };
  }

  const top = gitToplevel(cwd);
  if (top) {
    // Pre-layout seats (ADR 065) were siblings of the checkout: `<repo>-<name>`. One that already
    // exists is that seat's Workspace — reuse it (the identity repair below) rather than provision a
    // second; moving it onto the layout is `scripts/layout/migrate.ts`, not this command.
    const legacy = join(dirname(top), `${basename(top)}-${name}`);
    const dir = existsSync(legacy)
      ? legacy
      : memberWorkspaceDir(top, name, opts.team ?? 'seats', opts.home, originUrl(top));
    const branch = opts.branch ?? `agent/${name}`;
    if (existsSync(dir)) {
      // Reuse path repairs identity too, so pre-109 worktrees pick it up on re-run.
      identity(dir);
      return { dir, kind: 'worktree', branch, created: false };
    }
    mkdirSync(dirname(dir), { recursive: true });
    try {
      // New branch off HEAD so the agent has its own line to commit on.
      git(['worktree', 'add', '-b', branch, dir, 'HEAD'], top);
    } catch {
      // Branch already exists (e.g. a prior run): attach a worktree to it.
      git(['worktree', 'add', dir, branch], top);
    }
    identity(dir);
    return { dir, kind: 'worktree', branch, created: true };
  }

  // Not a git repo — a plain sibling folder.
  const base = resolvePath(cwd);
  const dir = join(dirname(base), `${basename(base)}-${name}`);
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true });
  return { dir, kind: 'folder', created };
}
