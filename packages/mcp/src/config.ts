import { SURFACES, type Provenance, type Surface } from '@musterd/protocol';
import { findBinding } from './binding.js';
import { resolveDriver, resolveProvenance, resolveWorkspace } from './workspace.js';

export interface McpConfig {
  server: string;
  team: string;
  member: string;
  token: string;
  surface: Surface;
  /** Why this session attaches (provenance/where seed, ADR 014). Defaults to `session`. */
  provenance: Provenance;
  /** The gracefully-degrading "where" label, resolved once at load. */
  workspace: string;
  /** The human driving this session, if one is (driver co-presence, ADR 021). */
  driver?: string | undefined;
}

/**
 * Read + validate the MCP server's identity binding (05-mcp.md). Aligned with the CLI (ADR 018):
 * `MUSTERD_*` env wins (the host-injection contract / hosted setups with no writable fs), then the
 * workspace `.musterd/binding.json` — the same file the CLI reads, so the two can't drift.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const binding = findBinding(process.cwd(), env);
  const server = env['MUSTERD_SERVER'] ?? binding?.server ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'] ?? binding?.team;
  const member = env['MUSTERD_MEMBER'] ?? binding?.member;
  const token = env['MUSTERD_TOKEN'] ?? binding?.token;
  const surfaceRaw = env['MUSTERD_SURFACE'] ?? binding?.surface ?? 'other';
  const missing: string[] = [];
  if (!team) missing.push('MUSTERD_TEAM');
  if (!member) missing.push('MUSTERD_MEMBER');
  if (!token) missing.push('MUSTERD_TOKEN');
  if (missing.length) {
    throw new Error(
      `musterd MCP: no identity — set ${missing.join(', ')} or provide a .musterd/binding.json`,
    );
  }
  const surface = (SURFACES as readonly string[]).includes(surfaceRaw)
    ? (surfaceRaw as Surface)
    : 'other';
  return {
    server,
    team: team!,
    member: member!,
    token: token!,
    surface,
    provenance: resolveProvenance(env),
    workspace: resolveWorkspace(env),
    driver: resolveDriver(env),
  };
}
