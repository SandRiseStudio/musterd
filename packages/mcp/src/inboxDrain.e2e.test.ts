import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { buildMcpServer } from './index.js';

/**
 * The drain, through the REAL tool against a REAL daemon (lane 01M2NGB60Q).
 *
 * Lane 01M2GT874Y closed the ADR 287 treadmill and proved it with unit tests over `planInboxCheck`,
 * handed every unread row as one array. That array is not what the tool fetches. `team_inbox_check`
 * always names a `limit`, and a named `limit` is the newest TAIL on the server, while the
 * oldest-first prefix is served only to a caller that names none. So the digest never ran, the
 * cursor never moved, and every unit test still passed — the fixture modelled a fetch the product
 * does not perform.
 *
 * This suite exists so that cannot happen twice: the assertion below is "a seat with a real backlog
 * reaches zero unread through ordinary default checks", made through `tools/call` over the MCP SDK,
 * against a live daemon, with the cursor read back out of the daemon at the end.
 */

let server: RunningServer;
let base: string;
let tokens: Record<string, string> = {};
let seatDir: string;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  tokens['nick'] = team.json.human_credential;
  tokens['agent_key'] = team.json.agent_key;
  await api('POST', '/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tokens['nick']);
  const grant = await api(
    'POST',
    '/teams/dawn/grants',
    { scope: 'seat', target: 'Ada', lifetime: 'standing' },
    tokens['nick'],
  );
  tokens['ada_grant'] = grant.json.token;
  seatDir = mkdtempSync(join(tmpdir(), 'musterd-drain-seat-'));
});

afterEach(async () => {
  await server.close();
  tokens = {};
  rmSync(seatDir, { recursive: true, force: true });
});

function adaConfig(): McpConfig {
  return {
    server: base,
    team: 'dawn',
    agent_key: tokens['agent_key']!,
    grant: tokens['ada_grant']!,
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    connId: 'conn-ada-drain',
    claimCode: 'AD99',
    bindingDir: seatDir,
  };
}

/** A backlog bigger than the tool's default `limit`, posted through the real send route. */
async function seedBacklog(n: number) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const envelope = {
      id: `b${String(i).padStart(4, '0')}`,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message' as const,
      body: `backlog ${i}`,
      ts: t0 + i,
    };
    const r = await api('POST', '/teams/dawn/messages', { envelope }, tokens['nick']);
    if (r.status >= 400) throw new Error(`seed ${i} failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
}

/**
 * What still sits ahead of Ada's read cursor, asked of the daemon itself — the number this lane is
 * about. Read through the seat's own authenticated client, because the inbox is seat-scoped.
 */
async function unreadCount(client: MusterdClient): Promise<number> {
  const r = await client.fetchInbox(true);
  return r.messages.length + (r.unread_remaining ?? 0);
}

describe('a seat with a real backlog drains through ordinary default checks', () => {
  it('reaches zero unread, and the cursor never passes a row no call rendered', async () => {
    // Join BEFORE seeding: a freshly claimed seat starts its cursor at the claim, so a backlog
    // posted earlier is already behind the watermark and there is nothing to drain.
    const client = new MusterdClient(adaConfig());
    await client.join();
    await seedBacklog(220);
    const mcp = buildMcpServer(client, adaConfig(), {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'drain-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    try {
      expect(await unreadCount(client)).toBeGreaterThan(200);
      let calls = 0;
      let left = await unreadCount(client);
      while (left > 0 && calls < 20) {
        const before = left;
        // No arguments: the DEFAULT check, which is the only one any seat actually makes.
        await harness.callTool({ name: 'team_inbox_check', arguments: {} });
        calls++;
        left = await unreadCount(client);
        // Every call must make progress. A single check that walks nothing is the treadmill.
        expect(left).toBeLessThan(before);
      }
      expect(left).toBe(0);
      // Bounded: the drain is a handful of ordinary checks, not one unbounded one.
      expect(calls).toBeLessThanOrEqual(10);
    } finally {
      await harness.close();
      await mcp.close();
      client.close();
    }
  }, 60_000);
});
