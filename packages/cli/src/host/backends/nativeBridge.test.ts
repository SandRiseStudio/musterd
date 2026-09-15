import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildMcpServer, TOOL_NAMES, type MusterdClient } from '@musterd/mcp';
import { describe, expect, it } from 'vitest';
import { bridgeTools, contentToText, nativeMcpConfig } from './nativeBridge.js';

/**
 * The MCP bridge (ADR 251 §4): the loop's tool set is the seat's own rendered surface, bridged
 * 1:1 — never hand-rolled. These tests stand the real `buildMcpServer` up in memory (the
 * `measureToolSurface` precedent — no daemon, no socket) and assert the render maps through
 * unchanged, plus the marshalling on a toy server whose tools can actually be called.
 */

describe('nativeMcpConfig', () => {
  const binding = {
    server: 'http://127.0.0.1:1',
    team: 'revive',
    surface: 'claude-code',
    agent_key: 'mskey_x',
    grant: 'msgr_y',
    autojoin: true,
  };

  it('carries a workspace_key so a native seat is not evicted by its own label change (ADR 368)', () => {
    const config = nativeMcpConfig({
      binding: binding as never,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      seat: 'izzo',
      workspace: 'agents-izzo@main',
      workspaceKey: '/Users/x/agents-izzo',
      leaseId: 'L123',
      model: 'claude-opus-5',
      modelSource: 'binding',
    });
    expect(config.workspaceKey).toBe('/Users/x/agents-izzo');
  });

  it('defaults the key to the workspace it was pointed at rather than sending none', () => {
    const config = nativeMcpConfig({
      binding: binding as never,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      seat: 'izzo',
      workspace: '/tmp/ws',
      leaseId: 'L123',
      model: 'claude-opus-5',
      modelSource: 'binding',
    });
    expect(config.workspaceKey).toBe('/tmp/ws');
  });

  it('attests wake provenance, the lease token, the musterd surface, and the seat claim', () => {
    const config = nativeMcpConfig({
      binding: binding as never,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      seat: 'izzo',
      workspace: '/tmp/ws',
      leaseId: 'L123',
      model: 'claude-opus-5',
      modelSource: 'binding',
    });
    expect(config.provenance).toBe('wake');
    expect(config.wakeLease).toBe('L123');
    expect(config.surface).toBe('musterd');
    expect(config.claim).toEqual({ mode: 'seat', name: 'izzo' });
    expect(config.agent_key).toBe('mskey_x');
    expect(config.grant).toBe('msgr_y');
    expect(config.model).toBe('claude-opus-5');
    expect(config.modelSource).toBe('binding');
    // The wake order names the server/team; a drifted binding must not redirect the occupancy.
    expect(config.server).toBe('http://127.0.0.1:4849');
  });
});

describe('bridgeTools against the real adapter render', () => {
  it('maps the seat surface 1:1 — every registered tool, name and schema intact', async () => {
    const fakeClient = { member: 'izzo' } as unknown as MusterdClient;
    const config = nativeMcpConfig({
      binding: {
        server: 's',
        team: 'revive',
        surface: 'claude-code',
        agent_key: 'mskey_x',
      } as never,
      server: 'http://127.0.0.1:1',
      team: 'revive',
      seat: 'izzo',
      workspace: '/tmp/ws',
      leaseId: 'L1',
      model: undefined,
      modelSource: 'unknown',
    });
    const mcp = buildMcpServer(fakeClient, config, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const harness = new Client({ name: 'native-bridge-test', version: '0.0.0' });
    await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
    try {
      const tools = await bridgeTools(harness);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.input_schema).toMatchObject({ type: 'object' });
      }
    } finally {
      await harness.close();
      await mcp.close();
    }
  });

  it('marshals a tool call: name and input through, text content back, null input tolerated', async () => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const fake = {
      listTools: async () => ({
        tools: [
          {
            name: 'echo',
            description: 'echo back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      }),
      callTool: async (params: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(params);
        return { content: [{ type: 'text', text: `echo: ${String(params.arguments['text'])}` }] };
      },
    };
    const tools = await bridgeTools(fake);
    const echo = tools.find((t) => t.name === 'echo')!;
    await expect(echo.run({ text: 'hi' })).resolves.toBe('echo: hi');
    expect(calls[0]).toEqual({ name: 'echo', arguments: { text: 'hi' } });
    // A model call with no arguments still sends an object, never null.
    await echo.run(undefined);
    expect(calls[1]!.arguments).toEqual({});
  });
});

describe('contentToText', () => {
  it('joins text blocks and stringifies anything else', () => {
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(contentToText([{ type: 'resource_link', uri: 'x://y' }])).toContain('resource_link');
    expect(contentToText([])).toBe('');
    expect(contentToText(undefined)).toBe('');
  });
});
