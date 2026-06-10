import { fileURLToPath } from 'node:url';
import type { Surface } from '@musterd/protocol';

/** A stdio MCP server entry: how a harness should launch the musterd adapter. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentBinding {
  server: string;
  team: string;
  member: string;
  token: string;
  surface: Surface;
}

/** The env that binds an MCP session to a Member (05-mcp.md). */
export function buildMcpEnv(b: AgentBinding): Record<string, string> {
  return {
    MUSTERD_SERVER: b.server,
    MUSTERD_TEAM: b.team,
    MUSTERD_MEMBER: b.member,
    MUSTERD_TOKEN: b.token,
    MUSTERD_SURFACE: b.surface,
  };
}

/**
 * Resolve how to launch the @musterd/mcp adapter on this machine.
 * Prefers the installed package's entry (works for both `pnpm add -g musterd`
 * and the monorepo); falls back to a sibling-package path in dev.
 */
export function resolveMcpLaunch(): { command: string; args: string[] } {
  try {
    // import.meta.resolve is sync + stable on Node 20+; returns a file:// URL.
    const url = import.meta.resolve('@musterd/mcp');
    return { command: process.execPath, args: [fileURLToPath(url)] };
  } catch {
    // Dev fallback: packages/cli/dist/onboard/ -> packages/mcp/dist/index.js
    const here = fileURLToPath(new URL('.', import.meta.url));
    const dev = new URL('../../../mcp/dist/index.js', `file://${here}`);
    return { command: process.execPath, args: [fileURLToPath(dev)] };
  }
}

export function buildEntry(b: AgentBinding): McpServerEntry {
  const launch = resolveMcpLaunch();
  return { command: launch.command, args: launch.args, env: buildMcpEnv(b) };
}
