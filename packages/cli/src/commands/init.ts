import type { Parsed } from '../args.js';
import { runInit } from '../onboard/init.js';

/** `musterd init` — interactive first-run onboarding (detect harness → configure → join). */
export async function initCommand(_parsed: Parsed): Promise<number> {
  return runInit();
}
