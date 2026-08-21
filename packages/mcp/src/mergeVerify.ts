/*
 * Merge-verified submit: classify a lane's merge attestation against origin/main using only
 * this worktree's git — no GitHub API, no poller, no new credential. The repo itself is the
 * source of truth for "merged", and the author's own `lane_submit` is the event that carries
 * the check (ADR 294 dec 2 / ADR 297 forbid the background-sweep shape).
 */
import { execFile } from 'node:child_process';
import type { MergeVerification } from '@musterd/protocol';

/** What a submit-time check can conclude: a persistable tier, or the one refusal outcome. */
export type VerifyOutcome = MergeVerification | 'not_ancestor';

export type GitExec = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number }>;

/** Squash SHAs as callers actually pass them: abbreviated (≥7 hex) or full. */
export const SHA_FORMAT = /^[0-9a-f]{7,40}$/i;

export const defaultGitExec: GitExec = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err) => {
      // execFile errors carry a numeric exit code for a non-zero exit; spawn/timeout errors
      // carry a string code (ENOENT, ETIMEDOUT) or none — those reject and are caught above.
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });

/**
 * `not_ancestor` requires a SUCCESSFUL fetch: a stale origin/main ref can produce a false
 * "not landed", so without a fresh fetch the negative degrades to `fetch_failed` (abstain).
 * The positive needs no fresh ref — history only grows, so a stale ref cannot fake a landing.
 */
export async function verifyMerge(
  input: { sha?: string | undefined; cwd: string },
  exec: GitExec = defaultGitExec,
): Promise<VerifyOutcome> {
  if (input.sha === undefined) return 'unattested';
  const run = async (args: string[]): Promise<number> => {
    try {
      return (await exec(args, { cwd: input.cwd, timeoutMs: 15_000 })).code;
    } catch {
      return -1; // spawn failure / timeout — "could not run", never a throw to the caller
    }
  };
  const fetched = (await run(['fetch', '--quiet', 'origin', 'main'])) === 0;
  const exists = (await run(['cat-file', '-e', `${input.sha}^{commit}`])) === 0;
  if (!exists) return fetched ? 'unknown_object' : 'fetch_failed';
  const ancestry = await run(['merge-base', '--is-ancestor', input.sha, 'origin/main']);
  if (ancestry === 0) return 'ancestor';
  if (ancestry === 1 && fetched) return 'not_ancestor';
  return 'fetch_failed';
}
