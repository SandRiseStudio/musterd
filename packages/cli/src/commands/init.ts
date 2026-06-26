import type { Parsed } from '../args.js';
import { runInitDoctor } from '../onboard/doctor.js';
import { runInit } from '../onboard/init.js';

/**
 * `musterd init` — interactive first-run onboarding (detect harness → configure → join).
 * `musterd init --check` — read-only provisioning drift check (ADR 060); no prompts, no writes.
 */
export async function initCommand(parsed: Parsed): Promise<number> {
  if (parsed.flags['check']) return runInitDoctor(Boolean(parsed.flags['json']));
  return runInit();
}
