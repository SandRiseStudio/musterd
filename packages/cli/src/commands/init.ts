import type { Parsed } from '../args.js';
import { inspectProvisioning, runCheckBuild, runInitDoctor } from '../onboard/doctor.js';
import { runInit, runPruneBindings, runRefreshGuidance, runRefreshHooks } from '../onboard/init.js';
import { theme } from '../render/theme.js';
import { wireCommand } from './wire.js';

/**
 * `musterd init` — interactive first-run onboarding (detect harness → configure → join).
 * `musterd init --check` — read-only provisioning drift check (ADR 060); no prompts, no writes.
 * `musterd init --check --fix` — diagnose, then repair: entry drift goes to `musterd wire` (headless,
 *   repairs the whole repo-root-shared entry family), anything else to a full `musterd init` (ADR 087:
 *   one command diagnoses *and* fixes, instead of the check telling you to run a second command).
 * `musterd init --refresh-guidance` — rewrite the stamped skill/command files only (ADR 161); no
 *   prompts, no identity changes, safe in a live seat's worktree.
 * `musterd init --prune-bindings [--apply]` — report (or remove) registry entries whose folder is
 *   gone (ADR 162); credentials are never touched.
 */
export async function initCommand(parsed: Parsed): Promise<number> {
  // Guidance-only refresh: deliberately checked before `--check`, so `--check --refresh-guidance`
  // means "fix the guidance", never "run the whole interactive flow".
  if (parsed.flags['refresh-guidance']) return runRefreshGuidance();
  // Hook-only refresh (ADR 168), same precedence rule and the same reason: a stale or missing hook
  // is not an identity problem, so its repair must not route through the identity-rewriting flow.
  if (parsed.flags['refresh-hooks']) return runRefreshHooks();
  // Registry prune (ADR 162): reports by default, removes only with --apply. Local-file maintenance
  // like the refresh above — no daemon call, no identity, no credentials.
  if (parsed.flags['prune-bindings']) {
    return runPruneBindings({ apply: Boolean(parsed.flags['apply']) });
  }
  // `--check-build` (ADR 135): the hook-cheap freshness probe — one health fetch, one line on
  // mismatch, always exit 0. Kept separate from `--check` (which reads manifests + runs git).
  if (parsed.flags['check-build']) return runCheckBuild();
  if (parsed.flags['check']) {
    const code = await runInitDoctor(Boolean(parsed.flags['json']));
    // --fix folds the "now run `musterd init`" follow-up the check would otherwise print into one step.
    // JSON mode stays a pure read-only report (no interactive repair to intermix with the payload).
    if (code !== 0 && parsed.flags['fix'] && !parsed.flags['json']) {
      // Which repair depends on what drifted. Entry drift — the harness MCP entry disagreeing with
      // binding.json — is fixed by `musterd wire`: headless, no member minted, no bound-folder guard,
      // and because Claude Code keys that entry by repo ROOT it repairs every seat worktree at once.
      // Sending entry drift to `runInit` was actively harmful: it repaired the running seat by taking
      // the shared slot from whoever held it, who then hit `expired_grant` on wake.
      const { repair } = await inspectProvisioning(process.cwd());
      if (repair === 'wire') {
        process.stdout.write(
          `\n${theme.meta("entry drift — running `musterd wire` to rewrite this folder's MCP entry from binding.json…")}\n\n`,
        );
        return wireCommand(parsed);
      }
      process.stdout.write(
        `\n${theme.meta('drift found — running `musterd init` to repair…')}\n\n`,
      );
      return runInit();
    }
    return code;
  }
  return runInit();
}
