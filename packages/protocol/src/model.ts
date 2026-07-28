import { PROVENANCES, type Provenance } from './acts.js';
import type { ModelObservation } from './binding.js';

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

/** Which tier supplied the attested model. `observed` outranks both declarations. */
export type AttestationSource = 'observed' | 'environment' | 'binding' | 'unknown';

export interface AttestationInput {
  /** The hook-written observation for this workspace, if a harness probe produced one. */
  observed?: ModelObservation | undefined;
  /** The env declaration, already resolved via {@link resolveAttestedModel}. */
  env?: string | undefined;
  /** The persisted declaration (`binding.model`). */
  binding?: string | undefined;
}

export interface AttestationResult {
  /** What to attest. `undefined` ⇒ `unknown` (legal, never blocks). */
  model: string | undefined;
  source: AttestationSource;
  /** True when an observation contradicts a declaration — the tripwire signal. */
  drift: boolean;
  /** The declared value that lost to an observation, for the tripwire message. */
  declared?: string | undefined;
}

/**
 * Resolve what this session should attest, ordered by **kind of claim**: an observation (what a
 * harness was *seen* running this session) always beats a declaration (what a human or a config
 * *says* it runs), which beats `unknown`. Within the declared tier the ADR 018 env-first ladder still
 * holds: `MUSTERD_MODEL`/`ANTHROPIC_MODEL` over `binding.model`.
 *
 * This inverts the defect it exists for. Provisioning used to bake a wire-time snapshot into the env
 * — the TOP rung — so a guess outranked every later observation and nothing downstream could correct
 * it; one seat attested `grok-4.5` for weeks while running `claude-opus-4-8`. A declaration is a
 * snapshot and snapshots rot, so an observation must win.
 *
 * `drift` is true only when an observation and a declaration disagree. That is the tripwire signal,
 * and the rate at which it fires measures how often provisioning snapshots rot. A seat that declares
 * nothing is not drifting — it is merely unattested, which is honest.
 */
export function resolveAttestation(input: AttestationInput): AttestationResult {
  const declared = input.env ?? input.binding;
  if (input.observed) {
    return {
      model: input.observed.model,
      source: 'observed',
      drift: declared !== undefined && declared !== input.observed.model,
      declared,
    };
  }
  if (input.env) {
    return { model: input.env, source: 'environment', drift: false, declared: undefined };
  }
  if (input.binding) {
    return { model: input.binding, source: 'binding', drift: false, declared: undefined };
  }
  return { model: undefined, source: 'unknown', drift: false, declared: undefined };
}

/**
 * The team's model-family posture (ADR 172) — a **derived, never stored** statement about who is
 * attesting what, right now. A musterd agent is not bound to a model: a seat is a name, and what it
 * runs can change between sessions, so family comes only from live attestations and the posture is
 * only ever a snapshot stamped with `computed_at`.
 *
 * Three states, deliberately not two. `unknown` (fewer than 2 agents attesting a known family) is a
 * different fact from `monoculture` (≥2 attesting, all one family): collapsing them would read
 * "everyone HERE is claude" as "everyone ON THE TEAM is claude" — the same absent-vs-unknown
 * conflation the `no_candidate` close reason exists to prevent one level down (ADR 169).
 *
 * Humans are counted beside the posture, never inside it. Human review is its own requirement class
 * (the ADR 169 risk route), not a diversity substitute: one live human must not make an all-claude
 * agent fleet read `diverse`, because a human's presence does not decorrelate the agents' mistakes
 * (ADR 056).
 */
export const FAMILY_POSTURE_STATES = ['diverse', 'monoculture', 'unknown'] as const;
export type FamilyPostureState = (typeof FAMILY_POSTURE_STATES)[number];

export interface FamilyPosture {
  state: FamilyPostureState;
  /** Live agents attesting a KNOWN family — the posture's denominator. */
  attesting: number;
  /** family → count among attesting agents, e.g. `{ claude: 3 }`. */
  families: Record<string, number>;
  /** Live agents attesting `unknown` — present, but they cannot prove anything (ADR 158). */
  unattested: number;
  /** Enrolled agents with no live presence — the remedy list: monoculture is fixed by WAKING one. */
  wake_pool: string[];
  /** Live humans. Beside the posture, not in it (see above). */
  humans_live: number;
  /** When this snapshot was taken — a posture without a timestamp masquerades as a durable fact. */
  computed_at: number;
}

/**
 * One bounded human/agent-readable line for a posture — used where the posture rides an act or a
 * response and must not balloon (e.g. the `lane_ready` no-candidate sanction). Never one entry per
 * seat: the wake pool truncates at three names.
 */
export function describeFamilyPosture(p: FamilyPosture): string {
  const pool =
    p.wake_pool.length === 0
      ? ''
      : `; idle & enrollable: ${p.wake_pool.slice(0, 3).join(', ')}${
          p.wake_pool.length > 3 ? ` +${String(p.wake_pool.length - 3)}` : ''
        }`;
  const humans = p.humans_live > 0 ? `; ${String(p.humans_live)} human(s) live` : '';
  if (p.state === 'unknown') {
    const why =
      p.attesting === 0
        ? 'no agents attesting a known family'
        : `only ${String(p.attesting)} agent attesting a known family`;
    return `unknown — ${why}${pool}${humans}`;
  }
  const families = Object.entries(p.families)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f}×${String(n)}`)
    .join(', ');
  if (p.state === 'monoculture') {
    const family = Object.keys(p.families)[0] ?? MODEL_UNKNOWN;
    return `monoculture — ${String(p.attesting)} agents attesting, all ${family}${pool}${humans}`;
  }
  return `diverse — ${families}${pool}${humans}`;
}
