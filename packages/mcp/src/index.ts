#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bind } from './bind.js';
import { claimAndJoin, type ClaimTarget } from './claim.js';
import { MusterdClient } from './client.js';
import { isClaimedConfig, loadMcpConfig, type McpConfig } from './config.js';
import { writePendingMarker } from './pending.js';
import { registerInboxCheck } from './tools/inboxCheck.js';
import { registerJoin } from './tools/join.js';
import { registerLeave } from './tools/leave.js';
import { registerMembers } from './tools/members.js';
import { registerSend } from './tools/send.js';
import { registerStatus } from './tools/status.js';

export { MusterdClient } from './client.js';
export { loadMcpConfig, type McpConfig } from './config.js';
export { bind } from './bind.js';
export { resolveWorkspace, resolveProvenance } from './workspace.js';

/**
 * Drop presence and exit on every way the host can go away. The WS socket keeps Node's event loop
 * alive, so without this the adapter outlives its session and leaves the member stuck "online" until
 * a reaper sweep that can't help (the socket is still attached). The canonical stdio-server shutdown
 * signal is the host closing our stdin; signals and transport close are belt-and-suspenders for hosts
 * that SIGTERM or just drop the pipe. Idempotent — many signals can race for the same teardown.
 * Returns a cleanup that removes the listeners (used by tests; the real process just exits).
 */
export function installShutdownHandlers(opts: {
  close: () => void;
  transport: { onclose?: (() => void) | undefined };
  exit?: (code: number) => void;
  signals?: NodeJS.Process;
  stdin?: {
    on(event: 'end' | 'close', cb: () => void): unknown;
    off?: (event: string, cb: () => void) => unknown;
  };
}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const proc = opts.signals ?? process;
  const stdin = opts.stdin ?? process.stdin;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.close();
    exit(0);
  };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of sigs) proc.on(sig, shutdown);
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  const priorOnClose = opts.transport.onclose;
  opts.transport.onclose = () => {
    priorOnClose?.();
    shutdown();
  };
  return () => {
    for (const sig of sigs) proc.removeListener(sig, shutdown);
    stdin.off?.('end', shutdown);
    stdin.off?.('close', shutdown);
  };
}

/** Build (but do not connect) the MCP server with the musterd tools registered. */
export function buildMcpServer(
  client: MusterdClient,
  config: ReturnType<typeof loadMcpConfig>,
): McpServer {
  const server = new McpServer({ name: 'musterd', version: '0.0.1' });
  registerJoin(server, client, config);
  registerLeave(server, client, config);
  registerSend(server, client, config);
  registerInboxCheck(server, client);
  registerStatus(server, client);
  registerMembers(server, client);
  return server;
}

/**
 * Launch-time autojoin (claim-on-first-use, ADR 032). Fires ⇔ a default claim exists: a session with
 * a concrete identity just `join()`s (today's `MUSTERD_AUTOJOIN=1` path); a pending session with a
 * `seat`/`role` folder policy auto-claims that seat and occupies it. A `chat` policy never
 * auto-claims — the session stays a pending presence until a human names it. Best-effort: a failure
 * is reported to stderr and leaves the session pending/dormant rather than crashing the adapter.
 */
export async function autojoin(client: MusterdClient, config: McpConfig): Promise<void> {
  try {
    if (isClaimedConfig(config)) {
      if (process.env['MUSTERD_AUTOJOIN'] === '1') await client.join();
      return;
    }
    const target: ClaimTarget | null =
      config.claim.mode === 'seat'
        ? { seat: config.claim.name }
        : config.claim.mode === 'role'
          ? { role: config.claim.role }
          : null;
    if (target) await claimAndJoin(client, config, target);
  } catch (err) {
    process.stderr.write(`musterd autojoin failed: ${(err as Error).message}\n`);
  }
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const client = new MusterdClient(config);
  await bind(client); // dormant: reachability only, no presence claimed
  // A session that starts unclaimed is a pending presence — drop a marker so `musterd claim` can
  // find it (ADR 033). Best-effort; removed once the session claims a seat.
  if (!isClaimedConfig(config)) writePendingMarker(config);
  const server = buildMcpServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await autojoin(client, config);

  installShutdownHandlers({ close: () => client.close(), transport });
}

// Run only when invoked directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`musterd MCP failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
