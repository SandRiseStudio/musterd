import {
  PROVENANCES,
  resolveAttestedModel,
  resolveAttestedWakeLease,
  type Provenance,
} from '@musterd/protocol';

/**
 * The "where"-on-attach label (ADR 014) lives in `@musterd/protocol/project` since 2026-09-04
 * (ADR 379 amendment) — the CLI's wake actuator and the adapter must run the SAME resolver, and
 * only `@musterd/protocol` may be imported across package boundaries (AGENTS.md). Re-exported here
 * for one FEATURE_EPOCH so `import { resolveWorkspace } from '@musterd/mcp'` keeps working.
 */
export { resolveWorkspace } from '@musterd/protocol/project';

/**
 * The wake correlation token (ADR 241) for this session, from `MUSTERD_WAKE_LEASE` via the shared
 * protocol resolver — so the adapter and the CLI's ambient touches attest the same value the same
 * way, exactly as they already do for model and provenance.
 *
 * Note the asymmetry with {@link resolveProvenance} directly below, which is deliberate: provenance
 * DEFAULTS (`session` is the honest description of an unlabelled session), and this one never does.
 * A default here would turn "I don't know what spawned me" into "this lease spawned me", which is
 * the false assertion ADR 236 exists to forbid and the exact bug this token was added to fix.
 */
export function resolveWakeLease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveAttestedWakeLease(env);
}

/** Read provenance from `MUSTERD_PROVENANCE`, defaulting to `session` (the common human-driven case). */
export function resolveProvenance(env: NodeJS.ProcessEnv = process.env): Provenance {
  const raw = env['MUSTERD_PROVENANCE'];
  return (PROVENANCES as readonly string[]).includes(raw ?? '') ? (raw as Provenance) : 'session';
}

/**
 * Driver co-presence (ADR 021): the human steering this session, read from `MUSTERD_DRIVER`
 * (capped at 80 chars) — the manual override tier; provisioning writes `binding.driver` instead
 * (ADR 165 inc 2) and `loadMcpConfig` falls back to it. The roster renders `driven by nick`
 * instead of showing the driving human offline. Undefined when unset — the adapter authenticates
 * only as the agent and never invents a driver it wasn't told about.
 */
export function resolveDriver(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['MUSTERD_DRIVER']?.trim();
  return raw ? raw.slice(0, 80) : undefined;
}

/**
 * Model attestation (ADR 101): the model id this harness session runs, resolved from the env
 * (`MUSTERD_MODEL`, else `ANTHROPIC_MODEL`) via the shared protocol helper. Attested, never
 * verified — only the harness knows; the value attaches to the *occupancy* (the durable seat stays
 * model-agnostic, ADR 087). Undefined when nothing declares it — the server renders that as
 * `unknown` and never blocks (a thin harness is legal).
 */
export function resolveModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveAttestedModel(env);
}
