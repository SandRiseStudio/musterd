import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeSeatName } from '@musterd/protocol';
import { startTelemetry, type TelemetryHandle } from '@musterd/telemetry';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';

/**
 * Adapter-side telemetry (ADR 089 increment 1). Boots the shared SDK as `musterd-mcp` and wraps
 * every registered tool in a `musterd.tool.call` span. The span is the unlock, not decoration:
 * with an active span in the adapter process, the ADR 011 plumbing in `otel.ts` fires in
 * production — `team_send` attaches `meta.otel` to the envelope and `team_inbox_check` links the
 * sender's trace — so a handoff becomes one cross-agent, cross-runtime distributed trace.
 *
 * Same posture as everywhere else (ADR 015/082): off by default (no OTLP endpoint → no SDK, and
 * the span wrapper below is a cheap no-op through the no-op tracer), no phone-home.
 */

const tracer = trace.getTracer('musterd-mcp');

/**
 * Boot the shared SDK with the seat identity as resource attributes. The seat may still be
 * pending at boot (claim-on-first-use) — per-call spans read the live identity off the client
 * instead, so an adopted identity is attributed correctly.
 */
export function startMcpTelemetry(config: McpConfig): Promise<TelemetryHandle> {
  const member = config.member;
  return startTelemetry({
    serviceName: 'musterd-mcp',
    attributes: {
      'musterd.team': config.team,
      ...(member
        ? { 'musterd.member.id': normalizeSeatName(member), 'musterd.member': member }
        : {}),
    },
  });
}

type ToolCallback = (...args: unknown[]) => unknown;

/**
 * Patch `server.registerTool` so every tool handler runs inside a `musterd.tool.call` span — one
 * choke point instead of nine tool modules. Attributes are structural only (tool name, team, the
 * live seat id per issue #107): never tool arguments or message bodies — content is the
 * operator's data, not telemetry (observability.md §4).
 */
export function instrumentTools(server: McpServer, client: MusterdClient, team: string): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: ToolCallback,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: ToolCallback,
  ) =>
    original(name, config, (...args: unknown[]) =>
      tracer.startActiveSpan(`musterd.tool.call`, (span) => {
        span.setAttribute('musterd.tool', name);
        span.setAttribute('musterd.team', team);
        const member = client.member;
        if (member) {
          span.setAttribute('musterd.member.id', normalizeSeatName(member));
          span.setAttribute('musterd.member', member);
        }
        const done = (): void => {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        };
        const failed = (err: unknown): void => {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          span.end();
        };
        try {
          const result = cb(...args);
          if (result instanceof Promise) {
            return result.then(
              (v) => (done(), v),
              (err) => (failed(err), Promise.reject(err)),
            );
          }
          done();
          return result;
        } catch (err) {
          failed(err);
          throw err;
        }
      }),
    );
}
