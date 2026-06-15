import { execFileSync } from 'node:child_process';
import { basename, relative } from 'node:path';
import { PROVENANCES, type Provenance } from '@musterd/protocol';

/**
 * The "where"-on-attach seed (human-agent-dynamics §2; ADR 014). A gracefully-degrading workspace
 * label, captured once at join and read out of the roster — never asked of the agent per status.
 *
 * Degradation ladder (locked decisions):
 *   1. declared override — `MUSTERD_WORKSPACE` wins verbatim (one-time "what are you working on?").
 *   2. floor — the cwd folder name, which always exists.
 *   3. qualifier — the *most specific* available leads: git branch when informative, else the cwd
 *      subpath within the repo, else nothing. A git-less project degrades cleanly to the bare folder.
 *
 * Rendered dim, as location context — it is approximately right by design, not an authoritative scope.
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

/** Read provenance from `MUSTERD_PROVENANCE`, defaulting to `session` (the common human-driven case). */
export function resolveProvenance(env: NodeJS.ProcessEnv = process.env): Provenance {
  const raw = env['MUSTERD_PROVENANCE'];
  return (PROVENANCES as readonly string[]).includes(raw ?? '') ? (raw as Provenance) : 'session';
}

interface GitContext {
  /** Current branch, or '' when detached/unavailable (a detached HEAD is not informative). */
  branch: string;
  /** Path from the repo root down to cwd, or '' at the root. */
  subpath: string;
}

function gitContext(cwd: string): GitContext | null {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return null;
  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : '';
  const subpath = relative(top, cwd);
  return { branch, subpath: subpath === '' || subpath.startsWith('..') ? '' : subpath };
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
