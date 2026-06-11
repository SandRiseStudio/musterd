#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MusterdClient } from './client.js';
import { loadMcpConfig } from './config.js';
import { bind } from './bind.js';
import { registerSend } from './tools/send.js';
import { registerInboxCheck } from './tools/inboxCheck.js';
import { registerStatus } from './tools/status.js';
import { registerMembers } from './tools/members.js';
import { registerJoin } from './tools/join.js';
import { registerLeave } from './tools/leave.js';

export { MusterdClient } from './client.js';
export { loadMcpConfig, type McpConfig } from './config.js';
export { bind } from './bind.js';

/** Build (but do not connect) the MCP server with the musterd tools registered. */
export function buildMcpServer(client: MusterdClient, config: ReturnType<typeof loadMcpConfig>): McpServer {
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
    await client.join().catch((err) =>
      process.stderr.write(`musterd autojoin failed: ${(err as Error).message}\n`),
    );
  }
  process.on('SIGINT', () => {
    client.close();
    process.exit(0);
  });
}

// Run only when invoked directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`musterd MCP failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
