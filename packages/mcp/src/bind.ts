import type { MusterdClient } from './client.js';

/**
 * Bootstrap the session's binding to its Member: verify the server is reachable,
 * register presence (online), and open the background WS so live deliveries buffer.
 * 05-mcp.md: registering this MCP server in a harness == that agent becomes the Member.
 */
export async function bind(client: MusterdClient): Promise<void> {
  await client.health();
  await client.registerPresence();
  client.connect();
}
