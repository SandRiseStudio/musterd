import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { BOUNCE_RE, classifyToolResult, methodOf, ToolCallRecorder } from './toolTelemetry.js';
import { ADAPTER_VERSION } from './version.js';
import { buildMcpServer } from './index.js';

/**
 * SDK-seam canaries (ADR 175). These tests pin the four monkey-patch seams — OTel spans, bounce
 * telemetry, repair hints, argument coercion (`index.ts` install order) — against the REAL SDK.
 * Every seam is defensive by design (an unrecognized schema or prose passes through untouched), so
 * an SDK bump that reshapes `setRequestHandler`, its request schemas, or its validation-error prose
 * makes them fail SILENTLY: telemetry, repair, and coercion just stop. **If this file fails after
 * an SDK bump, the seams detached — re-anchor them before shipping the bump.**
 *
 * The canary set also includes the daemon-backed e2e tests in `toolTelemetry.test.ts` ("tool-call
 * telemetry end-to-end"): bounce-classified-in-report, coercion-through-real-validation, and the
 * tools/list surface attestation. This file covers what those don't — the anchors themselves
 * (`methodOf`, `BOUNCE_RE`), the repair hint on a genuine SDK zod bounce, seam composition order,
 * and serverInfo — and runs daemon-free: a bounced call never reaches a handler, so no tool ever
 * touches the (fake) client.
 */

/** Never contacted: bounces stop in SDK validation / the coercion layer, ahead of any handler. */
const fakeClient = { member: 'Ada' } as unknown as MusterdClient;

const config: McpConfig = {
  server: 'http://127.0.0.1:1',
  team: 'dawn',
  agent_key: 'mskey_unused',
  surface: 'claude-code',
  provenance: 'session',
  workspace: 'repo',
  claim: { mode: 'seat', name: 'Ada' },
  bindingDir: process.cwd(),
} as McpConfig;

async function connect(recorder?: ToolCallRecorder) {
  const mcp = buildMcpServer(fakeClient, config, recorder ? { recorder } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'canary-harness', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  return {
    harness,
    close: async () => {
      await harness.close();
      await mcp.close();
    },
  };
}

function firstText(result: { content?: unknown }): string {
  const content = result.content as { type?: string; text?: unknown }[] | undefined;
  return content?.[0]?.type === 'text' ? String(content[0].text ?? '') : '';
}

describe('SDK seam canaries (ADR 175)', () => {
  it('methodOf reads the key the real SDK registers its tool handlers under', () => {
    // The single most likely silent-detach point: all three setRequestHandler patches key on this.
    // SDK v2 (spec 2026-07-28) keys handlers by method STRING — so the anchor is no longer a
    // request schema's `.shape.method.value` but the first argument the SDK's own registration
    // path actually passes. Drive the real registration (registerTool triggers it) through a spy
    // and assert methodOf resolves both tool methods from what genuinely arrived.
    const mcp = new McpServer({ name: 'canary', version: '0.0.0' });
    const inner = mcp.server as unknown as { setRequestHandler: (...args: unknown[]) => unknown };
    const original = inner.setRequestHandler.bind(mcp.server);
    const seen: unknown[] = [];
    inner.setRequestHandler = (...args: unknown[]) => {
      seen.push(args[0]);
      return original(...(args as Parameters<typeof original>));
    };
    mcp.registerTool('canary_tool', { description: 'x' }, () => ({ content: [] }));
    const methods = seen.map(methodOf);
    expect(methods).toContain('tools/call');
    expect(methods).toContain('tools/list');
  });

  it("the real SDK's validation-bounce prose still matches BOUNCE_RE", async () => {
    const { harness, close } = await connect();
    try {
      const bounced = await harness.callTool({
        name: 'team_send',
        arguments: { act: 'statusupdate', body: 'x' },
      });
      expect(bounced.isError).toBe(true);
      // The anchor itself, not a downstream count: if this fails, re-anchor BOUNCE_RE in BOTH
      // toolTelemetry.ts and repair.ts (they keep deliberate copies).
      expect(firstText(bounced)).toMatch(BOUNCE_RE);
    } finally {
      await close();
    }
  });

  it('a genuine SDK zod bounce carries the specific repair hint, exactly once', async () => {
    const { harness, close } = await connect();
    try {
      const bounced = await harness.callTool({
        name: 'team_send',
        arguments: { act: 'statusupdate', body: 'x' },
      });
      expect(bounced.isError).toBe(true);
      const text = firstText(bounced);
      // The one seam behavior with no other end-to-end coverage: repair.ts regenerates zod issues
      // by re-validating the bounced args against the tool's captured shape (SDK 1.30 dropped the
      // embedded issue JSON from its prose — the degradation this canary caught on day one). Fails
      // if the shape capture detaches OR a zod major renames the issue fields (zod 4:
      // invalid_enum_value→invalid_value, options→values — see repair.ts hintForIssue) — either
      // way the hint silently degrades to the generic line.
      expect(text).toContain('must be one of');
      expect(text).toContain("closest to what you sent is 'status_update'");
      expect(text.match(/\nrepair: /g)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('the three wrappers still compose: coercion bounces, repair defers, telemetry classifies', async () => {
    const recorder = new ToolCallRecorder();
    const { harness, close } = await connect(recorder);
    try {
      // An unknown key stops in the coercion layer (innermost) with its own specific repair line;
      // repair (middle) must not stack a generic second line under it; telemetry (outermost) must
      // still class the synthesized bounce as invalid_input. One call proves the install order in
      // index.ts survived the SDK bump.
      const stray = await harness.callTool({
        name: 'lane_update',
        arguments: { id: 'lane-1', surfase_globs: ['packages/web/**'] },
      });
      expect(stray.isError).toBe(true);
      const text = firstText(stray);
      expect(text).toContain('unrecognized argument key');
      expect(text.match(/\nrepair: /g)).toHaveLength(1);
      // Telemetry (outermost) classified the synthesized bounce: flush to a spy client and read
      // the recorded cell — no daemon, the flush's surface pass drives the SDK's own tools/list.
      const spy = { member: 'Ada', reportToolTelemetry: vi.fn().mockResolvedValue(undefined) };
      await recorder.flush(spy as unknown as MusterdClient);
      const report = spy.reportToolTelemetry.mock.calls[0]![0] as {
        events: { tool: string; outcome: string }[];
        surface?: { tools: number };
      };
      expect(report.events).toContainEqual(
        expect.objectContaining({ tool: 'lane_update', outcome: 'invalid_input' }),
      );
      // …and the tools/list capture (the other half of the telemetry seam) still renders.
      expect(report.surface?.tools).toBeGreaterThanOrEqual(20);
    } finally {
      await close();
    }
  });

  it('discover + tools/list from a fresh client never arms the autojoin (ADR 175 step 2 / ADR 108)', async () => {
    // A 2026-07-28 client's connect IS `server/discover` — the modern probe. The probe boundary
    // must hold exactly as it did for `initialize`: instructions/serverInfo served, no seat claimed
    // until a real tool call crosses the line.
    const onFirstToolCall = vi.fn().mockResolvedValue(undefined);
    const mcp = buildMcpServer(fakeClient, config, { onFirstToolCall });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'probe', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    try {
      // The discover payload serves the primer + identity (what a probe legitimately reads)…
      expect(harness.getInstructions()).toContain('musterd');
      const listed = await harness.listTools();
      expect(listed.tools.length).toBeGreaterThanOrEqual(20);
      // …and none of it armed the deferred claim.
      expect(onFirstToolCall).not.toHaveBeenCalled();
      // A real tool call is the boundary.
      await harness.callTool({ name: 'team_status', arguments: {} });
      expect(onFirstToolCall).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
      await mcp.close();
    }
  });

  it('cache hint armed; TRIPWIRE — stdio still negotiates legacy, so it must not reach the wire yet', async () => {
    // ADR 175 step 3, as far as SDK 2.0.0 allows: the `cacheHints` config on buildMcpServer is
    // validated at construction (an invalid hint throws — that half is covered by connect()
    // succeeding at all). But in this SDK release the modern 2026-07-28 era is served ONLY by the
    // per-request HTTP entry (`createMcpHandler` → `installModernOnlyHandlers`); a stdio/in-memory
    // `connect` negotiates the legacy list (max 2025-11-25), where cache fields are deliberately
    // absent from the wire. musterd is stdio-only, so the fields CANNOT appear yet.
    //
    // This test is a tripwire, not a regret: when an SDK bump lets a stdio connection negotiate a
    // modern (2026-07-28+) era, the assertions below go red — that is the signal to replace this
    // test with the real wire assertion (`listed.ttlMs === 3_600_000`,
    // `listed.cacheScope === 'private'`) and close ADR 175 step 3 fully.
    const { harness, close } = await connect();
    try {
      const negotiated = harness.getNegotiatedProtocolVersion?.() as string | undefined;
      expect(negotiated).toBeDefined();
      expect(negotiated! < '2026-07-28').toBe(true); // ISO dates compare lexicographically
      const listed = (await harness.listTools()) as {
        tools: unknown[];
        ttlMs?: number;
        cacheScope?: string;
      };
      expect(listed.ttlMs).toBeUndefined();
      expect(listed.cacheScope).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('classifyToolResult tolerates the required 2026-07-28 resultType field (ADR 175 step 4)', () => {
    // Results gained a required `resultType`; the classifier reads only isError/content and must
    // stay indifferent to the new field in every class.
    const text = (t: string) => [{ type: 'text', text: t }];
    expect(classifyToolResult({ resultType: 'tools/call', content: text('done') })).toBe('ok');
    expect(classifyToolResult({ resultType: 'tools/call', content: text('error: no') })).toBe(
      'error',
    );
    expect(
      classifyToolResult({
        resultType: 'tools/call',
        isError: true,
        content: text('Input validation error: nope'),
      }),
    ).toBe('invalid_input');
  });

  it('serverInfo carries the package version, never a drifted literal', async () => {
    const { harness, close } = await connect();
    try {
      const info = harness.getServerVersion();
      expect(info?.name).toBe('musterd');
      expect(info?.version).toBe(ADAPTER_VERSION);
      // And the constant is the package truth, not a fallback: the drift this pins was a
      // hardcoded '0.2.0' beside a 0.3.1 package.json (ADR 175).
      expect(ADAPTER_VERSION).not.toBe('0.0.0');
      expect(ADAPTER_VERSION).not.toBe('0.2.0');
    } finally {
      await close();
    }
  });
});
