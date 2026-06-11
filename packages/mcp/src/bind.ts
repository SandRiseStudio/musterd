import type { MusterdClient } from './client.js';

/**
 * Verify the team server is reachable. Dormant by default (M3 / ADR 007): registering this MCP
 * server in a harness makes the musterd tools *available*, it does not occupy the member's seat.
 * A session claims presence only by calling `team_join` (or via `MUSTERD_AUTOJOIN=1`).
 */
export async function bind(client: MusterdClient): Promise<void> {
  await client.health();
}
