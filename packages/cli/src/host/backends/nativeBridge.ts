import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { autojoin, buildMcpServer, MusterdClient, type McpConfig } from '@musterd/mcp';
import { FEATURE_EPOCH, type AttestationSource, type Binding } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { EngineTool } from '../engine.js';

/**
 * The native backend's tool surface (ADR 251 §4): connect to the daemon as an MCP client using the
 * seat's binding and bridge the rendered `team_*`/`lane_*` tools into engine tools 1:1. The server
 * half is musterd's own adapter (`buildMcpServer`) stood up IN-PROCESS over an `InMemoryTransport`
 * — no subprocess, no stdio — which buys, for free: the ADR 144 scope-by-role render, ADR 101/135
 * attestation on the connection, ADR 108 autojoin armed on the first tool call, and zero drift
 * between what a native seat and any other seat can do. The engine never knows it is talking to
 * musterd; this bridge does.
 */

/** The slice of the MCP client the bridge consumes — structural, so tests can fake it. */
export interface BridgeClient {
  listTools(): Promise<{
    tools: {
      name: string;
      description?: string | undefined;
      inputSchema: Record<string, unknown>;
    }[];
  }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content?: unknown }>;
  close(): Promise<void>;
}

/** Flatten an MCP tool result's content into the string the engine feeds back to the model:
 *  text blocks verbatim (joined), anything else stringified rather than dropped. */
export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(block);
    })
    .join('\n');
}

/** Bridge every rendered tool 1:1 into the engine's shape. Generic over any MCP server on
 *  purpose — the mapping carries no musterd knowledge. */
export async function bridgeTools(
  client: Pick<BridgeClient, 'listTools' | 'callTool'>,
): Promise<EngineTool[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,
    run: async (input: unknown) => {
      const result = await client.callTool({
        name: t.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
      return contentToText(result.content);
    },
  }));
}

/**
 * The adapter config for a native occupancy — the same shape `loadMcpConfig` derives from a
 * workspace, constructed directly because the host is not IN the workspace (cwd-anchored loading
 * would read the wrong folder, the ADR 143 lesson). The wake order's server/team win over the
 * binding's (a drifted binding must not redirect the occupancy); the secrets and autojoin posture
 * come from the binding, exactly as a spawned harness would resolve them.
 */
export function nativeMcpConfig(opts: {
  binding: Binding;
  server: string;
  team: string;
  seat: string;
  workspace: string;
  /** The workspace's stable identity (ADR 365) — the work tree root behind `workspace`, which is a
   *  display label. Displacement compares this, so a native seat must send it like any other
   *  session; defaults to the workspace dir this bridge was pointed at. */
  workspaceKey?: string;
  leaseId: string;
  model: string | undefined;
  modelSource: AttestationSource;
}): McpConfig {
  return {
    server: opts.server,
    team: opts.team,
    ...(opts.binding.agent_key !== undefined ? { agent_key: opts.binding.agent_key } : {}),
    ...(opts.binding.grant !== undefined ? { grant: opts.binding.grant } : {}),
    surface: 'musterd',
    markerGeneration: 'native',
    provenance: 'wake',
    wakeLease: opts.leaseId,
    workspace: opts.workspace,
    workspaceKey: opts.workspaceKey ?? opts.workspace,
    ...(opts.binding.driver !== undefined ? { driver: opts.binding.driver } : {}),
    autojoin: opts.binding.autojoin ?? false,
    ...(opts.binding.capabilities ? { capabilities: opts.binding.capabilities } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    modelSource: opts.modelSource,
    epoch: FEATURE_EPOCH,
    claim: { mode: 'seat', name: opts.seat },
    connId: ulid(),
    claimCode: ulid().slice(-6),
    bindingDir: opts.workspace,
  };
}

export interface NativeBridge {
  tools: EngineTool[];
  close(): Promise<void>;
}

/**
 * Stand the full in-process bridge up: adapter server + linked in-memory client, autojoin armed on
 * the first tool call (ADR 108 — occupancy stays a side effect of the agent working; the host
 * never claims on its behalf).
 */
export async function openNativeBridge(config: McpConfig): Promise<NativeBridge> {
  const musterd = new MusterdClient(config);
  const mcp = buildMcpServer(musterd, config, {
    onFirstToolCall: () => autojoin(musterd, config),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'musterd-native', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  const tools = await bridgeTools(harness);
  return {
    tools,
    close: async () => {
      // Ordered teardown: transport first, then the presence-holding client — `close()` drops
      // presence and stops the reconnect loop, so a settled run never leaves a zombie occupancy.
      await harness.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      musterd.close();
    },
  };
}
