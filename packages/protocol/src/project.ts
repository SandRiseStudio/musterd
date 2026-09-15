import { execFileSync } from 'node:child_process';
import { basename, dirname, relative, resolve as resolvePath } from 'node:path';
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
 * The **identity** of the workspace a session runs in — stable for the life of the folder, and the
 * value single-active displacement compares (ADR 068/092).
 *
 * Deliberately NOT the workspace *label* (`resolveWorkspace`, `resolveClaimWorkspace`). That label
 * is a where-on-attach seed rendered dim on the roster, "approximately right by design", and it is
 * qualified with the git branch — so it CHANGES under the session that owns it: a branch switch
 * renames it, and a detached HEAD (every review, every rebase, every `switch --detach origin/main`)
 * drops the qualifier entirely. Compared by string equality it made a seat's own next attach look
 * like a foreign workspace, and the same-workspace grace that exists to protect the live session
 * never engaged — measured 2026-09-02, lane 01M1JQYYAC.
 *
 * The work tree root is the right granularity: one seat gets one worktree (`provisionWorkspace`,
 * ADR 065), it is what a session cannot change without becoming a different session, and unlike the
 * basename it cannot collide between two checkouts of the same repo. Note this is `--show-toplevel`
 * and NOT `repoProject`'s `--git-common-dir`: the project name must be worktree-INvariant so N seats
 * share one surface space; this must be worktree-SPECIFIC so two seats on one repo are two
 * workspaces. Same repo, opposite invariants, on purpose.
 *
 * A declared `MUSTERD_WORKSPACE` wins here as it does for the label — an override names the
 * workspace on both axes, so a human who says "these two are one workspace" is believed.
 * Degrades to `cwd` outside a work tree (or with no git at all); never throws.
 */
export function resolveWorkspaceKey(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const declared = env['MUSTERD_WORKSPACE']?.trim();
  if (declared) return declared.slice(0, 200);
  return (gitToplevel(cwd) ?? cwd).slice(0, 200);
}

/**
 * The "where"-on-attach LABEL (human-agent-dynamics §2; ADR 014) — the sibling of
 * {@link resolveWorkspaceKey} above, and the thing that key was split from (ADR 368). A
 * gracefully-degrading label, captured once at join and read out of the roster — never asked of the
 * agent per status.
 *
 * Degradation ladder (locked decisions):
 *   1. declared override — `MUSTERD_WORKSPACE` wins verbatim (one-time "what are you working on?").
 *   2. floor — the cwd folder name, which always exists.
 *   3. qualifier — the *most specific* available leads: git branch when informative, else the cwd
 *      subpath within the repo, else nothing. A git-less project degrades cleanly to the bare folder.
 *
 * Rendered dim, as location context — it is approximately right by design, not an authoritative
 * scope. Lived in `@musterd/mcp` until 2026-09-04 (ADR 379 amendment): four CLI call sites imported
 * it across the package boundary AGENTS.md reserves for `@musterd/protocol`, and the wake actuator
 * (ADR 379) needs the SAME resolver the adapter runs so it can recognise its own child's row — one
 * copy, in the one package both may import.
 */
export function resolveWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const declared = env['MUSTERD_WORKSPACE']?.trim();
  if (declared) return declared.slice(0, 120);

  const folder = basename(cwd) || cwd;
  const git = gitContext(cwd);
  const qualifier = git?.branch || git?.subpath || '';
  const label = qualifier ? `${folder}@${qualifier}` : folder;
  return label.slice(0, 120);
}

interface GitContext {
  /** Current branch name; empty when detached or unnamed. */
  branch: string;
  /** cwd relative to the repo top-level; empty at the root or outside the tree. */
  subpath: string;
}

function gitContext(cwd: string): GitContext | null {
  const top = gitToplevel(cwd);
  if (!top) return null;
  const branchRaw = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : '';
  const subpath = relative(top, cwd);
  return { branch, subpath: subpath === '' || subpath.startsWith('..') ? '' : subpath };
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
