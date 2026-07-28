import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { DEFAULT_PROJECT } from './lanes.js';

/**
 * Lane `project` derivation — **Node-only**, and deliberately *not* exported from the package
 * barrel (same structural rule as `build-stamp.ts`: this shells out, and the barrel is imported by
 * the browser). Node consumers import it explicitly:
 *
 * ```ts
 * import { resolveProject } from '@musterd/protocol/project';
 * ```
 *
 * Lanes have carried `project` since ADR 083 — *"contention is checked within a project, never
 * across"* — but nothing ever derived it, so every lane on every team was `'default'` and
 * surface-overlap was silently team-wide: `packages/web/**` in one repo "overlapped"
 * `packages/web/**` in another. This is the missing derivation.
 *
 * Precedence (highest first): an explicit `--project` / tool argument, `MUSTERD_PROJECT`, the
 * derived repo identity, then the `'default'` floor for a non-git folder.
 */

export { DEFAULT_PROJECT };

export interface ResolveProjectOpts {
  /** An explicit `--project` flag / `project:` tool argument. Wins outright. */
  explicit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * The repo this workspace belongs to, as a project name — or null outside a work tree.
 *
 * **Why `--git-common-dir` and not `--show-toplevel`.** The design doc specified "the basename of
 * the git toplevel", and that rule is wrong in a **linked worktree**: `--show-toplevel` returns the
 * *worktree's* path, not the repo's. musterd provisions one worktree per seat (`provisionWorkspace`,
 * ADR 065), so a team of N seats on one repo would derive N distinct projects — fragmenting a single
 * repo and switching surface-overlap *off* for the whole team. That is the failure this derivation
 * exists to fix, inverted, and it would land silently, because the checks are warn-only and the
 * symptom is an absence of warnings. `--git-common-dir` resolves to the same `…/<repo>/.git` from
 * every worktree of a repo, which is the invariant the project name needs. (ADR 165 argues the same
 * shape independently: a slot shared by N seats may hold only what is identical across all N.)
 */
export function repoProject(cwd: string = process.cwd()): string | null {
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  if (!common) return null;
  // git answers relative (`.git`) at the top of the main work tree and absolute everywhere else.
  const abs = resolvePath(cwd, common);
  // `…/<repo>/.git` → `<repo>`; a bare repo's common dir is `…/<repo>.git` itself.
  const dir = basename(abs) === '.git' ? dirname(abs) : abs.replace(/\.git$/, '');
  return sanitizeProject(basename(dir));
}

/**
 * The project a lane opened from `cwd` belongs to. Never throws and never blocks: a git-less folder,
 * a missing git binary, or a hostile repo name all degrade to `DEFAULT_PROJECT`.
 */
export function resolveProject(opts: ResolveProjectOpts = {}): string {
  const explicit = sanitizeProject(opts.explicit ?? '');
  if (explicit) return explicit;
  const declared = sanitizeProject((opts.env ?? process.env)['MUSTERD_PROJECT'] ?? '');
  if (declared) return declared;
  return repoProject(opts.cwd ?? process.cwd()) ?? DEFAULT_PROJECT;
}

/**
 * The git toplevel for `cwd`, or null when `cwd` isn't inside a work tree — the shared copy of a
 * `rev-parse` that the CLI's provisioner and the MCP adapter's workspace label each grew privately.
 */
export function gitToplevel(cwd: string): string | null {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

/** Run a git command, returning trimmed stdout or null if git is absent / the command fails. */
export function gitOutput(args: string[], cwd: string): string | null {
  return git(args, cwd);
}

/** Trim, collapse whitespace, cap length. Empty (or whitespace-only) means "not declared". */
function sanitizeProject(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').slice(0, 80);
}

/** Run a git command, returning trimmed stdout or null if git is absent / cwd isn't a repo. */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
