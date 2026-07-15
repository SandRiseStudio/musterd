import { describe, expect, it } from 'vitest';
import { SurfaceRenderSchema, ToolTelemetryReportSchema } from './tool-telemetry.js';

describe('tool-telemetry wire schemas (ADR 144 inc 1)', () => {
  it('accepts a batched flush with an optional surface attestation', () => {
    const parsed = ToolTelemetryReportSchema.parse({
      events: [
        { tool: 'team_send', outcome: 'ok', calls: 3, total_duration_ms: 120, max_duration_ms: 80 },
        {
          tool: 'team_send',
          outcome: 'invalid_input',
          calls: 1,
          total_duration_ms: 4,
          max_duration_ms: 4,
        },
      ],
      surface: {
        tools: 18,
        bytes: 40_000,
        est_tokens: 10_000,
        breakdown: [{ tool: 'team_send', bytes: 2_000, description_bytes: 1_700 }],
      },
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.surface?.est_tokens).toBe(10_000);
  });

  it('rejects unknown outcomes, zero-call cells, and oversized batches', () => {
    const cell = {
      tool: 'team_send',
      outcome: 'ok' as const,
      calls: 1,
      total_duration_ms: 0,
      max_duration_ms: 0,
    };
    expect(
      ToolTelemetryReportSchema.safeParse({ events: [{ ...cell, outcome: 'meh' }] }).success,
    ).toBe(false);
    expect(ToolTelemetryReportSchema.safeParse({ events: [{ ...cell, calls: 0 }] }).success).toBe(
      false,
    );
    expect(
      ToolTelemetryReportSchema.safeParse({ events: Array.from({ length: 257 }, () => cell) })
        .success,
    ).toBe(false);
    // Redaction posture: the schema has no field that could carry arguments or bodies.
    expect(
      ToolTelemetryReportSchema.safeParse({ events: [{ ...cell, args: { x: 1 } }] }).data
        ?.events[0],
    ).not.toHaveProperty('args');
  });

  it('caps the surface breakdown (64 tools) — cardinality is bounded at the wire', () => {
    const breakdown = Array.from({ length: 65 }, (_, i) => ({
      tool: `t${i}`,
      bytes: 1,
      description_bytes: 0,
    }));
    expect(
      SurfaceRenderSchema.safeParse({ tools: 65, bytes: 65, est_tokens: 16, breakdown }).success,
    ).toBe(false);
  });
});
