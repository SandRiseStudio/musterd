import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { captureHarnessContext, observeHarnessInitialization } from './harness.js';

describe('captureHarnessContext (ADR 120)', () => {
  it('retains a sanitized MCP client identity as harness context', () => {
    const context = captureHarnessContext({
      getClientVersion: () => ({ name: 'Cursor', version: '1.8.0' }),
    });

    expect(context).toEqual({ name: 'Cursor', version: '1.8.0' });
  });

  it('returns no context before the MCP initialize handshake completes', () => {
    expect(captureHarnessContext({ getClientVersion: () => undefined })).toBeUndefined();
  });

  it('bounds harness identity fields without treating them as a model declaration', () => {
    const context = captureHarnessContext({
      getClientVersion: () => ({
        name: `Cursor\n${'n'.repeat(200)}`,
        version: `\u001b[31m${'v'.repeat(200)}`,
      }),
    });

    expect(context).toEqual({ name: `Cursor${'n'.repeat(114)}`, version: 'v'.repeat(120) });
    expect(context).not.toHaveProperty('model');
  });

  it('captures clientInfo only after the MCP initialize callback completes', () => {
    const state: { client?: { name: string; version?: string } } = {};
    let priorCalls = 0;
    const source = {
      getClientVersion: () => state.client,
      oninitialized: () => {
        priorCalls++;
      },
    };
    const captured: unknown[] = [];

    observeHarnessInitialization(source, (context) => captured.push(context));
    expect(captured).toEqual([]);

    state.client = { name: 'Cursor', version: '1.8.0' };
    source.oninitialized!();

    expect(priorCalls).toBe(1);
    expect(captured).toEqual([{ name: 'Cursor', version: '1.8.0' }]);
  });

  it('observes clientInfo from a real MCP initialize handshake', async () => {
    const server = new McpServer({ name: 'musterd-test', version: '0.2.0' });
    const client = new Client({ name: 'Cursor', version: '1.8.0' });
    const captured: unknown[] = [];
    observeHarnessInitialization(server.server, (context) => captured.push(context));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(captured).toEqual([{ name: 'Cursor', version: '1.8.0' }]);
    await Promise.all([client.close(), server.close()]);
  });
});
