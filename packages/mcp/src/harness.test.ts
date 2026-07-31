import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  captureHarnessContext,
  CLIENT_INFO_META_KEY,
  harnessFromClientInfo,
  observeHarnessInitialization,
  observeHarnessRequests,
} from './harness.js';

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

describe('modern-era capture (ADR 175 step 5)', () => {
  it('harnessFromClientInfo applies the same sanitize bounds as the initialize-time capture', () => {
    expect(harnessFromClientInfo({ name: 'Claude Code', version: '2.1' })).toEqual({
      name: 'Claude Code',
      version: '2.1',
    });
    expect(harnessFromClientInfo({ name: '  Cursor  ' })).toEqual({ name: 'Cursor' });
    expect(harnessFromClientInfo({ name: '' })).toBeUndefined();
    expect(harnessFromClientInfo({ version: '1.0' })).toBeUndefined();
    expect(harnessFromClientInfo('Cursor')).toBeUndefined();
    expect(harnessFromClientInfo(null)).toBeUndefined();
    expect(harnessFromClientInfo({ name: 'x'.repeat(300) })!.name).toHaveLength(120);
  });

  it('captures clientInfo from per-request _meta at the tools/call seam, first capture wins', () => {
    const handlers = new Map<string, (request: unknown, ctx: unknown) => unknown>();
    const inner = {
      setRequestHandler: (...args: unknown[]) => {
        handlers.set(args[0] as string, args[args.length - 1] as never);
      },
    };
    const captured: unknown[] = [];
    observeHarnessRequests(inner, (context) => captured.push(context));
    inner.setRequestHandler('tools/call', () => 'result');

    const request = (info: unknown) => ({
      method: 'tools/call',
      params: { name: 't', _meta: { [CLIENT_INFO_META_KEY]: info } },
    });
    // A request with no usable clientInfo captures nothing and passes through…
    expect(handlers.get('tools/call')!(request(undefined), {})).toBe('result');
    expect(captured).toEqual([]);
    // …the first usable one captures, and later (different) ones are ignored: first wins.
    handlers.get('tools/call')!(request({ name: 'Claude Code', version: '2.1' }), {});
    handlers.get('tools/call')!(request({ name: 'Other', version: '9' }), {});
    expect(captured).toEqual([{ name: 'Claude Code', version: '2.1' }]);
  });

  it('falls back to the SDK-backfilled getClientVersion when _meta carries nothing', () => {
    const handlers = new Map<string, (request: unknown, ctx: unknown) => unknown>();
    const inner = {
      setRequestHandler: (...args: unknown[]) => {
        handlers.set(args[0] as string, args[args.length - 1] as never);
      },
      getClientVersion: () => ({ name: 'legacy-host', version: '1.0' }),
    };
    const captured: unknown[] = [];
    observeHarnessRequests(inner, (context) => captured.push(context));
    inner.setRequestHandler('tools/call', () => 'result');
    handlers.get('tools/call')!({ method: 'tools/call', params: { name: 't' } }, {});
    expect(captured).toEqual([{ name: 'legacy-host', version: '1.0' }]);
  });
});
