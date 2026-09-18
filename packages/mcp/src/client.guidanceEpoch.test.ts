import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderContentStamp } from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { MusterdClient } from './client.js';

/*
 * ADR 417: a seat attests the guidance epoch it is RUNNING, and on this machine seats claim through
 * the MCP adapter, not the CLI. If the epoch rode only the CLI's `buildClaimFrame`, every
 * `team_join` would attest nothing and the census this increment exists to enable would be empty
 * exactly where it matters most.
 */

let wss: WebSocketServer | null = null;

afterEach(() => {
  wss?.close();
  wss = null;
});

function workspaceAt(version: number | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-epoch-'));
  if (version !== null) {
    const abs = join(dir, '.musterd/skill/SKILL.md');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# skill\n\nbody\n${renderContentStamp(version, 'a'.repeat(16))}\n`, 'utf8');
  }
  return dir;
}

/** Stand up a WS server that captures the first frame the client sends, then never answers. */
async function captureClaimFrom(workspace: string): Promise<Record<string, unknown>> {
  const server = new WebSocketServer({ port: 0 });
  wss = server;
  await new Promise<void>((r) => server.on('listening', () => r()));
  const claimed = new Promise<Record<string, unknown>>((resolve) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    });
  });
  const { port } = server.address() as { port: number };
  const client = new MusterdClient({
    server: `http://127.0.0.1:${port}`,
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'musterd',
    provenance: 'session',
    workspace,
    claim: { mode: 'seat', name: 'Ada' },
  } as never);
  void client.join(2000).catch(() => undefined);
  const frame = await claimed;
  client.close();
  return frame;
}

describe('the MCP claim attests the workspace guidance epoch (ADR 417)', () => {
  it('carries the stamp the claiming workspace is running', async () => {
    const frame = await captureClaimFrom(workspaceAt(23));
    expect(frame['guidance_epoch']).toBe(23);
  });

  it('omits it entirely for a workspace carrying no guidance — absent, never 0', async () => {
    const frame = await captureClaimFrom(workspaceAt(null));
    expect('guidance_epoch' in frame).toBe(false);
  });
});
