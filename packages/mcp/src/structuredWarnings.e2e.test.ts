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
 * A warning a structuredContent-rendering client can actually see (lane 01M2NRYJEQ).
 *
 * `buildSkewWarning` (ADR 135) was correct, was called on the minute-0 surface, and reached nobody:
 * it is appended to `content[].text`, and the non-empty inbox path returns `structuredContent`
 * alongside it. A harness that renders the structured half and drops the prose showed the seat
 * nothing — so a session running stale tools looked identical to a fresh one. Measured 2026-09-16:
 * sloane's seat ran a 14-hour-old adapter against a current daemon, got no line, and nearly reported
 * a correct fix as failing because of it.
 *
 * The empty-inbox path uses `textResult` (no structuredContent) and so was always visible — which is
 * the wrong way round, and is why every unit test over the prose stayed green.
 *
 * These assertions therefore read `structuredContent` and NOTHING else. A test that looks at `text`
 * cannot see this defect; that is precisely how it survived.
 */

let server: RunningServer;
let base: string;
let tokens: Record<string, string> = {};
let seatDir: string;

const ADAPTER_BUILD = 'a'.repeat(40);
const DAEMON_BUILD = 'b'.repeat(40);

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
  // A daemon that names its own build: without `buildRef` the skew check has an unknown side and
  // stays silent by design, so the fixture would prove nothing.
  server = createServer({ db: openDb(':memory:'), port: 0, buildRef: DAEMON_BUILD });
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
  seatDir = mkdtempSync(join(tmpdir(), 'musterd-warn-seat-'));
});

afterEach(async () => {
  await server.close();
  tokens = {};
  rmSync(seatDir, { recursive: true, force: true });
});

/**
 * `build` is taken as an explicit argument rather than a defaulted parameter: `adaConfig(undefined)`
 * on a defaulted parameter re-supplies the default, so the unstamped case silently tested a stamped
 * adapter and the assertion failed against a warning that should never have fired.
 */
function adaConfig(build: string | undefined): McpConfig {
  return {
    server: base,
    team: 'dawn',
    agent_key: tokens['agent_key']!,
    grant: tokens['ada_grant']!,
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    connId: 'conn-ada-warn',
    claimCode: 'AD98',
    bindingDir: seatDir,
    build,
  };
}

/** Unread rows, so the check takes the path that carries structuredContent. */
async function seed(n: number) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const envelope = {
      id: `w${String(i).padStart(4, '0')}`,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message' as const,
      body: `note ${i}`,
      ts: t0 + i,
    };
    const r = await api('POST', '/teams/dawn/messages', { envelope }, tokens['nick']);
    if (r.status >= 400) throw new Error(`seed ${i} failed: ${r.status}`);
  }
}

type Warning = { kind: string; text: string; [k: string]: unknown };

async function checkInbox(config: McpConfig): Promise<{
  structured: Record<string, unknown>;
  text: string;
}> {
  const client = new MusterdClient(config);
  await client.join();
  await seed(3);
  const mcp = buildMcpServer(client, config, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'warn-harness', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  try {
    const res = (await harness.callTool({
      name: 'team_inbox_check',
      arguments: {},
    })) as { structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
    return {
      structured: res.structuredContent ?? {},
      text: (res.content ?? []).map((c) => c.text ?? '').join(''),
    };
  } finally {
    await harness.close();
    await mcp.close();
    client.close();
  }
}

describe('a stale adapter tells a structuredContent-only client about itself', () => {
  it('puts the build skew in structuredContent, not only in the prose', async () => {
    const { structured } = await checkInbox(adaConfig(ADAPTER_BUILD));
    const warnings = structured['warnings'] as Warning[] | undefined;
    expect(warnings, 'structuredContent carries no warnings at all').toBeDefined();
    const skew = warnings!.find((w) => w.kind === 'build_skew');
    expect(skew, `no build_skew warning in ${JSON.stringify(warnings)}`).toBeDefined();
    // The facts a client may act on, not only print: both sides, so it can render its own line.
    expect(skew!['adapter']).toBe(ADAPTER_BUILD);
    expect(skew!['daemon']).toBe(DAEMON_BUILD);
    // And the human sentence is still carried, so a client that only prints stays useful.
    expect(String(skew!.text)).toMatch(/stale tools/);
  }, 30_000);

  it('still says it in the prose — text-rendering clients must not regress', async () => {
    const { text } = await checkInbox(adaConfig(ADAPTER_BUILD));
    expect(text).toMatch(/differs from the daemon/);
    expect(text).toMatch(/stale tools/);
  }, 30_000);

  it('stays silent when the adapter is unstamped — an unknown build is never reported as skew', async () => {
    const { structured, text } = await checkInbox(adaConfig(undefined));
    const warnings = (structured['warnings'] as Warning[] | undefined) ?? [];
    expect(warnings.find((w) => w.kind === 'build_skew')).toBeUndefined();
    expect(text).not.toMatch(/stale tools/);
  }, 30_000);

  it('stays silent when the builds agree', async () => {
    const { structured, text } = await checkInbox(adaConfig(DAEMON_BUILD));
    const warnings = (structured['warnings'] as Warning[] | undefined) ?? [];
    expect(warnings.find((w) => w.kind === 'build_skew')).toBeUndefined();
    expect(text).not.toMatch(/stale tools/);
  }, 30_000);
});
