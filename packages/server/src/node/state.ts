import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * This machine's node credentials (ADR 328 §2) — one entry per enrolled team, in
 * `~/.musterd/node.json` at mode 0600. Never a workspace, never the repo.
 *
 * **The daemon owns this file.** `musterd node join` asks its own daemon to enroll rather than
 * calling the hub itself, so the process holding the `nodes` row whose id gets presented is also
 * the one that holds the credential and writes it down. A CLI writing here behind the daemon would
 * put two processes on one piece of machine-local state — the drift ADR 131's three-stores table
 * exists to prevent.
 *
 * **Keyed by team slug, while the database keys by `team_id`** (miley, 2026-08-27). Accepted rather
 * than accidental: the slug is what the operator types and what the hub URL carries, so a file the
 * human may have to read should name teams the way the human does. The cost is that renaming a team
 * orphans its entry — the credential is still valid on the hub, but this daemon stops finding it and
 * the machine must enroll again. Cheap to repair, and re-enrollment is already the recovery path for
 * every other way this file can go wrong.
 *
 * The path override follows `config.ts`'s established pattern (`env[...] ?? ~/.musterd/...`) rather
 * than the CLI's `machineStatePath`, keeping the daemon decoupled from the CLI package while
 * sharing the `~/.musterd/` home the db already lives in. `MUSTERD_NODE_STATE` is pinned by the
 * ADR 190 vitest setup, so the suite cannot write the operator's real credentials.
 */

const NodeEnrollmentSchema = z.object({
  hub_url: z.string(),
  node_id: z.string(),
  credential: z.string(),
  enrolled_at: z.number().int(),
});
export type NodeEnrollment = z.infer<typeof NodeEnrollmentSchema>;

const NodeStateSchema = z.object({ nodes: z.record(NodeEnrollmentSchema).default({}) });
export type NodeState = z.infer<typeof NodeStateSchema>;

export function nodeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['MUSTERD_NODE_STATE'] ?? join(homedir(), '.musterd', 'node.json');
}

/**
 * Best-effort by construction: absent, unreadable, or malformed all read as "no enrollments" rather
 * than throwing. A machine that has never enrolled is an ordinary machine, and the caller's remedy
 * is the same for every cause — enroll.
 */
export function readNodeState(env: NodeJS.ProcessEnv = process.env): NodeState {
  try {
    return NodeStateSchema.parse(JSON.parse(readFileSync(nodeStatePath(env), 'utf8')));
  } catch {
    return { nodes: {} };
  }
}

/** Record one team's enrollment, replacing any previous entry for that team and leaving the rest. */
export function saveNodeEnrollment(
  entry: { team: string } & NodeEnrollment,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { team, ...rest } = entry;
  const state = readNodeState(env);
  state.nodes[team] = rest;

  const path = nodeStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is CREATED. An existing node.json keeps
  // whatever permissions it had, so without this an file first written 0644 — by an older build, or
  // a hand edit — would stay world-readable through every later write.
  chmodSync(path, 0o600);
}
