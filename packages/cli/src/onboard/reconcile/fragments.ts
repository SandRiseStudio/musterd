import { createHash } from 'node:crypto';
import type { FragmentScope, HarnessId, LocalStateIssue, Surface } from '@musterd/protocol';
import { SURFACES } from '@musterd/protocol';
import type { HarnessContext } from './context.js';

/**
 * The fragment-oriented adapter contract (ADR 281/282). A harness is no longer a lifecycle object
 * musterd drives ("configure yourself here") — it is a DESCRIBER of managed fragments: independent,
 * individually fingerprinted units (one MCP entry, one hook, one permission item, one guidance
 * block) inside physical containers the reconciler locks, journals, and patches one at a time.
 * One adapter can touch multiple independently locked containers (ADR 282's frozen per-fragment
 * ownership decision); nothing here consults ambient cwd/home — everything flows through
 * {@link HarnessContext} seams.
 */

/** One physical config container an adapter manages fragments in — the unit of locking. */
export interface HarnessContainer {
  /** Stable lock key for this container (hashed for journal/lock filenames — never a path leak). */
  containerKey: string;
  scope: FragmentScope;
  /** Adapter-private handle (a path, a CLI target, …). Opaque to the engine. */
  handle: unknown;
}

export interface HarnessTarget {
  containers: HarnessContainer[];
}

/** One desired managed fragment: where it lives, what it should contain, and its canonical hash. */
export interface FragmentIntent {
  harness: HarnessId;
  /** The stable ledger key (scope-discriminated — see the resource-key builders below). */
  resourceKey: string;
  containerKey: string;
  /** The independently managed subtree or marked block inside the container. */
  fragmentKey: string;
  scope: FragmentScope;
  /** SHA-256 of the canonical fragment representation ({@link canonicalFingerprint}). */
  fingerprint: string;
  /** The canonical fragment representation itself. Adapter-defined shape. */
  payload: unknown;
}

/** What an adapter finds when it reads a fragment back from its container. */
export type ObservedFragment =
  | { state: 'absent' }
  | { state: 'present'; fingerprint: string }
  /** A recognized musterd registration still carrying the retired `MUSTERD_SURFACE` marker (ADR 286). */
  | { state: 'legacy-launch-marker'; fingerprint: string }
  /** The container exists but does not parse/validate — nothing in it may be touched. */
  | { state: 'invalid-container'; issues: readonly LocalStateIssue[] };

/** One journaled physical change the engine asks an adapter to apply. */
export type FragmentMutation =
  | { kind: 'write'; intent: FragmentIntent }
  | { kind: 'remove'; intent: FragmentIntent }
  /** Confirmed-configure only (ADR 286 §1): replace the retired launch marker, nothing else. */
  | { kind: 'repair-launch-marker'; intent: FragmentIntent };

export interface HarnessAvailability {
  available: boolean;
  detail?: string;
}

/** The pluggable fragment adapter. */
export interface HarnessAdapter {
  id: HarnessId;
  /** The Presence surface this harness's launcher attaches with (`MUSTERD_LAUNCH_SURFACE` value). */
  surface: Surface;
  /** Bumped when the adapter's fragment representation changes shape — recorded in the ledger. */
  adapterVersion: number;
  availability(ctx: HarnessContext): Promise<HarnessAvailability>;
  target(ctx: HarnessContext): Promise<HarnessTarget>;
  desiredFragments(ctx: HarnessContext, target: HarnessTarget): Promise<FragmentIntent[]>;
  observe(ctx: HarnessContext, intent: FragmentIntent): Promise<ObservedFragment>;
  apply(ctx: HarnessContext, mutation: FragmentMutation): Promise<void>;
}

/** SHA-256 over the canonical (key-sorted) JSON of a payload — equal values hash equal, whatever
 *  the construction order. Array order is meaning and is preserved. */
export function canonicalFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Resource keys are the ledger's identity for a fragment, so their scope discriminators are the
 * spec's (ADR 282 §3): folder keys carry the normalized REAL worktree root; repo-shared keys carry
 * the resolved repository root plus the registration identity (never a worktree); machine keys
 * carry neither. `\u0000` separators keep path bytes from ever colliding with the grammar.
 */
export function folderResourceKey(
  worktreeRoot: string,
  harness: HarnessId,
  fragmentKey: string,
): string {
  return `folder\u0000${worktreeRoot}\u0000${harness}\u0000${fragmentKey}`;
}

export function repoSharedResourceKey(
  repositoryRoot: string,
  registrationId: string,
  harness: HarnessId,
  fragmentKey: string,
): string {
  return `repo-shared\u0000${repositoryRoot}\u0000${registrationId}\u0000${harness}\u0000${fragmentKey}`;
}

export function machineResourceKey(harness: HarnessId, fragmentKey: string): string {
  return `machine\u0000${harness}\u0000${fragmentKey}`;
}

/** The shipped selection order. Future adapters sort after, alphabetically — stable and total. */
const REGISTRY_ORDER: readonly string[] = ['claude-code', 'cursor', 'codex', 'musterd'];

export function registryOrder(adapters: HarnessAdapter[]): HarnessAdapter[] {
  return [...adapters].sort((a, b) => {
    const ia = REGISTRY_ORDER.indexOf(a.id);
    const ib = REGISTRY_ORDER.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Find an adapter by id. Unknown ids resolve to undefined — selection keeps them as `pending`. */
export function resolveAdapter(id: string, registry: HarnessAdapter[]): HarnessAdapter | undefined {
  return registry.find((a) => a.id === id);
}

/** The wire-level Surface an adapter attaches with. A declared surface outside the protocol enum
 *  degrades to `other` — a future adapter is pluggable WITHOUT a protocol change (ADR 281). */
export function surfaceForAdapter(adapter: HarnessAdapter): Surface {
  return (SURFACES as readonly string[]).includes(adapter.surface) ? adapter.surface : 'other';
}
