/**
 * The loop-engine seam (ADR 251 §3): the native backend drives this interface and knows nothing
 * about which provider thinks inside it. Exactly one implementation ships (`anthropicEngine`,
 * `engines/anthropic.ts`); the seam exists because ADR 101 made model a variable and Track B
 * (ADR 110) keeps a local-model line open — the day a second provider is a real requirement, this
 * is the named insertion point. Provider-specific code (model ids, pricing, refusal handling)
 * lives only inside the engine file, never here and never in the backend.
 */

/** Token usage for one turn, or summed for a run — provider-neutral field names. */
export interface EngineUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One tool the loop may call. The backend bridges the seat's rendered MCP tools into these 1:1
 *  (ADR 251 §4) — the engine never knows it is talking to musterd; the bridge does. */
export interface EngineTool {
  name: string;
  description: string;
  /** JSON schema of the input (`type: "object"`), exactly as the MCP render published it. */
  input_schema: Record<string, unknown>;
  run(input: unknown): Promise<string>;
}

/** One completed turn, reported as it happens — the substrate for daemon-owned transcript capture
 *  and per-turn telemetry (ADR 251 §7). */
export interface EngineTurn {
  /** 1-based turn index. */
  index: number;
  usage: EngineUsage;
  /** This turn's usage priced by the engine; undefined when the model cannot be priced. */
  cost_usd?: number | undefined;
  stop_reason: string | null;
  /** Structured record of the turn (assistant content + tool results) for capture. */
  transcript: unknown;
}

/** How a run ended. `auth` is the deferral signal — missing/invalid credentials are a property of
 *  the machine, not of the work (the same posture as a missing CLI binary, ADR 221). */
export type EngineEndReason = 'completed' | 'max_turns' | 'aborted' | 'auth' | 'error';

export interface EngineRunSpec {
  /** Resolved via the ADR 101 env > binding ladder by the backend — the engine never defaults it. */
  model: string;
  /** The daemon-composed wake line, verbatim (ADR 131 §6). */
  prompt: string;
  tools: EngineTool[];
  /** `max_turns` from the wake bounds → the runner's iteration cap. */
  maxTurns?: number | undefined;
  /** The mandatory watchdog's abort signal (ADR 131 §6). */
  signal?: AbortSignal | undefined;
  /** Per-turn observer (capture + telemetry). Best-effort: a throwing observer never kills the loop. */
  onTurn?: ((turn: EngineTurn) => void) | undefined;
}

export interface EngineRunResult {
  turns: number;
  end: EngineEndReason;
  /** Summed cost across turns, computed by the harness from per-turn usage (ADR 251 §6) —
   *  undefined when the model cannot be priced, never a guess. */
  cost_usd?: number | undefined;
  usage: EngineUsage;
  /** Bounded failure detail for `auth`/`error` ends. */
  reason?: string | undefined;
}

/** The seam: given a prompt, a tool set, and bounds, run a loop; report turns, usage, and how it
 *  ended. */
export interface AgentLoopEngine {
  /** Provider label for logs/attestation context (e.g. `anthropic`). */
  readonly provider: string;
  run(spec: EngineRunSpec): Promise<EngineRunResult>;
}
