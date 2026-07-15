import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { classifyToolResult, ToolCallRecorder } from './toolTelemetry.js';
import { buildMcpServer } from './index.js';

describe('classifyToolResult', () => {
  it('names the SDK validation bounce, the in-band error conventions, and success', () => {
    const text = (t: string, isError?: boolean) => ({
      ...(isError !== undefined ? { isError } : {}),
      content: [{ type: 'text', text: t }],
    });
    expect(
      classifyToolResult(
        text('Input validation error: Invalid arguments for tool team_send', true),
      ),
    ).toBe('invalid_input');
    // What the seam actually sees: the SDK catches the validation McpError and stringifies it.
    expect(
      classifyToolResult(text('MCP error -32602: Input validation error: Invalid arguments', true)),
    ).toBe('invalid_input');
    expect(classifyToolResult(text('Tool nope not found', true))).toBe('error');
    expect(classifyToolResult(text('error: no seat claimed'))).toBe('error');
    expect(classifyToolResult(text('sent.'))).toBe('ok');
    expect(classifyToolResult(undefined)).toBe('ok');
  });
});

describe('ToolCallRecorder', () => {
  function fakeClient(over: Partial<MusterdClient> = {}): MusterdClient {
    return {
      member: 'ada',
      reportToolTelemetry: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as unknown as MusterdClient;
  }

  it('accumulates deltas per (tool, outcome) and clears on a successful flush', async () => {
    const recorder = new ToolCallRecorder();
    recorder.record('team_send', 'ok', 100);
    recorder.record('team_send', 'ok', 300);
    recorder.record('team_send', 'invalid_input', 5);
    const client = fakeClient();
    await recorder.flush(client);
    expect(client.reportToolTelemetry).toHaveBeenCalledTimes(1);
    const report = vi.mocked(client.reportToolTelemetry).mock.calls[0]![0];
    expect(report.events).toEqual(
      expect.arrayContaining([
        {
          tool: 'team_send',
          outcome: 'ok',
          calls: 2,
          total_duration_ms: 400,
          max_duration_ms: 300,
        },
        {
          tool: 'team_send',
          outcome: 'invalid_input',
          calls: 1,
          total_duration_ms: 5,
          max_duration_ms: 5,
        },
      ]),
    );
    await recorder.flush(client); // drained — nothing more to send
    expect(client.reportToolTelemetry).toHaveBeenCalledTimes(1);
  });

  it('collapses unregistered tool names to one bucket (no key per hallucinated name)', async () => {
    const recorder = new ToolCallRecorder();
    recorder.record('team_sendd', 'error', 1);
    recorder.record('lane_openn', 'error', 1);
    const client = fakeClient();
    await recorder.flush(client);
    const report = vi.mocked(client.reportToolTelemetry).mock.calls[0]![0];
    expect(report.events).toEqual([
      { tool: '(unknown)', outcome: 'error', calls: 2, total_duration_ms: 2, max_duration_ms: 1 },
    ]);
  });

  it('stays silent with no seat, and re-merges the batch when the send fails (bounded retry)', async () => {
    const recorder = new ToolCallRecorder();
    recorder.record('team_send', 'ok', 10);
    const unclaimed = fakeClient({ member: undefined } as Partial<MusterdClient>);
    await recorder.flush(unclaimed);
    expect(unclaimed.reportToolTelemetry).not.toHaveBeenCalled();

    const failing = fakeClient({
      reportToolTelemetry: vi.fn().mockRejectedValue(new Error('down')),
    } as Partial<MusterdClient>);
    await recorder.flush(failing); // swallowed, re-merged
    recorder.record('team_send', 'ok', 20);
    const ok = fakeClient();
    await recorder.flush(ok);
    const report = vi.mocked(ok.reportToolTelemetry).mock.calls[0]![0];
    expect(report.events).toEqual([
      { tool: 'team_send', outcome: 'ok', calls: 2, total_duration_ms: 30, max_duration_ms: 20 },
    ]);
  });
});

// End-to-end through the real SDK server (validation included) and a real daemon: the only seam
// that sees an invalid-input bounce is the tools/call request handler this instruments.
describe('tool-call telemetry end-to-end (ADR 144 inc 1)', () => {
  let server: RunningServer;
  let base: string;
  let nickTok: string;
  let config: McpConfig;
  /** Closers registered by the test, run (reverse order) before server.close() even on failure —
   * a live WS/transport would otherwise hang the afterEach hook. */
  let closers: (() => unknown)[] = [];

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await fetch(base + '/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
    }).then((r) => r.json() as Promise<{ human_credential: string; agent_key: string }>);
    nickTok = team.human_credential;
    await fetch(base + '/teams/dawn/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nickTok}` },
      body: JSON.stringify({ name: 'Ada', kind: 'agent', role: 'backend' }),
    });
    const grant = await fetch(base + '/teams/dawn/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nickTok}` },
      body: JSON.stringify({ scope: 'seat', target: 'Ada', lifetime: 'standing' }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    config = {
      server: base,
      team: 'dawn',
      agent_key: team.agent_key,
      grant: grant.token,
      surface: 'claude-code',
      provenance: 'session',
      workspace: 'repo',
      claim: { mode: 'seat', name: 'Ada' },
      connId: 'conn-ada',
      claimCode: 'AD12',
      bindingDir: process.cwd(),
    };
  });

  afterEach(async () => {
    for (const close of closers.reverse()) await close();
    closers = [];
    await server.close();
  });

  it('records ok calls and validation bounces at the transport seam, flushes, and the report answers', async () => {
    const musterd = new MusterdClient(config);
    closers.push(() => musterd.close());
    await musterd.join();

    const recorder = new ToolCallRecorder();
    const mcp = buildMcpServer(musterd, config, { recorder });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'test-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    closers.push(() => mcp.close());

    // A real call (ok) and a schema bounce (`act` outside the enum — never reaches the handler).
    const ok = await harness.callTool({ name: 'team_status', arguments: {} });
    expect(ok.isError ?? false).toBe(false);
    const bounced = await harness.callTool({
      name: 'team_send',
      arguments: { act: 'bogus', body: 'x' },
    });
    expect(bounced.isError).toBe(true);
    expect(String((bounced.content as { text?: string }[])[0]?.text)).toContain(
      'Input validation error',
    );

    await recorder.flush(musterd);

    const report = (await fetch(base + '/teams/dawn/report', {
      headers: { authorization: `Bearer ${nickTok}` },
    }).then((r) => r.json())) as {
      tool_calls: {
        calls: number;
        bounces: number;
        tools: { tool: string; calls: number; bounces: number; by_role: Record<string, number> }[];
        surface: { seat: string; tools: number; bytes: number; est_tokens: number }[];
      };
    };
    const t = report.tool_calls;
    expect(t.calls).toBe(2);
    expect(t.bounces).toBe(1);
    const send = t.tools.find((row) => row.tool === 'team_send')!;
    expect(send.bounces).toBe(1);
    expect(send.by_role).toEqual({ backend: 1 });
    const status = t.tools.find((row) => row.tool === 'team_status')!;
    expect(status.calls).toBe(1);
    // The surface attestation rode the first flush — measured from the exact tools/list render.
    expect(t.surface).toHaveLength(1);
    expect(t.surface[0]!.seat).toBe('Ada');
    expect(t.surface[0]!.tools).toBeGreaterThanOrEqual(18);
    expect(t.surface[0]!.bytes).toBeGreaterThan(1000);

    // Once per session: a second flush with nothing new sends nothing.
    const spy = vi.spyOn(musterd, 'reportToolTelemetry');
    await recorder.flush(musterd);
    expect(spy).not.toHaveBeenCalled();

    await harness.close();
  }, 15_000);
});
