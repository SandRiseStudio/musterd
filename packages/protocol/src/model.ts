import { PROVENANCES, type Provenance } from './acts.js';

/**
 * Model attestation helpers (ADR 101). musterd is the model-agnostic coordination layer, so *which
 * model sits in each seat* is data only musterd holds — attached per-occupancy (harness-attested,
 * never verified), stamped per-act, and aggregated at the **family** boundary: intra-family variants
 * are presumed correlated until the ADR 056 correlation research says otherwise, so `claude-*` vs
 * `gpt-*` is the decorrelation line the diversity flag draws, not exact model ids.
 */

/** The sentinel for a missing/unattested model. Legal and never blocks (warn-never-block); it
 *  poisons conclusions *honestly* — a chain with an unknown link is "diversity unverifiable,"
 *  never "diverse." */
export const MODEL_UNKNOWN = 'unknown';

/**
 * Resolve the model id this session should attest, from the environment: `MUSTERD_MODEL` wins (the
 * explicit declaration, the ADR 018 env-first ladder), else the harness's own `ANTHROPIC_MODEL`
 * (Claude Code passes its env to MCP subprocesses when the user pins a model). Undefined when
 * nothing declares one — attestation is optional by design (`unknown` is legal, never blocks).
 * Shared by the MCP adapter and the CLI claim paths so the two attest identically.
 */
export function resolveAttestedModel(env: Record<string, string | undefined>): string | undefined {
  const raw = (env['MUSTERD_MODEL'] ?? env['ANTHROPIC_MODEL'])?.trim();
  return raw ? raw.slice(0, 120) : undefined;
}

/**
 * Resolve the session provenance this client should attest, from `MUSTERD_PROVENANCE` — the wake
 * actuator sets it on every process it spawns (ADR 131 §6), and child processes (hooks, one-shot
 * CLI sends) inherit it. Undefined when unset or not a known provenance: the caller then sends
 * nothing and the server-side defaults govern. Provenance describes the *current* animation source
 * (newest-wins, ADR 131 §6 amendment) — sharing this resolver keeps the CLI's ambient touches and
 * the MCP adapter's claim frames attesting identically, so a woken session reads `wake` on the
 * roster from its very first hook-driven command, fresh or resumed.
 */
export function resolveAttestedProvenance(
  env: Record<string, string | undefined>,
): Provenance | undefined {
  const raw = env['MUSTERD_PROVENANCE'];
  return (PROVENANCES as readonly string[]).includes(raw ?? '') ? (raw as Provenance) : undefined;
}

/**
 * Derive the model family from an attested model id — the prefix up to the first version-ish
 * segment: `claude-opus-4-8` → `claude`, `gpt-5.2-codex` → `gpt`, `gemini-3-pro` → `gemini`.
 * The family is the leading alphabetic token of the id (lowercased, NFC); anything that yields no
 * such token (empty, whitespace, a bare version) degrades to `unknown`.
 */
export function modelFamily(model: string | null | undefined): string {
  if (!model) return MODEL_UNKNOWN;
  const normalized = model.normalize('NFC').trim().toLowerCase();
  if (normalized === '' || normalized === MODEL_UNKNOWN) return MODEL_UNKNOWN;
  const match = normalized.match(/^[a-z]+/);
  return match ? match[0] : MODEL_UNKNOWN;
}
