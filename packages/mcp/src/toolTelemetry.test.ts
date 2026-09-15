import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
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
// SDK-seam canary (ADR 175): these three tests are part of the canary set `sdkSeams.test.ts`
// anchors — they prove the seams against the real SDK, so don't weaken them to unit doubles.
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

  // The inc-4 claim that only an end-to-end test can make: the SDK validates before any handler
  // runs, so a `lane`-instead-of-`id` call can ONLY succeed if coercion rewrote the arguments
  // upstream of validation. Proving it through the real SDK (not the rule table) is the point.
  it('coerces a mis-named argument ahead of SDK validation and reports it as coerced, not a bounce', async () => {
    const musterd = new MusterdClient(config);
    closers.push(() => musterd.close());
    await musterd.join();

    const recorder = new ToolCallRecorder();
    const mcp = buildMcpServer(musterd, config, { recorder });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'test-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    closers.push(() => mcp.close());

    const opened = await harness.callTool({
      name: 'lane_open',
      arguments: { title: 'a lane to claim' },
    });
    const laneId = (opened.structuredContent as { lane: { id: string } }).lane.id;

    // The exact shape five seats sent: the schema wants `id`, every agent guessed `lane`.
    const claimed = await harness.callTool({ name: 'lane_claim', arguments: { lane: laneId } });
    expect(claimed.isError ?? false).toBe(false);
    expect(String((claimed.content as { text?: string }[])[0]?.text)).toContain('lane claimed');
    expect((claimed.structuredContent as { lane: { owner_seat: string } }).lane.owner_seat).toBe(
      'Ada',
    );

    await recorder.flush(musterd);
    const report = (await fetch(base + '/teams/dawn/report', {
      headers: { authorization: `Bearer ${nickTok}` },
    }).then((r) => r.json())) as {
      tool_calls: {
        bounces: number;
        coerced: number;
        tools: { tool: string; calls: number; bounces: number; coerced: number }[];
      };
    };
    const t = report.tool_calls;
    expect(t.bounces).toBe(0);
    expect(t.coerced).toBe(1);
    const claim = t.tools.find((row) => row.tool === 'lane_claim')!;
    expect(claim.calls).toBe(1);
    expect(claim.coerced).toBe(1);
    // Visible as its own class, and NOT laundered into the bounce rate: the rate has to keep
    // meaning "cost the agent a turn", or the increment would flatter itself by construction.
    expect(claim.bounces).toBe(0);

    await harness.close();
  }, 15_000);

  // The regression this pins (reproduced 2026-07-27): `lane_update {surface:[…]}` came back a
  // SUCCESS with `scope: []` — zod strips keys it doesn't know, so a near-miss field name
  // was a silent no-op and the seat believed it had declared a surface it had not. Only an
  // end-to-end test can make the claim, because the drop happens inside SDK validation.
  it('forgives `surface` and bounces a truly unknown key instead of silently dropping it', async () => {
    const musterd = new MusterdClient(config);
    closers.push(() => musterd.close());
    await musterd.join();

    const recorder = new ToolCallRecorder();
    const mcp = buildMcpServer(musterd, config, { recorder });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'test-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    closers.push(() => mcp.close());

    // (a) the natural name now lands on the real field, all the way through to the stored lane.
    const opened = await harness.callTool({
      name: 'lane_open',
      arguments: {
        title: 'a lane with a surface',
        surface: ['packages/mcp/src/**'],
        claim: true,
      },
    });
    expect(opened.isError ?? false).toBe(false);
    const lane = (opened.structuredContent as { lane: { id: string; scope: string[] } }).lane;
    expect(lane.scope).toEqual(['packages/mcp/src/**']);

    const updated = await harness.callTool({
      name: 'lane_update',
      arguments: { id: lane.id, surface: ['packages/cli/src/**'] },
    });
    expect((updated.structuredContent as { lane: { scope: string[] } }).lane.scope).toEqual([
      'packages/cli/src/**',
    ]);

    // (b) a key no alias can explain stops the call, loudly, with the valid set — never a success
    // that quietly ignored what the caller asked for.
    const stray = await harness.callTool({
      name: 'lane_update',
      arguments: { id: lane.id, scpoe: ['packages/web/**'] },
    });
    expect(stray.isError).toBe(true);
    const text = String((stray.content as { text?: string }[])[0]?.text);
    expect(text).toContain('unrecognized argument key');
    expect(text).toContain("did you mean 'scope'");
    expect(text).toContain('lane_update accepts:');
    // Exactly one repair line — the specific one, not a generic one stacked on top.
    expect(text.match(/\nrepair: /g)).toHaveLength(1);

    // And the lane is untouched: a bounce changes nothing, unlike the silent drop it replaces.
    const board = await harness.callTool({ name: 'lane_board', arguments: { mine: true } });
    expect(String((board.content as { text?: string }[])[0]?.text)).toContain(
      'packages/cli/src/**',
    );

    await recorder.flush(musterd);
    const report = (await fetch(base + '/teams/dawn/report', {
      headers: { authorization: `Bearer ${nickTok}` },
    }).then((r) => r.json())) as {
      tool_calls: { tools: { tool: string; bounces: number; coerced: number }[] };
    };
    const update = report.tool_calls.tools.find((row) => row.tool === 'lane_update')!;
    expect(update.coerced).toBe(1); // the forgiven `surface`
    expect(update.bounces).toBe(1); // the unknown key — measured like any other schema failure

    await harness.close();
  }, 15_000);

  // ADR 256's no_goal warning tells seats to `lane_update {goal_id: …}`. The protocol and store
  // already accept that patch; the MCP schema did not, so the call bounced as an unrecognized
  // key — the warning named a call that could not succeed. Only an end-to-end test can pin this:
  // the reject happens inside SDK validation, ahead of any handler.
  it('lane_update accepts goal_id so a no_goal warning is actionable (ADR 256)', async () => {
    const musterd = new MusterdClient(config);
    closers.push(() => musterd.close());
    await musterd.join();

    const mcp = buildMcpServer(musterd, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'test-harness', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    closers.push(() => mcp.close());

    const opened = await harness.callTool({
      name: 'lane_open',
      arguments: { title: 'unlinked work', claim: true },
    });
    expect(opened.isError ?? false).toBe(false);
    const lane = (opened.structuredContent as { lane: { id: string; goal_id: string | null } })
      .lane;
    expect(lane.goal_id).toBeNull();

    const updated = await harness.callTool({
      name: 'lane_update',
      arguments: { id: lane.id, goal_id: 'goals-front-door' },
    });
    expect(updated.isError ?? false).toBe(false);
    expect((updated.structuredContent as { lane: { goal_id: string | null } }).lane.goal_id).toBe(
      'goals-front-door',
    );

    await harness.close();
  }, 15_000);
});
