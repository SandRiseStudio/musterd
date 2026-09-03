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
 * Resolve the wake lease this session was spawned by (ADR 241), from `MUSTERD_WAKE_LEASE` — the
 * actuator sets it on the child alongside `MUSTERD_PROVENANCE`, so hooks and one-shot CLI sends
 * inherit it exactly as they inherit provenance.
 *
 * **Undefined when unset, always.** Unlike provenance, this resolver has no default and must never
 * grow one: a defaulted correlation token would make an unstamped session assert membership of a
 * lease it knows nothing about, and the whole point of the token is that presence rows carry
 * identity rather than a plausible description (ADR 236 — absence is not an assertion).
 */
export function resolveAttestedWakeLease(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env['MUSTERD_WAKE_LEASE']?.trim();
  return raw ? raw.slice(0, 64) : undefined;
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

/** The review-diversity spectrum (ADR 188): how decorrelated the reviewer is from the worker. */
export const REVIEW_GRADES = ['cross_family', 'cross_model', 'same_model'] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];

/**
 * Canonical model identity (ADR 188): trimmed, lowercased, with one trailing date stamp removed —
 * `claude-haiku-4-5-20251001` is the same MODEL as `claude-haiku-4-5`, just pinned. No other
 * inference: two IDs that differ after this are different models, full stop.
 */
export function normalizeModelId(model: string | null | undefined): string {
  if (!model) return MODEL_UNKNOWN;
  const normalized = model.normalize('NFC').trim().toLowerCase();
  if (normalized === '' || normalized === MODEL_UNKNOWN) return MODEL_UNKNOWN;
  return normalized.replace(/-\d{8}$/, '');
}

/**
 * Grade a worker/reviewer pairing, or null when either side cannot prove what it runs — an
 * ungradeable pairing is ineligible for routing and ungraded at close (ADR 158 posture).
 * Decorrelation is a spectrum (ADR 056): cross_family (claude → gpt) is the ideal, cross_model
 * (opus-5 → opus-4.8) is accepted — different checkpoints make different mistakes — and
 * same_model proves nothing and is never routed.
 */
export function reviewGrade(
  workerModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ReviewGrade | null {
  const worker = normalizeModelId(workerModel);
  const reviewer = normalizeModelId(reviewerModel);
  if (worker === MODEL_UNKNOWN || reviewer === MODEL_UNKNOWN) return null;
  if (modelFamily(worker) !== modelFamily(reviewer)) return 'cross_family';
  return worker === reviewer ? 'same_model' : 'cross_model';
}

/** Which tier supplied the attested model. `observed` outranks both declarations. */
export type AttestationSource = 'observed' | 'environment' | 'binding' | 'unknown';

/**
 * The attestation sources that travel on the wire — `unknown` is deliberately absent, because an
 * unattested occupancy carries no model to describe and the stamp is simply omitted (ADR 101's
 * warn-never-block posture; absence is not an assertion, ADR 236).
 *
 * Kept at the full four-value vocabulary rather than collapsed to observed-vs-declared, for the same
 * reason `model_observed` is never merged into `model`: `environment` is *this session's*
 * declaration (a harness passing its own pinned model) while `binding` is a provisioning snapshot,
 * and those rot at different rates. A consumer that only wants the coarse split can collapse it;
 * one that only ever receives the collapsed value can never get the finer one back.
 */
export const WIRE_ATTESTATION_SOURCES = ['observed', 'environment', 'binding'] as const;
export type WireAttestationSource = (typeof WIRE_ATTESTATION_SOURCES)[number];

/** Is this source one the wire carries (i.e. anything but `unknown`)? */
export function isWireAttestationSource(v: unknown): v is WireAttestationSource {
  return (WIRE_ATTESTATION_SOURCES as readonly unknown[]).includes(v);
}

/**
 * Does this source mean the value was *observed* (a harness probe saw it) rather than *declared* (a
 * human or config asserted it)? The distinction the per-act stamp exists to carry: an observed
 * stamp is a measurement, a declared one is an assumption, and a per-model aggregate that mixes
 * them is reporting a number it cannot support.
 */
export function isObservedAttestation(source: string | null | undefined): boolean {
  return source === 'observed';
}

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

/**
 * Why an idle seat is (or is not) a spendable wake target (ADR 189). Mark-not-filter: the pool keeps
 * every idle agent so diversity potential stays visible; dispatch only spends `wakeable` ones.
 *
 * Layers pass only facts they have — the server knows enrollment, the host knows the workspace —
 * via {@link wakeabilityFromFacts}. A fact a layer does not have is omitted, never invented.
 */
export const WAKEABILITIES = [
  'wakeable',
  'not_enrolled',
  'enrolled_dead_workspace',
  'enrolled_host_stale',
  'enrolled_seat_busy',
] as const;
export type Wakeability = (typeof WAKEABILITIES)[number];

/** Facts a layer knows about a seat's wake readiness. Omit unknowns; do not pass `false` for "I
 *  have not checked". */
export interface WakeabilityFacts {
  /** Is there a `residency` row for this seat? */
  enrolled: boolean;
  /** Host-only: does the registry entry's workspace still exist with a readable binding? */
  workspace_readable?: boolean;
  /** Host-only (or future host-heartbeat): is the enrolled host reachable / polling? */
  host_reachable?: boolean;
  /**
   * Quiescence (ADR 215): has this seat been quiet, by the caller's own line? `false` means the
   * audit trail shows it acting *just now* — presence calls it idle, the evidence disagrees.
   * OMIT when unknown; `unknown` is not quiet (ADR 169/189), and passing `true` for "I have not
   * checked" would spend a wake on a seat that is already up.
   */
  seat_quiet?: boolean;
}

/**
 * Shared wakeability predicate (ADR 189). Pure: same facts ⇒ same reason, on server or host.
 * Enrollment is the first gate; host refinements only apply to enrolled seats.
 *
 * Ordering is by what the reader can act on. The reachability defects come first — they name a
 * broken pointer an operator fixes — and `enrolled_seat_busy` comes last, because it is the one
 * transient reason: nothing is wrong with the seat, it is simply not a *spend* right now. A seat
 * that is both busy and unreachable must report the defect, not the weather.
 */
export function wakeabilityFromFacts(facts: WakeabilityFacts): Wakeability {
  if (!facts.enrolled) return 'not_enrolled';
  if (facts.workspace_readable === false) return 'enrolled_dead_workspace';
  if (facts.host_reachable === false) return 'enrolled_host_stale';
  if (facts.seat_quiet === false) return 'enrolled_seat_busy';
  return 'wakeable';
}

/**
 * One idle seat in the wake pool, and what waking it would bring (ADR 187) — plus whether dispatch
 * can actually wake it (ADR 189).
 *
 * `family` comes from the team's durable attestation record, not from presence — a seat that has gone
 * offline still last attested *something*, and discarding that is what made every idle seat read
 * `unknown` and quietly emptied the cross-family remedy. It is a memory of an observation, not an
 * observation, which is exactly why `attested_at` travels with it: the age is the reader's to
 * discount. Deliberately never expired — a woken seat re-attests on claim, so a stale guess costs one
 * wake and self-corrects, and can never produce a review whose diversity claim is false.
 *
 * `wakeability` is mark-not-filter: unenrolled cross-family seats stay in the pool (so the posture
 * still names the diversity gap) but are marked `not_enrolled` so ADR 179 increment 5 does not spend
 * a wake on a name dispatch cannot reach. ADR 219 adds the transient case to the same mark: a seat
 * whose audit trail shows it acting just now is `enrolled_seat_busy` — presence calls it idle, the
 * evidence disagrees, and waking it would buy a duplicate rather than a remedy.
 */
export interface WakeCandidate {
  seat: string;
  /** Last attested family, or `unknown` for a seat that has never attested one. */
  family: string;
  /** When that attestation was recorded; null when there is none. */
  attested_at: number | null;
  /** Can dispatch wake this seat? Marked, never filtered (ADR 189). */
  wakeability: Wakeability;
}

export interface FamilyPosture {
  state: FamilyPostureState;
  /** Live agents attesting a KNOWN family — the posture's denominator. */
  attesting: number;
  /** family → count among attesting agents, e.g. `{ claude: 3 }`. */
  families: Record<string, number>;
  /** Live agents attesting `unknown` — present, but they cannot prove anything (ADR 158). */
  unattested: number;
  /** Idle agents — the remedy list: monoculture is fixed by WAKING one. Entries carry what each seat
   *  would bring (ADR 187), so the list is a targeted remedy rather than a lottery ticket. */
  wake_pool: WakeCandidate[];
  /** Live humans. Beside the posture, not in it (see above). */
  humans_live: number;
  /** When this snapshot was taken — a posture without a timestamp masquerades as a durable fact. */
  computed_at: number;
}

/** How old an attestation is, in the coarsest unit that still says something (ADR 187). */
function attestationAge(at: number | null, now: number): string {
  if (at === null) return 'never attested';
  const hours = Math.max(0, Math.floor((now - at) / 3_600_000));
  if (hours < 1) return 'just now';
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

/**
 * The wake-pool clause: who is idle, what waking them would bring (ADR 187), and whether dispatch
 * can reach them (ADR 189). Ranking: wakeable cross-family first (the spendable remedy), then other
 * wakeable, then marked-but-unwakeable cross-family (so the diversity gap stays named), then the
 * rest. Never-attested sorts last inside each band. Truncation spends its three slots on that order.
 */
function describeWakePool(p: FamilyPosture, now: number = Date.now()): string {
  if (p.wake_pool.length === 0) return '';
  const diversity = (c: WakeCandidate): number =>
    c.family === MODEL_UNKNOWN ? 2 : (p.families[c.family] ?? 0) > 0 ? 1 : 0;
  const rank = (c: WakeCandidate): number => {
    const band = c.wakeability === 'wakeable' ? 0 : 1;
    return band * 10 + diversity(c);
  };
  const ordered = [...p.wake_pool].sort((a, b) => rank(a) - rank(b));
  const shown = ordered
    .slice(0, 3)
    .map((c) => {
      const age = attestationAge(c.attested_at, now);
      // Wakeable seats stay compact; non-wakeable ones carry the reason so the line does not imply
      // they are a spend target (the old "idle & enrollable" lie ADR 189 retires).
      return c.wakeability === 'wakeable'
        ? `${c.seat} (${c.family}, ${age})`
        : `${c.seat} (${c.family}, ${age}, ${c.wakeability})`;
    })
    .join(', ');
  const more = p.wake_pool.length > 3 ? ` +${String(p.wake_pool.length - 3)}` : '';
  return `; idle: ${shown}${more}`;
}

/**
 * One bounded human/agent-readable line for a posture — used where the posture rides an act or a
 * response and must not balloon (e.g. the `lane_submit` no-candidate sanction). Never one entry per
 * seat: the wake pool truncates at three names.
 */
export function describeFamilyPosture(p: FamilyPosture): string {
  const pool = describeWakePool(p);
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
