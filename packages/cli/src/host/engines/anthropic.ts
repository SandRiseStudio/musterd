import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentLoopEngine,
  EngineRunResult,
  EngineRunSpec,
  EngineTurn,
  EngineUsage,
} from '../engine.js';

/**
 * The one shipping {@link AgentLoopEngine} (ADR 251 §3): `client.beta.messages.toolRunner` drives
 * the request → execute → repeat cycle; musterd owns everything else (context, session,
 * verification, cost accounting). All Claude-specific knowledge — SDK shapes, the pricing table,
 * error classification — lives in this file and nowhere else, so the vendor choice's blast radius
 * is bounded to it (ADR 251 Consequences).
 *
 * The model is never defaulted here: the backend resolves it via the ADR 101 env > binding ladder
 * and passes it through verbatim, so the native seat participates in model-as-a-variable exactly
 * like every other harness.
 */

/** Output cap per turn. Phase 1 wakes are coordination-only replies, not long deliverables. */
const MAX_TOKENS_PER_TURN = 16_000;

/** List prices per MTok (input, output), by model-id prefix. Cache read is 0.1x the input rate,
 *  cache write 1.25x (5m TTL — the runner's default). An unknown model prices to `undefined`:
 *  the wake ledger records honest absence, never a guess. */
const PRICES: readonly { prefix: string; input: number; output: number }[] = [
  { prefix: 'claude-fable', input: 10, output: 50 },
  { prefix: 'claude-mythos', input: 10, output: 50 },
  { prefix: 'claude-opus', input: 5, output: 25 },
  { prefix: 'claude-sonnet', input: 3, output: 15 },
  { prefix: 'claude-haiku', input: 1, output: 5 },
];

/** Price one turn's usage in USD from the list table; undefined when the model is not priceable. */
export function priceUsage(model: string, usage: Partial<EngineUsage>): number | undefined {
  const normalized = model.trim().toLowerCase();
  const row = PRICES.find((p) => normalized.startsWith(p.prefix));
  if (!row) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * row.input + output * row.output + read * 0.1 * row.input + write * 1.25 * row.input) /
    1e6
  );
}

/** Injectable client so the scripted suite never opens a socket or needs a key. */
export interface AnthropicEngineDeps {
  client?: Anthropic;
  /** Injectable construction — the SDK resolves credentials here, so this is the seam that makes
   *  the keyless-host path testable without touching a real credential. */
  createClient?: () => Anthropic;
}

const emptyUsage = (): EngineUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** Normalize the SDK's nullable usage fields into the seam's plain numbers. */
function toEngineUsage(raw: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): EngineUsage {
  return {
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    cache_read_input_tokens: raw.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: raw.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Auth failures are the deferral signal (a machine property, ADR 221); an abort is the watchdog.
 *
 * Two distinct auth shapes, and the second is the one that matters most in practice. A 401 is a key
 * the server rejected. But a host that was never given a key at all fails EARLIER, with the SDK's
 * credential-resolution error and no status code — and that is the ordinary state of any machine
 * running the actuator without native credentials. Measured live on the first native wake
 * (2026-08-12): unclassified, it read as a work failure and the daemon charged the act two of its
 * three attempts in four minutes, heading for `wake_exhausted` on an act no session ever received.
 * That is exactly the retire-the-act outcome ADR 221 exists to prevent, so the resolution failure
 * is matched on its message — the SDK raises a bare `AnthropicError` carrying no machine-readable
 * discriminator, and a keyless host must never burn budget.
 */
export function classifyEngineFailure(err: unknown): 'auth' | 'aborted' | 'error' {
  const e = err as { status?: number; name?: string; message?: string };
  if (e.status === 401) return 'auth';
  if (/could not resolve authentication|authentication method/i.test(e.message ?? ''))
    return 'auth';
  if (e.name === 'APIUserAbortError' || e.name === 'AbortError') return 'aborted';
  return 'error';
}

export function anthropicEngine(deps: AnthropicEngineDeps = {}): AgentLoopEngine {
  return {
    provider: 'anthropic',

    async run(spec: EngineRunSpec): Promise<EngineRunResult> {
      // Constructed lazily so a host with no key only fails when a native wake actually runs — and
      // guarded, because the SDK resolves credentials during construction on some paths and at
      // request time on others. Both roads lead to the same honest answer: this machine cannot
      // actuate, which defers (ADR 221) rather than charging the act.
      let client: Anthropic;
      try {
        client = deps.client ?? (deps.createClient ?? (() => new Anthropic()))();
      } catch (err) {
        return {
          turns: 0,
          end: classifyEngineFailure(err),
          usage: emptyUsage(),
          reason: ((err as Error).message ?? String(err)).slice(0, 200),
        };
      }
      const tools = spec.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as { type: 'object'; [k: string]: unknown },
        run: (args: unknown) => t.run(args),
        // The musterd MCP server validates inputs itself (zod, ADR 144) — the bridge passes
        // arguments through rather than re-validating against a schema it did not author.
        parse: (content: unknown) => content,
      }));

      const runner = client.beta.messages.toolRunner(
        {
          model: spec.model,
          max_tokens: MAX_TOKENS_PER_TURN,
          messages: [{ role: 'user', content: spec.prompt }],
          tools,
          ...(spec.maxTurns !== undefined ? { max_iterations: spec.maxTurns } : {}),
        },
        spec.signal ? { signal: spec.signal } : {},
      );

      const totals = emptyUsage();
      let turns = 0;
      let costTotal: number | undefined;
      let lastStop: string | null = null;
      let failure: { end: 'auth' | 'aborted' | 'error'; reason: string } | undefined;

      try {
        for await (const message of runner) {
          turns += 1;
          const usage = toEngineUsage(message.usage);
          totals.input_tokens += usage.input_tokens;
          totals.output_tokens += usage.output_tokens;
          totals.cache_read_input_tokens += usage.cache_read_input_tokens;
          totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
          const cost = priceUsage(spec.model, usage);
          if (cost !== undefined) costTotal = (costTotal ?? 0) + cost;
          lastStop = message.stop_reason;
          // `generateToolResponse` caches, so reading the transcript never re-runs a tool.
          const toolResponse =
            message.stop_reason === 'tool_use' ? await runner.generateToolResponse() : null;
          const turn: EngineTurn = {
            index: turns,
            usage,
            cost_usd: cost,
            stop_reason: message.stop_reason,
            transcript: {
              assistant: message.content,
              tool_results: toolResponse?.content ?? null,
            },
          };
          try {
            spec.onTurn?.(turn);
          } catch {
            // Observer bugs must never kill the run — capture is best-effort by design.
          }
        }
      } catch (err) {
        failure = {
          end: classifyEngineFailure(err),
          reason: ((err as Error).message ?? String(err)).slice(0, 200),
        };
      }

      if (failure) {
        return {
          turns,
          end: failure.end,
          usage: totals,
          cost_usd: costTotal,
          reason: failure.reason,
        };
      }
      // A loop that ended while the model still wanted tools was cut by the iteration cap.
      const end = lastStop === 'tool_use' ? 'max_turns' : 'completed';
      return { turns, end, usage: totals, cost_usd: costTotal };
    },
  };
}
