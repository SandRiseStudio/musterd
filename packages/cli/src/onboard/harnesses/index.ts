import type { Harness } from '../harness.js';
import { claudeCode } from './claudeCode.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';

/** The registry of onboarding-supported harnesses (pluggable; add more here). */
export const HARNESSES: Harness[] = [claudeCode, cursor, codex];

export { claudeCode, codex, cursor };
