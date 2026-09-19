/*
 * Carried-lane reconciliation (lane 01M2XAXRP3): before `team_next` reports a lane as carried,
 * ask this worktree's git whether the lane's work is already on `origin/main`. A lane whose work
 * landed is not carried — it is UNSUBMITTED, and the next act is `lane_submit`, not a build.
 *
 * Measured 2026-09-19, three for three: miley oriented off seat memory and reported three lanes
 * as carried; all three had shipped (#1474, #1500, #1550) and had merely never been submitted.
 * Every memory note was true when written — seat memory has no revision path, and the board
 * cannot know a merge nobody attested. The daemon has no git either (its cwd is its own
 * checkout, ADR 294/297 forbid a background sweep), so the check runs where `lane_submit`'s
 * merge verification already runs: seat-side, at render time, against the seat's own repo.
 *
 * Two recorded facts, either of which is enough:
 *
 *   1. A commit on `origin/main` newer than the claim cites the lane id. Squash bodies cite the
 *      SHORT id (`01M2NWVH4G`), never the full ULID — #1500 is findable by prefix only.
 *   2. The lane names a branch that was pushed (tracks its own name on origin) and is now gone.
 *      GitHub auto-deletes the remote branch on merge (ADR 106); a pushed branch that vanished
 *      without merging is the rare case, and the line says which fact it rests on so a reader
 *      can doubt it.
 *
 * Absent evidence says nothing: the line is omitted, never "not landed" — a stale ref cannot
 * prove a negative (same posture as `verifyMerge`).
 */
import { execFile } from 'node:child_process';
import type { Lane } from '@musterd/protocol';

export type GitRun = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

export const defaultGitRun: GitRun = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) });
    });
  });

/** The id length squash bodies cite — `Lane 01M2NWVH4G`, `Lane \`01M2PAP0AD\`` (measured on main). */
export const SHORT_LANE_ID = 10;

export interface Landed {
  /** What on main says the work is there — a SHA and subject, or the branch that auto-deleted. */
  evidence: string;
}

/**
 * For each lane, the landing evidence this repo holds, or nothing. Never throws: a seat with no
 * git, no remote, or a timed-out fetch gets the brief it always got.
 */
export async function reconcileLanded(
  lanes: readonly Lane[],
  opts: { cwd: string; run?: GitRun; timeoutMs?: number },
): Promise<Map<string, Landed>> {
  const out = new Map<string, Landed>();
  if (lanes.length === 0) return out;
  const run = opts.run ?? defaultGitRun;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const git = async (args: string[]): Promise<{ code: number; stdout: string } | null> => {
    try {
      return await run(args, { cwd: opts.cwd, timeoutMs });
    } catch {
      return null;
    }
  };
  // One fetch for the batch. A stale origin/main can only UNDER-report (history grows), so a
  // failed fetch degrades to "what this repo already knows", never to a wrong positive.
  await git(['fetch', '--quiet', 'origin', 'main']);

  for (const lane of lanes) {
    // Already attested: the seat submitted. Nothing to reconcile.
    if (lane.merged?.sha !== undefined) continue;
    const cited = await citedOnMain(lane, git);
    if (cited) {
      out.set(lane.id, { evidence: cited });
      continue;
    }
    const gone = await branchGone(lane, git);
    if (gone) out.set(lane.id, { evidence: gone });
  }
  return out;
}

type Git = (args: string[]) => Promise<{ code: number; stdout: string } | null>;

/**
 * How a landing commit declares its lane, measured on main 2026-09-19: the squash body opens
 * with `Lane \`01M2NWVH4G\`.` / `Lane: 01M2…` within its first lines (#1500 line 3, #1550 line 3),
 * or the subject carries `(lane 01M2…)` (#1552, #1556, #1560). A commit that merely MENTIONS a
 * lane does it mid-sentence — "declining lane 01M2RTF9F2" (#1568), "accepting lane \`01M2NWVH4G\`"
 * (#1578) — or deep in the body: #1578 line 47 opens "Lane \`01M2XAXRP3\` is open and unowned",
 * about a lane it did not land. A first live probe took both for landings; the declaration
 * shape is what separates them, so the match is case-sensitive, line-anchored, and early.
 */
export const DECLARATION_LINES = 5;

/** Split `git log --format=%H%x00%s%x00%b%x1e` output into commits. */
export function parseLog(stdout: string): { sha: string; subject: string; body: string }[] {
  return stdout
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [sha = '', subject = '', body = ''] = rec.split('\0');
      return { sha, subject, body };
    });
}

/** Does this commit DECLARE the lane (not merely mention it)? */
export function declaresLane(
  c: { subject: string; body: string },
  shortId: string,
): boolean {
  const id = shortId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\(lane \`?${id}`).test(c.subject)) return true;
  const head = new RegExp(`^Lane:? \`?${id}`);
  return c.body
    .split('\n')
    .slice(0, DECLARATION_LINES)
    .some((line) => head.test(line));
}

async function citedOnMain(lane: Lane, git: Git): Promise<string | null> {
  const since = lane.claimed_at ?? lane.created_at;
  const short = lane.id.slice(0, SHORT_LANE_ID);
  const r = await git([
    'log',
    'origin/main',
    '--format=%H%x00%s%x00%b%x1e',
    '-i',
    `--grep=${short}`,
    `--since=${new Date(since).toISOString()}`,
  ]);
  if (!r || r.code !== 0) return null;
  // Oldest first: the landing is the FIRST declaration, later commits are corrections about it.
  const hit = parseLog(r.stdout)
    .reverse()
    .find((c) => declaresLane(c, short));
  return hit ? `main cites it: ${hit.sha.slice(0, 8)} ${hit.subject}` : null;
}

async function branchGone(lane: Lane, git: Git): Promise<string | null> {
  const branch = lane.branch;
  if (!branch) return null;
  // Pushed once: the branch tracks ITS OWN NAME on origin (`push -u` sets branch.<b>.merge to
  // refs/heads/<b>). Not merely "has a remote" — `git checkout -b <b> origin/main` (ADR 106 step
  // 1) configures origin/main as upstream before anything is pushed, and the first live probe
  // called this seat's own unpushed branch "gone from origin" on that.
  const upstream = await git(['config', '--get', `branch.${branch}.merge`]);
  if (!upstream || upstream.code !== 0 || upstream.stdout.trim() !== `refs/heads/${branch}`) {
    return null;
  }
  const remote = await git(['ls-remote', '--heads', 'origin', branch]);
  if (!remote || remote.code !== 0) return null;
  if (remote.stdout.trim() !== '') return null;
  return `branch ${branch} was pushed and is gone from origin (auto-deleted on merge)`;
}
