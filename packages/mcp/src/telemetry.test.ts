import type { McpServer } from '@modelcontextprotocol/server';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import type { HarnessContext } from './harness.js';
import { withTraceContext } from './otel.js';
import { instrumentTools, recordAdapterInitialization } from './telemetry.js';

type Handler = (...args: unknown[]) => unknown;

/** A stub McpServer capturing registered handlers, so we can invoke the wrapped callback. */
function stubServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function stubClient(member?: string): MusterdClient {
  return { member } as unknown as MusterdClient;
}

function testConfig(
  modelSource: McpConfig['modelSource'],
  model?: string,
  extra: Partial<McpConfig> = {},
): McpConfig {
  return {
    server: 'http://localhost:4849',
    team: 'dawn',
    // `cli` by default: no model probe exists there, so the declared tier is the honest best and
    // the unobserved warning must stay quiet. Probe-capable cases pass their surface explicitly.
    surface: 'cli',
    provenance: 'session',
    workspace: 'repo',
    modelSource,
    ...(model ? { model } : {}),
    claim: { mode: 'chat' },
    connId: 'conn-1',
    claimCode: 'AB12',
    bindingDir: process.cwd(),
    ...extra,
  };
}

const cursorHarness: HarnessContext = { name: 'Cursor', version: '1.8.0' };
const claudeHarness: HarnessContext = { name: 'claude-code', version: '2.1.0' };
const spans = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  );
});
afterAll(() => {
  context.disable();
  trace.disable();
});
beforeEach(() => spans.reset());

describe('instrumentTools (ADR 089: the musterd.tool.call span)', () => {
  it('wraps a registered tool in a musterd.tool.call span with structural attributes only', async () => {
    const { server, handlers } = stubServer();
    instrumentTools(server, stubClient('Ada'), 'dawn');
    server.registerTool(
      'team_send',
      {},
      async (args: unknown) => `sent ${(args as { body: string }).body}`,
    );

    const result = await handlers.get('team_send')!({ body: 'secret content' });
    expect(result).toBe('sent secret content');

    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.tool.call');
    expect(span).toBeTruthy();
    expect(span!.attributes['musterd.tool']).toBe('team_send');
    expect(span!.attributes['musterd.team']).toBe('dawn');
    // Identity keyed on the normalized seat id (issue #107), raw name as the label.
    expect(span!.attributes['musterd.member.id']).toBe('ada');
    expect(span!.attributes['musterd.member']).toBe('Ada');
    // Tool arguments are content — never span attributes (observability.md §4).
    expect(JSON.stringify(span!.attributes)).not.toContain('secret content');
  });

  it('gives the handler an ACTIVE span, so withTraceContext attaches meta.otel (the ADR 011 unlock)', async () => {
    const { server, handlers } = stubServer();
    instrumentTools(server, stubClient('Ada'), 'dawn');
    let meta: Record<string, unknown> | null = null;
    server.registerTool('team_send', {}, async () => {
      meta = withTraceContext(null);
    });

    await handlers.get('team_send')!({});
    expect(meta).toBeTruthy();
    const otel = (meta as unknown as { otel: { traceparent: string } }).otel;
    expect(otel.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    // The traceparent's span is exactly the tool-call span the wrapper opened.
    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.tool.call')!;
    expect(otel.traceparent).toContain(span.spanContext().traceId);
  });

  it("marks the span errored when a tool *returns* textResult('error: …') — in-band failure, fulfilled promise", async () => {
    const { server, handlers } = stubServer();
    instrumentTools(server, stubClient('Ada'), 'dawn');
    server.registerTool('team_send', {}, async () => ({
      content: [{ type: 'text', text: 'error: no member "zoe" in dawn' }],
    }));

    await handlers.get('team_send')!({});
    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.tool.call')!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.status.message).toContain('no member "zoe"');
  });

  it('marks the span errored and rethrows when the handler rejects', async () => {
    const { server, handlers } = stubServer();
    instrumentTools(server, stubClient(), 'dawn');
    server.registerTool('team_join', {}, async () => {
      throw new Error('boom');
    });

    await expect(handlers.get('team_join')!({})).rejects.toThrow('boom');
    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.tool.call')!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    // Pending seat: no member attributes rather than a fake identity.
    expect(span.attributes['musterd.member.id']).toBeUndefined();
  });
});

describe('recordAdapterInitialization (ADR 120)', () => {
  it('records harness context and a declared model without inferring from the host identity', () => {
    const warn = vi.fn();

    // clientInfo says Cursor (probe-capable) while the resolved surface is `cli` (not). Silence
    // here is the ADR 120 rule made testable: probe-capability is read off the launcher-resolved
    // surface, never off a name the client chose for itself.
    recordAdapterInitialization(testConfig('environment', 'gpt-5.2'), cursorHarness, warn);

    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.mcp.initialize')!;
    expect(span.attributes).toMatchObject({
      'musterd.team': 'dawn',
      'musterd.model.declaration': 'environment',
      'musterd.model': 'gpt-5.2',
      'musterd.harness.name': 'Cursor',
      'musterd.harness.version': '1.8.0',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when a probe-capable harness attests a declaration — an observation was reachable', () => {
    const warn = vi.fn();

    recordAdapterInitialization(
      testConfig('binding', 'claude-opus-4-8', { surface: 'claude-code' }),
      claudeHarness,
      warn,
    );

    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('claude-opus-4-8');
    expect(message).toContain('claude-code');
    expect(message).toContain('musterd wire');
    // Never the unknown message: this session HAS a model, it is just a snapshot.
    expect(message).not.toContain('no declared model');
  });

  it('warns the same way for the environment tier — a passed-in pin is still a declaration', () => {
    const warn = vi.fn();

    recordAdapterInitialization(
      testConfig('environment', 'gpt-5.2', { surface: 'codex' }),
      undefined,
      warn,
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('environment');
  });

  it('stays silent when the attestation is already observed — the goal state, not a defect', () => {
    const warn = vi.fn();

    recordAdapterInitialization(
      testConfig('observed', 'claude-opus-5', { surface: 'claude-code' }),
      claudeHarness,
      warn,
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('prints the drift tripwire when an observation contradicts a declaration', () => {
    const warn = vi.fn();

    recordAdapterInitialization(
      testConfig('observed', 'claude-opus-4-8', {
        surface: 'claude-code',
        modelDrift: { declared: 'grok-4.5', observed: 'claude-opus-4-8' },
      }),
      claudeHarness,
      warn,
    );

    // Drift only — the tier is `observed`, so the unobserved warning must not double up.
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('drift');
    expect(message).toContain('grok-4.5');
    expect(message).toContain('claude-opus-4-8');
  });

  it('warns once when no model declaration exists while retaining harness context', () => {
    const warn = vi.fn();

    recordAdapterInitialization(testConfig('unknown'), cursorHarness, warn);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no declared model'));
    expect(warn.mock.calls[0]![0]).toContain('Cursor');
    const span = spans.getFinishedSpans().find((s) => s.name === 'musterd.mcp.initialize')!;
    expect(span.attributes['musterd.model.declaration']).toBe('unknown');
    expect(span.attributes['musterd.model']).toBeUndefined();
    expect(span.attributes['musterd.harness.name']).toBe('Cursor');
  });
});
