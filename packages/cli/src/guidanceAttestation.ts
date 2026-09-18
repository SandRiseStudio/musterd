import { installedGuidanceEpoch } from '@musterd/protocol';

/**
 * The guidance epoch to attest for a workspace (ADR 417) — the stamp in the files installed there.
 * A thin cwd-defaulting wrapper over the protocol reader, which owns the path list so that the CLI
 * and the MCP adapter cannot report different epochs for the same folder.
 *
 * **Deliberately not memoised**, unlike `cliBuild()`. A dist stamp cannot change under a running
 * process, so caching it is free; guidance files demonstrably can — `musterd init
 * --refresh-guidance` and ADR 408 self-heal both rewrite them mid-session, and a seat whose session
 * outlives the rule it started under is the exact defect this attestation exists to make visible.
 * A cached value would make the heartbeat a slower copy of the claim.
 *
 * `undefined` for an unprovisioned or unstamped folder, which omits the field rather than guessing
 * (ADR 135).
 */
export function workspaceGuidanceEpoch(dir: string = process.cwd()): number | undefined {
  return installedGuidanceEpoch(dir);
}
