import type { Harness } from '../harness.js';
import type { HarnessAdapter } from '../reconcile/fragments.js';
import { registryOrder } from '../reconcile/fragments.js';
import { claudeCode } from './claudeCode.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { musterdAdapter } from './musterd.js';

/** The registry of onboarding-supported harnesses (pluggable; add more here). */
export const HARNESSES: Harness[] = [claudeCode, cursor, codex];

export { claudeCode, codex, cursor, musterdAdapter };

/**
 * INTERIM shim (Task 3 of the ADR 281 plan; Task 5 replaces it per adapter): wrap a lifecycle
 * {@link Harness} as a fragment {@link HarnessAdapter} that reports availability but manages no
 * fragments yet. The shim keeps the registry shape (order, ids, surfaces) real for selection and
 * scenario code while the external adapters are converted one by one.
 */
function shimAdapter(h: Harness): HarnessAdapter {
  return {
    id: h.id,
    surface: h.surface,
    adapterVersion: 1,
    availability: async () => {
      const d = await h.detect();
      return { available: d.installed, ...(d.detail !== undefined ? { detail: d.detail } : {}) };
    },
    target: async () => ({ containers: [] }),
    desiredFragments: async () => [],
    observe: async () => ({ state: 'absent' }),
    apply: async () => {
      throw new Error(`${h.id} is not yet converted to the fragment contract`);
    },
  };
}

/**
 * The fragment-adapter registry (ADR 281), in canonical selection order:
 * claude-code, cursor, codex, musterd. The native adapter is real; the three external adapters are
 * interim shims until Task 5 converts them.
 */
export function harnessAdapters(): HarnessAdapter[] {
  return registryOrder([
    shimAdapter(claudeCode),
    shimAdapter(cursor),
    shimAdapter(codex),
    musterdAdapter,
  ]);
}
