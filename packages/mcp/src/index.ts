#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bind } from './bind.js';
import { MusterdClient } from './client.js';
import { loadMcpConfig } from './config.js';
import { registerInboxCheck } from './tools/inboxCheck.js';
import { registerJoin } from './tools/join.js';
import { registerLeave } from './tools/leave.js';
import { registerMembers } from './tools/members.js';
import { registerSend } from './tools/send.js';
import { registerStatus } from './tools/status.js';

export { MusterdClient } from './client.js';
export { loadMcpConfig, type McpConfig } from './config.js';
export { bind } from './bind.js';

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

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const client = new MusterdClient(config);
  await bind(client); // dormant: reachability only, no presence claimed
  const server = buildMcpServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Opt-in one-keystroke activation; off by default so a session never silently occupies a seat.
  if (process.env['MUSTERD_AUTOJOIN'] === '1') {
    await client
      .join()
      .catch((err) => process.stderr.write(`musterd autojoin failed: ${(err as Error).message}\n`));
  }

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
