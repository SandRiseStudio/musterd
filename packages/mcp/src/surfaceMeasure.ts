import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Capabilities, SurfaceRender } from '@musterd/protocol';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { buildMcpServer } from './index.js';

/**
 * Measure what a seat's `tools/list` actually weighs, from the exact listing a harness receives —
 * an in-memory `buildMcpServer` connect, no daemon. One measurement, two consumers:
 * `scopeSurface.test.ts` (scope-by-role pins, ADR 144 inc 5) and the standing-context budget gate
 * (`pnpm context:check`, spec 2026-08-03). The byte formula is `computeSurface`'s
 * (`toolTelemetry.ts`), so the budget and the inc-1 telemetry attestation can never disagree.
 */
export async function measureToolSurface(capabilities?: Capabilities): Promise<SurfaceRender> {
  const fakeClient = { member: 'Ada' } as unknown as MusterdClient;
  const config = {
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    agent_key: 'mskey_unused',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    // Inert by construction, and worth saying why: ADR 275 has `refreshAttestation` rewrite
    // `config.surface` from the binding found at `bindingDir ?? process.cwd()`, which is how a
    // fixture ends up measuring the harness of whichever seat worktree ran it (#863, #871). It
    // cannot happen here — the only caller is `MusterdClient.refreshObservedModel` on the heartbeat
    // tick, and `fakeClient` above never joins or ticks. So the declared `claude-code` stands
    // everywhere and the byte count is the same on any machine.
    //
    // Keep it that way. This is the one site in that inventory that is NOT a test: it backs
    // `pnpm context:check`, so a real client here would make a GATE read the developer's capture
    // rather than the code — machine-dependent CI, not a machine-dependent test. If this ever needs
    // a live client, anchor it at an empty temp dir instead of cwd.
    bindingDir: process.cwd(),
    ...(capabilities ? { capabilities } : {}),
  } as McpConfig;
  const mcp = buildMcpServer(fakeClient, config, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'surface-measure', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  try {
    const { tools } = await harness.listTools();
    const breakdown = tools.map((t) => ({
      tool: t.name.slice(0, 64),
      bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
      description_bytes: Buffer.byteLength(t.description ?? '', 'utf8'),
    }));
    const bytes = breakdown.reduce((n, b) => n + b.bytes, 0);
    return { tools: tools.length, bytes, est_tokens: Math.round(bytes / 4), breakdown };
  } finally {
    await harness.close();
    await mcp.close();
  }
}
