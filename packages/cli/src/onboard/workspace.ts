import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

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

/** The git toplevel for `cwd`, or null when `cwd` isn't inside a work tree. */
function gitToplevel(cwd: string): string | null {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

export interface WorkspaceOpts {
  /** Bind the current folder instead of making a new one (the legacy single-folder behavior). */
  here?: boolean;
  /** An explicit target directory (created if missing). */
  path?: string;
  /** Base directory to resolve from; defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Decide + create the workspace directory for an agent named `name`. Pure-ish: the only side effects
 * are `git worktree add` / `mkdir`. Never throws for "already there" — an existing target is reused so
 * re-running is idempotent.
 */
export function provisionWorkspace(name: string, opts: WorkspaceOpts = {}): Workspace {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.here) return { dir: cwd, kind: 'here', created: false };

  if (opts.path) {
    const dir = isAbsolute(opts.path) ? opts.path : resolvePath(cwd, opts.path);
    const created = !existsSync(dir);
    if (created) mkdirSync(dir, { recursive: true });
    return { dir, kind: 'folder', created };
  }

  const top = gitToplevel(cwd);
  if (top) {
    const dir = join(dirname(top), `${basename(top)}-${name}`);
    const branch = `agent/${name}`;
    if (existsSync(dir)) return { dir, kind: 'worktree', branch, created: false };
    try {
      // New branch off HEAD so the agent has its own line to commit on.
      git(['worktree', 'add', '-b', branch, dir, 'HEAD'], top);
    } catch {
      // Branch already exists (e.g. a prior run): attach a worktree to it.
      git(['worktree', 'add', dir, branch], top);
    }
    return { dir, kind: 'worktree', branch, created: true };
  }

  // Not a git repo — a plain sibling folder.
  const base = resolvePath(cwd);
  const dir = join(dirname(base), `${basename(base)}-${name}`);
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true });
  return { dir, kind: 'folder', created };
}
