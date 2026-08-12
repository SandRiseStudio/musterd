import { describe, expect, it } from 'vitest';
import type { EngineTool, EngineTurn } from '../engine.js';
import { anthropicEngine, priceUsage } from './anthropic.js';

/**
 * The anthropic engine against a scripted fake SDK client — no network, no key, no live model
 * (ADR 251 Eval: the scripted suite drives everything without a model). The fake implements the
 * exact slice of `client.beta.messages.toolRunner` the engine consumes: async iteration yielding
 * per-turn messages, plus the cached `generateToolResponse`.
 */

interface FakeMessage {
  content: unknown[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

function fakeClient(script: {
  messages?: FakeMessage[];
  toolResults?: (unknown[] | null)[];
  error?: unknown;
  errorAfter?: number;
  onCreate?: (params: Record<string, unknown>, options: Record<string, unknown> | undefined) => void;
}) {
  return {
    beta: {
      messages: {
        toolRunner: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
          script.onCreate?.(params, options);
          let turn = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async (): Promise<{ done: boolean; value: FakeMessage | undefined }> => {
                  if (script.error !== undefined && turn >= (script.errorAfter ?? 0)) {
                    throw script.error;
                  }
                  const msg = script.messages?.[turn];
                  turn += 1;
                  if (!msg) return { done: true, value: undefined };
                  return { done: false, value: msg };
                },
              };
            },
            generateToolResponse: async () => {
              const results = script.toolResults?.[turn - 1];
              return results ? { role: 'user', content: results } : null;
            },
          };
        },
      },
    },
  };
}

const usage = (input: number, output: number, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});

const noopTool: EngineTool = {
  name: 'team_inbox_check',
  description: 'check the inbox',
  input_schema: { type: 'object', properties: {} },
  run: async () => 'ok',
};

describe('priceUsage (ADR 251 §6 — cost computed by the harness, never self-reported)', () => {
  it('prices opus-tier usage from the list table, cache tiers included', () => {
    // $5/MTok in, $25/MTok out; cache read 0.1x input, cache write 1.25x input.
    const cost = priceUsage('claude-opus-5', {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 100_000,
    });
    expect(cost).toBeCloseTo(5 + 2.5 + 0.1 + 0.625, 6);
  });

  it('prices each family off its own rate', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expect(priceUsage('claude-haiku-4-5', u)).toBeCloseTo(1, 6);
    expect(priceUsage('claude-sonnet-5', u)).toBeCloseTo(3, 6);
    expect(priceUsage('claude-fable-5', u)).toBeCloseTo(10, 6);
  });

  it('returns undefined for a model it cannot price — honest absence, never a guess', () => {
    expect(priceUsage('gpt-5.2-codex', usage(1000, 1000))).toBeUndefined();
    expect(priceUsage('unknown', usage(1000, 1000))).toBeUndefined();
  });
});

describe('anthropicEngine.run', () => {
  it('drives the loop to completion, summing usage and per-turn cost', async () => {
    const turns: EngineTurn[] = [];
    const client = fakeClient({
      messages: [
        { content: [{ type: 'tool_use', name: 'team_inbox_check', input: {} }], stop_reason: 'tool_use', usage: usage(1000, 100) },
        { content: [{ type: 'text', text: 'answered' }], stop_reason: 'end_turn', usage: usage(2000, 200) },
      ],
      toolResults: [[{ type: 'tool_result', content: 'ok' }], null],
    });
    const engine = anthropicEngine({ client: client as never });
    const result = await engine.run({
      model: 'claude-opus-5',
      prompt: 'check your inbox',
      tools: [noopTool],
      onTurn: (t) => turns.push(t),
    });

    expect(result.end).toBe('completed');
    expect(result.turns).toBe(2);
    expect(result.usage.input_tokens).toBe(3000);
    expect(result.usage.output_tokens).toBe(300);
    // Summed cost equals the sum of the two turns' priced usage.
    const expected = (1000 * 5 + 100 * 25 + 2000 * 5 + 200 * 25) / 1e6;
    expect(result.cost_usd).toBeCloseTo(expected, 9);

    expect(turns).toHaveLength(2);
    expect(turns[0]!.index).toBe(1);
    expect(turns[0]!.cost_usd).toBeCloseTo((1000 * 5 + 100 * 25) / 1e6, 9);
    // The capture record carries the assistant content AND the tool results of that turn.
    expect(turns[0]!.transcript).toMatchObject({
      assistant: [{ type: 'tool_use', name: 'team_inbox_check' }],
      tool_results: [{ type: 'tool_result' }],
    });
    expect(turns[1]!.transcript).toMatchObject({ assistant: [{ type: 'text' }], tool_results: null });
  });

  it('passes the resolved model and bounds through verbatim — never a hardcoded default', async () => {
    let seen: Record<string, unknown> | undefined;
    const client = fakeClient({
      messages: [{ content: [], stop_reason: 'end_turn', usage: usage(1, 1) }],
      onCreate: (params) => {
        seen = params;
      },
    });
    await anthropicEngine({ client: client as never }).run({
      model: 'claude-sonnet-5',
      prompt: 'hi',
      tools: [],
      maxTurns: 7,
    });
    expect(seen?.['model']).toBe('claude-sonnet-5');
    expect(seen?.['max_iterations']).toBe(7);
  });

  it('reports max_turns when the cap cut off a loop that still wanted tools', async () => {
    const client = fakeClient({
      messages: [
        { content: [{ type: 'tool_use', name: 'team_inbox_check', input: {} }], stop_reason: 'tool_use', usage: usage(10, 10) },
      ],
      toolResults: [[{ type: 'tool_result', content: 'ok' }]],
    });
    const result = await anthropicEngine({ client: client as never }).run({
      model: 'claude-opus-5',
      prompt: 'hi',
      tools: [noopTool],
      maxTurns: 1,
    });
    expect(result.end).toBe('max_turns');
    expect(result.turns).toBe(1);
  });

  it('classifies a 401 as auth — the deferral signal, a machine property not a work failure', async () => {
    const err = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    const client = fakeClient({ error: err });
    const result = await anthropicEngine({ client: client as never }).run({
      model: 'claude-opus-5',
      prompt: 'hi',
      tools: [],
    });
    expect(result.end).toBe('auth');
    expect(result.reason).toContain('invalid x-api-key');
  });

  it('classifies an abort as aborted, keeping the usage of turns that already ran', async () => {
    const controller = new AbortController();
    const abortErr = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    const client = fakeClient({
      messages: [
        { content: [{ type: 'tool_use', name: 'team_inbox_check', input: {} }], stop_reason: 'tool_use', usage: usage(50, 5) },
      ],
      toolResults: [[{ type: 'tool_result', content: 'ok' }]],
      error: abortErr,
      errorAfter: 1,
    });
    const result = await anthropicEngine({ client: client as never }).run({
      model: 'claude-opus-5',
      prompt: 'hi',
      tools: [noopTool],
      signal: controller.signal,
    });
    expect(result.end).toBe('aborted');
    expect(result.turns).toBe(1);
    expect(result.usage.input_tokens).toBe(50);
  });

  it('surfaces other errors as error with a bounded reason', async () => {
    const client = fakeClient({ error: new Error('overloaded'.repeat(100)) });
    const result = await anthropicEngine({ client: client as never }).run({
      model: 'claude-opus-5',
      prompt: 'hi',
      tools: [],
    });
    expect(result.end).toBe('error');
    expect(result.reason!.length).toBeLessThanOrEqual(200);
  });

  it('never lets a throwing onTurn observer kill the loop', async () => {
    const client = fakeClient({
      messages: [{ content: [], stop_reason: 'end_turn', usage: usage(1, 1) }],
    });
    const result = await anthropicEngine({ client: client as never }).run({
      model: 'claude-opus-5',
      prompt: 'hi',
      tools: [],
      onTurn: () => {
        throw new Error('observer bug');
      },
    });
    expect(result.end).toBe('completed');
  });
});
