import type { Harness } from '../harness.js';
import { claudeCode } from './claudeCode.js';
import { cursor } from './cursor.js';

/** The registry of onboarding-supported harnesses (pluggable; add more here). */
export const HARNESSES: Harness[] = [claudeCode, cursor];

export { claudeCode, cursor };
