import type { Surface } from '@musterd/protocol';
import type { ModelSource } from './config.js';

/**
 * The surfaces whose harness adapter declares an `observeModel` probe
 * (`packages/cli/src/onboard/harnesses/*.ts`). On one of these, an `observed` attestation was
 * *available* — so resolving to a declared tier instead means the probe did not run or its write
 * never landed, and the seat attests a snapshot for the whole session.
 *
 * This is the fact `resolveAttestation` cannot supply: it sees tiers, not which harness it is on.
 *
 * **It is deliberately NOT in `@musterd/protocol`.** Nothing here is contract-facing — no frame, no
 * schema, no wire value — and a second implementation of the protocol has no use for which of *our*
 * harness adapters ship a probe. Putting it beside `resolveAttestation` would have read tidier and
 * would have been wrong: it would gate a repo-local fact behind the protocol's ADR requirement while
 * teaching readers that the wire cares about it.
 *
 * The list is hand-kept because the registry that owns the truth lives in `@musterd/cli`, which
 * depends on this package rather than the other way round. It is not left to rot on that account:
 * `packages/cli/src/onboard/harnesses/probeCapability.test.ts` pins this list against
 * `HARNESSES.filter(h => h.observeModel)` from the far side of the dependency edge, so adding an
 * `observeModel` slot without adding its surface here fails the CLI suite.
 *
 * `cli`, `web`, `ios`, `slack`, `other` and `musterd` are absent because none has a probe to miss.
 * `cursor` was here until 2026-09-04 and is absent for a different reason (ADR 382): its probe was
 * removed because the field it read reports a model the session is not running, so there is no
 * longer an observation for a cursor seat to have missed and the warning would be nagging about a
 * probe that deliberately does not exist.
 */
export const PROBE_CAPABLE_SURFACES = [
  'claude-code',
  'codex',
  'grok',
  'opencode',
] as const satisfies readonly Surface[];

/** Does this surface's harness have a model probe that *could* have produced an observation? */
export function isProbeCapableSurface(surface: string | null | undefined): boolean {
  return (PROBE_CAPABLE_SURFACES as readonly string[]).includes(surface ?? '');
}

/**
 * Should this session warn that it is attesting a **declaration** where an observation was
 * reachable? True only on a probe-capable surface that resolved `binding` or `environment`.
 *
 * `observed` is the goal state and `unknown` has its own, louder warning (nothing was declared, so
 * there is no snapshot to distrust), so both stay silent here. Warn, never block (ADR 101).
 */
export function shouldWarnUnobservedModel(
  surface: string | null | undefined,
  source: ModelSource,
): boolean {
  if (source !== 'binding' && source !== 'environment') return false;
  return isProbeCapableSurface(surface);
}
