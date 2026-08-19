import { GUIDANCE_CONTENT_VERSION } from '@musterd/protocol';
import type { HarnessContext } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentIntent,
  type HarnessAdapter,
} from '../reconcile/fragments.js';
import { CANONICAL_SKILL_PATH } from '../guidance.js';

/**
 * The native musterd adapter (ADR 281): the selectable harness that is the `musterd host` agent
 * loop itself. Always available — it ships with the CLI — and it needs NO external registration:
 * the native bridge attaches with its intrinsic `musterd` Surface (ADR 286), so there is no MCP
 * entry, hook, or permission fragment to manage, and deselecting an external harness while keeping
 * `musterd` leaves a worktree fully steerable with zero external footprint.
 */
export const musterdAdapter: HarnessAdapter = {
  id: 'musterd',
  surface: 'musterd',
  adapterVersion: 1,
  availability: async () => ({ available: true, detail: 'native host (ships with the CLI)' }),
  target: async () => ({ containers: [] }),
  desiredFragments: async () => [],
  observe: async () => ({ state: 'absent' }),
  apply: async () => {
    throw new Error('the native musterd adapter owns no external fragments — nothing to apply');
  },
};

/**
 * The internal `musterd-core` fragment producer (ADR 281): the canonical `.musterd/skill/SKILL.md`
 * and shared primer/guidance surface. NOT a selectable adapter — it has no launcher and no Surface;
 * it is desired whenever the desired set is nonempty, because every selected harness's sessions
 * (and the native host's) read the same canonical guidance. Its fragments are folder-scoped, so its
 * ledger owners remain normalized worktree roots like any other folder fragment.
 */
export const MUSTERD_CORE_ID = 'musterd-core';

export function musterdCoreFragments(
  ctx: HarnessContext,
  desired: readonly string[],
): FragmentIntent[] {
  if (desired.length === 0) return [];
  const containerKey = `folder ${ctx.worktreeRoot} ${MUSTERD_CORE_ID} guidance`;
  // The payload names the guidance surface at its current content version; the physical render
  // (which needs the team name) rides the guidance writer — the fragment is the unit of ownership
  // and drift, not the renderer. Task 5 binds the full role/guidance projection through this.
  const payload = { path: CANONICAL_SKILL_PATH, contentVersion: GUIDANCE_CONTENT_VERSION };
  return [
    {
      harness: MUSTERD_CORE_ID,
      resourceKey: folderResourceKey(ctx.worktreeRoot, MUSTERD_CORE_ID, 'skill.canonical'),
      containerKey,
      fragmentKey: 'skill.canonical',
      scope: 'folder',
      fingerprint: canonicalFingerprint(payload),
      payload,
    },
  ];
}
