import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { BOUNCE_RE } from './toolTelemetry.js';
import { ADAPTER_VERSION } from './version.js';
import { installShutdownHandlers, startStdioEntry } from './index.js';

/**
 * serveStdio adoption canaries (ADR 175 part b, lane 01KZVZG5GE5GWX97F27CWBMC4C). The production
 * entry is `serveStdio(factory, { legacy: 'serve' })`: the opening exchange selects the era, one
 * instance from the factory is pinned per connection, and a 2025-era opening is served exactly as
 * the hand-wired entry served it. These tests are the REAL wire assertions ADR 175 step 3 deferred
 * behind the (unwatchable) tripwire — the modern era asserted through the actual entry point, and
 * the legacy era asserted byte-equivalent to the wire every current harness speaks.
 */

/** Never contacted: every asserted path stops in SDK validation or the discover/list machinery. */
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

const MODERN = '2026-07-28';

/** Stand up the serveStdio entry over an in-memory wire and connect one client to it. */
async function connectEntry(opts: { modern?: boolean; onFirstToolCall?: () => Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const entry = startStdioEntry(fakeClient, config, {
    transport: serverTransport,
    ...(opts.onFirstToolCall ? { onFirstToolCall: opts.onFirstToolCall } : {}),
  });
  const harness = new Client(
    { name: 'canary-harness', version: '0.0.0' },
    opts.modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  );
  await harness.connect(clientTransport);
  return {
    harness,
    entry,
    close: async () => {
      await harness.close().catch(() => {});
      await entry.close();
    },
  };
}

function firstText(result: { content?: unknown }): string {
  const content = result.content as { type?: string; text?: unknown }[] | undefined;
  return content?.[0]?.type === 'text' ? String(content[0].text ?? '') : '';
}

describe('serveStdio entry (ADR 175 part b)', () => {
  it('a pinned-modern client negotiates 2026-07-28 and reads instructions + serverInfo via discover', async () => {
    const { harness, close } = await connectEntry({ modern: true });
    try {
      expect(harness.getNegotiatedProtocolVersion?.()).toBe(MODERN);
      // The discover payload carries what initialize used to: the primer and the identity.
      expect(harness.getInstructions()).toContain('musterd');
      const info = harness.getServerVersion();
      expect(info?.name).toBe('musterd');
      expect(info?.version).toBe(ADAPTER_VERSION);
    } finally {
      await close();
    }
  });

  it('the ADR 175 step-3 cache hints REACH the modern wire: tools/list carries ttlMs + private scope', async () => {
    // Armed in config since #565, unreachable on the legacy wire by SDK design. This is the real
    // wire assertion the tripwire deferred.
    const { harness, close } = await connectEntry({ modern: true });
    try {
      const listed = (await harness.listTools()) as {
        tools: unknown[];
        ttlMs?: number;
        cacheScope?: string;
      };
      expect(listed.tools.length).toBeGreaterThanOrEqual(20);
      expect(listed.ttlMs).toBe(3_600_000);
      expect(listed.cacheScope).toBe('private');
    } finally {
      await close();
    }
  });

  it('the repair/bounce seams hold on the modern wire: a zod bounce carries the specific hint once', async () => {
    // The four monkey-patch seams were proven era-proof only against the legacy wire (sdkSeams).
    // Same genuine bounce, modern era: BOUNCE_RE still matches and repair still speaks.
    const { harness, close } = await connectEntry({ modern: true });
    try {
      const bounced = await harness.callTool({
        name: 'team_send',
        arguments: { act: 'statusupdate', body: 'x' },
      });
      expect(bounced.isError).toBe(true);
      const text = firstText(bounced);
      expect(text).toMatch(BOUNCE_RE);
      expect(text).toContain("closest to what you sent is 'status_update'");
      expect(text.match(/\nrepair: /g)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('a modern connect never arms the autojoin; the first tool call still does (ADR 108 boundary)', async () => {
    // Probe safety through the NEW entry: a pin-mode connect is `server/discover` on this very
    // wire — it must stay as claim-inert as initialize was, or every doctor probe claims a seat.
    const onFirstToolCall = vi.fn().mockResolvedValue(undefined);
    const { harness, close } = await connectEntry({ modern: true, onFirstToolCall });
    try {
      await harness.listTools();
      expect(onFirstToolCall).not.toHaveBeenCalled();
      await harness.callTool({ name: 'team_status', arguments: {} });
      expect(onFirstToolCall).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it("legacy 'serve' keeps today's wire: initialize negotiates a 2025 era and cache fields stay absent", async () => {
    // The equivalence that makes production adoption safe: a default (legacy) client through
    // serveStdio sees exactly what the hand-wired entry served — same instructions, same absent
    // cache fields, same bounce hint.
    const { harness, close } = await connectEntry({});
    try {
      const negotiated = harness.getNegotiatedProtocolVersion?.() as string | undefined;
      expect(negotiated).toBeDefined();
      expect(negotiated! < MODERN).toBe(true); // ISO dates compare lexicographically
      expect(harness.getInstructions()).toContain('musterd');
      const listed = (await harness.listTools()) as {
        tools: unknown[];
        ttlMs?: number;
        cacheScope?: string;
      };
      expect(listed.ttlMs).toBeUndefined();
      expect(listed.cacheScope).toBeUndefined();
      const bounced = await harness.callTool({
        name: 'team_send',
        arguments: { act: 'statusupdate', body: 'x' },
      });
      expect(firstText(bounced)).toContain("closest to what you sent is 'status_update'");
    } finally {
      await close();
    }
  });

  it('the factory may run more than once per process (probe + fallback): two entries coexist', async () => {
    // serveStdio's opening rules can draw a probe instance AND a fallback pin from the same
    // factory. buildMcpServer must therefore be safe to run twice against the same MusterdClient
    // and config — no shared-state collision between the instances.
    const first = await connectEntry({ modern: true });
    const second = await connectEntry({});
    try {
      const [a, b] = await Promise.all([first.harness.listTools(), second.harness.listTools()]);
      expect(a.tools.length).toBeGreaterThanOrEqual(20);
      expect(b.tools.length).toBeGreaterThanOrEqual(20);
    } finally {
      await second.close();
      await first.close();
    }
  });

  it("installShutdownHandlers wraps the entry's own onclose instead of clobbering it", async () => {
    // serveStdio owns the transport and sets wire.onclose at start. The shutdown seam only
    // survives if our handler is installed AFTER the entry and wraps the prior handler — the
    // wrap-not-replace contract installShutdownHandlers already promises.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const entry = startStdioEntry(fakeClient, config, { transport: serverTransport });
    const harness = new Client({ name: 'canary-harness', version: '0.0.0' });
    await harness.connect(clientTransport);
    // The entry claimed the seam…
    expect(serverTransport.onclose).toBeDefined();
    const entryOnClose = serverTransport.onclose;
    const close = vi.fn();
    const exit = vi.fn();
    const noopProc = { on: vi.fn(), removeListener: vi.fn() } as unknown as NodeJS.Process;
    const noopStdin = { on: vi.fn(), off: vi.fn() };
    installShutdownHandlers({
      close,
      transport: serverTransport,
      exit,
      signals: noopProc,
      stdin: noopStdin,
    });
    // …and installing after wrapped it rather than replacing it.
    expect(serverTransport.onclose).not.toBe(entryOnClose);
    await harness.close(); // the host goes away: the wire closes under the entry
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
    await entry.close();
  });
});
