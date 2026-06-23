import {
  parseClaimPolicy,
  SURFACES,
  type ClaimPolicy,
  type Provenance,
  type Surface,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { findBinding } from './binding.js';
import { resolveDriver, resolveProvenance, resolveWorkspace } from './workspace.js';

export interface McpConfig {
  server: string;
  team: string;
  /**
   * The claimed seat, once this session holds one. Claim-on-first-use (ADR 032): a session may start
   * **unclaimed** (no identity) and fill these in when it first claims a seat (`team_join` / an
   * external `musterd claim`). Undefined ⇒ pending presence: reachable, holding no seat.
   */
  member?: string | undefined;
  token?: string | undefined;
  surface: Surface;
  /** Why this session attaches (provenance/where seed, ADR 014). Defaults to `session`. */
  provenance: Provenance;
  /** The gracefully-degrading "where" label, resolved once at load. */
  workspace: string;
  /** The human driving this session, if one is (driver co-presence, ADR 021). */
  driver?: string | undefined;
  /** Folder claim policy (ADR 018 ladder) — what `team_join {}` / autojoin does by default. */
  claim: ClaimPolicy;
  /** Per-session connection id (the pending-presence key tuple, ADR 033). */
  connId: string;
  /** Short, human-typable disambiguation code for `musterd claim --for <code>` (ADR 033). */
  claimCode: string;
}

/** A short, human-typable code (uppercase) derived from a fresh ulid — for `musterd claim --for`. */
function shortCode(): string {
  return ulid().slice(-4).toUpperCase();
}

/**
 * Read + validate the MCP server's identity binding (05-mcp.md). Aligned with the CLI (ADR 018):
 * `MUSTERD_*` env wins (the host-injection contract / hosted setups with no writable fs), then the
 * workspace `.musterd/binding.json` — the same file the CLI reads, so the two can't drift.
 *
 * Claim-on-first-use (ADR 032): identity is now **optional**. A binding may carry only a claim
 * policy; the session then starts as a pending presence and claims a seat on first use. Only the
 * team (and server) are required to load.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const binding = findBinding(process.cwd(), env);
  const server = env['MUSTERD_SERVER'] ?? binding?.server ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'] ?? binding?.team;
  const member = env['MUSTERD_MEMBER'] ?? binding?.member;
  const token = env['MUSTERD_TOKEN'] ?? binding?.token;
  const surfaceRaw = env['MUSTERD_SURFACE'] ?? binding?.surface ?? 'other';
  if (!team) {
    throw new Error('musterd MCP: no team — set MUSTERD_TEAM or provide a .musterd/binding.json');
  }
  const surface = (SURFACES as readonly string[]).includes(surfaceRaw)
    ? (surfaceRaw as Surface)
    : 'other';
  // Claim policy: env wins (the ADR 018 ladder), else the binding's stored policy, else assign-in-chat.
  const claim: ClaimPolicy =
    env['MUSTERD_CLAIM'] !== undefined
      ? parseClaimPolicy(env['MUSTERD_CLAIM'])
      : (binding?.claim ?? { mode: 'chat' });
  return {
    server,
    team,
    member,
    token,
    surface,
    provenance: resolveProvenance(env),
    workspace: resolveWorkspace(env),
    driver: resolveDriver(env),
    claim,
    connId: ulid(),
    claimCode: shortCode(),
  };
}

/** Does this session already hold a seat (a concrete member + token)? */
export function isClaimedConfig(config: McpConfig): boolean {
  return Boolean(config.member && config.token);
}
