import type { Parsed } from '../args.js';
import { runCheckBuild, runInitDoctor } from '../onboard/doctor.js';
import { runInit } from '../onboard/init.js';
import { theme } from '../render/theme.js';

/**
 * `musterd init` — interactive first-run onboarding (detect harness → configure → join).
 * `musterd init --check` — read-only provisioning drift check (ADR 060); no prompts, no writes.
 * `musterd init --check --fix` — diagnose, then repair any drift by re-running init (ADR 087: one
 *   command diagnoses *and* fixes, instead of the check telling you to run a second command).
 */
export async function initCommand(parsed: Parsed): Promise<number> {
  // `--check-build` (ADR 135): the hook-cheap freshness probe — one health fetch, one line on
  // mismatch, always exit 0. Kept separate from `--check` (which reads manifests + runs git).
  if (parsed.flags['check-build']) return runCheckBuild();
  if (parsed.flags['check']) {
    const code = await runInitDoctor(Boolean(parsed.flags['json']));
    // --fix folds the "now run `musterd init`" follow-up the check would otherwise print into one step.
    // JSON mode stays a pure read-only report (no interactive repair to intermix with the payload).
    if (code !== 0 && parsed.flags['fix'] && !parsed.flags['json']) {
      process.stdout.write(
        `\n${theme.meta('drift found — running `musterd init` to repair…')}\n\n`,
      );
      return runInit();
    }
    return code;
  }
  return runInit();
}
