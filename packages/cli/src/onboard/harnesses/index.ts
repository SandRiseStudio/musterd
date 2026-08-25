import type { Harness } from '../harness.js';
import type { HarnessAdapter } from '../reconcile/fragments.js';
import { registryOrder } from '../reconcile/fragments.js';
import { claudeCode, claudeCodeAdapter } from './claudeCode.js';
import { codex, codexAdapter } from './codex.js';
import { cursor, cursorAdapter } from './cursor.js';
import { musterdAdapter } from './musterd.js';
import { opencode, opencodeAdapter } from './opencode.js';

/** The registry of onboarding-supported harnesses (pluggable; add more here). */
export const HARNESSES: Harness[] = [claudeCode, cursor, codex, opencode];

export {
  claudeCode,
  claudeCodeAdapter,
  codex,
  codexAdapter,
  cursor,
  cursorAdapter,
  musterdAdapter,
  opencode,
  opencodeAdapter,
};

/**
 * The fragment-adapter registry (ADR 281), in canonical selection order:
 * claude-code, cursor, codex, opencode, musterd. The internal musterd-core guidance producer is
 * NOT here — it is not selectable; the engine appends it itself, desired whenever the selection
 * is nonempty.
 */
export function harnessAdapters(): HarnessAdapter[] {
  return registryOrder([
    claudeCodeAdapter,
    cursorAdapter,
    codexAdapter,
    opencodeAdapter,
    musterdAdapter,
  ]);
}
