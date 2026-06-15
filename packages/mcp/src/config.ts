import { SURFACES, type Provenance, type Surface } from '@musterd/protocol';
import { resolveProvenance, resolveWorkspace } from './workspace.js';

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
}

/** Read + validate the MCP server's identity binding from env (05-mcp.md). */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const server = env['MUSTERD_SERVER'] ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'];
  const member = env['MUSTERD_MEMBER'];
  const token = env['MUSTERD_TOKEN'];
  const surfaceRaw = env['MUSTERD_SURFACE'] ?? 'other';
  const missing: string[] = [];
  if (!team) missing.push('MUSTERD_TEAM');
  if (!member) missing.push('MUSTERD_MEMBER');
  if (!token) missing.push('MUSTERD_TOKEN');
  if (missing.length) {
    throw new Error(`musterd MCP: missing required env: ${missing.join(', ')}`);
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
  };
}
