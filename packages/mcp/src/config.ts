import {
  parseClaimPolicy,
  SURFACES,
  type ClaimPolicy,
  type Provenance,
  type Surface,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { findBinding, findWorkspaceSpec } from './binding.js';
import { resolveDriver, resolveProvenance, resolveWorkspace } from './workspace.js';

export interface McpConfig {
  server: string;
  team: string;
  /**
   * v0.3 (ADR 075): the team **agent key** (`mskey_`) or human credential this session authenticates
   * with — the Bearer secret + what the `claim` frame presents. From `MUSTERD_AGENT_KEY` / the binding.
   */
  agent_key?: string | undefined;
  /**
   * The **resolved** seat, once this session has occupied one (set from the `occupied` frame). A session
   * starts unclaimed (undefined ⇒ pending presence: reachable, holding no seat) and fills this in when it
   * claims (`team_join` / an external `musterd claim`); a role pool resolves its `<role>-<n>` here.
   */
  member?: string | undefined;
  /** Optional pre-issued grant (`msgr_`) that skips the pending/admin-approval lane (ADR 075). */
  grant?: string | undefined;
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
 *
 * Committed launch spec (ADR: committed launch spec): for the **non-secret** fields (server, team,
 * surface, claim) the ladder is `env > binding.json > workspace.json`. The committed `workspace.json`
 * is the lowest-precedence base, so a fresh clone whose only musterd file is that spec (plus an
 * env-supplied `MUSTERD_AGENT_KEY`) still resolves its identity. Secrets (`agent_key`, `grant`) are
 * **never** read from the spec — only env or the gitignored binding.json.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const binding = findBinding(process.cwd(), env);
  const spec = findWorkspaceSpec(process.cwd(), env);
  const server =
    env['MUSTERD_SERVER'] ?? binding?.server ?? spec?.server ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'] ?? binding?.team ?? spec?.team;
  // v0.3 (ADR 075): the auth secret is the team agent key; the seat is resolved at claim time (the
  // `occupied` frame), so `member` starts undefined — the target lives in the claim policy below.
  // agent_key/grant are secrets → env or binding.json only, NEVER the committed spec.
  const agentKey = env['MUSTERD_AGENT_KEY'] ?? binding?.agent_key;
  const grant = env['MUSTERD_GRANT'] ?? binding?.grant;
  const surfaceRaw = env['MUSTERD_SURFACE'] ?? binding?.surface ?? spec?.surface ?? 'other';
  if (!team) {
    throw new Error('musterd MCP: no team — set MUSTERD_TEAM or provide a .musterd/binding.json');
  }
  const surface = (SURFACES as readonly string[]).includes(surfaceRaw)
    ? (surfaceRaw as Surface)
    : 'other';
  // Claim policy: env wins (the ADR 018 ladder), else binding.json, else the committed spec, else chat.
  const claim: ClaimPolicy =
    env['MUSTERD_CLAIM'] !== undefined
      ? parseClaimPolicy(env['MUSTERD_CLAIM'])
      : (binding?.claim ?? spec?.claim ?? { mode: 'chat' });
  return {
    server,
    team,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
    surface,
    provenance: resolveProvenance(env),
    workspace: resolveWorkspace(env),
    driver: resolveDriver(env),
    claim,
    connId: ulid(),
    claimCode: shortCode(),
  };
}

/** Does this session already hold a seat (it has occupied one — the resolved `member` is set)? */
export function isClaimedConfig(config: McpConfig): boolean {
  return Boolean(config.member);
}
