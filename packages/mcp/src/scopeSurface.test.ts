import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GENERALIST_CAPABILITIES, type Capabilities } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { WRITE_TOOLS } from './scope.js';
import { TOOL_NAMES } from './toolNames.js';
import { buildMcpServer } from './index.js';

/**
 * Scope-by-role end to end (ADR 144 inc 5): what a harness actually receives from `tools/list`.
 * `scope.test.ts` pins the pure projection; this pins that `buildMcpServer` honours it through the
 * real SDK — the registration seam is a monkey-patch, so only a real listing proves it took.
 */

const fakeClient = { member: 'Ada' } as unknown as MusterdClient;

function configWith(capabilities?: Capabilities): McpConfig {
  return {
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    agent_key: 'mskey_unused',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: process.cwd(),
    ...(capabilities ? { capabilities } : {}),
  } as McpConfig;
}

async function listToolsFor(capabilities?: Capabilities) {
  const mcp = buildMcpServer(fakeClient, configWith(capabilities), {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'scope-harness', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  try {
    const { tools } = await harness.listTools();
    const bytes = tools.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t), 'utf8'), 0);
    return { names: tools.map((t) => t.name), bytes };
  } finally {
    await harness.close();
    await mcp.close();
  }
}

const muted: Capabilities = { ...GENERALIST_CAPABILITIES, can_message: 'none' };

describe('rendered surface is scoped by capability (ADR 144 inc 5)', () => {
  it('a generalist seat still receives every tool — no regression for an un-governed team', async () => {
    const { names } = await listToolsFor(GENERALIST_CAPABILITIES);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('a seat with no cached capabilities receives every tool (fail-open at the wire)', async () => {
    const { names } = await listToolsFor(undefined);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('a muted observer never receives an acting tool, and keeps what it needs to watch', async () => {
    const { names } = await listToolsFor(muted);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(names).toEqual(
      expect.arrayContaining(['team_status', 'lane_board', 'team_report', 'team_join']),
    );
  });

  it('calling a scoped-out tool fails as unknown — it does not exist for this seat', async () => {
    const mcp = buildMcpServer(fakeClient, configWith(muted), {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'scope-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    try {
      // Not "forbidden" — absent. The daemon is still the thing that enforces `can_message`; the
      // render just stopped advertising a tool whose every use would bounce there.
      await expect(
        harness.callTool({ name: 'team_send', arguments: { act: 'status_update', body: 'x' } }),
      ).rejects.toThrow(/team_send/);
    } finally {
      await harness.close();
      await mcp.close();
    }
  });

  it('scoping cuts the majority of the surface bytes — the increment-5 headline', async () => {
    const full = await listToolsFor(GENERALIST_CAPABILITIES);
    const scoped = await listToolsFor(muted);
    // Measured 2026-07-31 on the live build: 12,898 B full vs ~3,022 B scoped (77% cut). Asserting
    // "more than half" rather than the exact figure keeps this honest as descriptions evolve — the
    // exact bytes are attested per-session by the ADR 144 inc 1 `SurfaceRender` telemetry.
    expect(scoped.bytes).toBeLessThan(full.bytes / 2);
    expect(scoped.names.length).toBeLessThan(full.names.length);
  });
});
