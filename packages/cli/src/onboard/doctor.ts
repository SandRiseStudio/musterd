import { formatClaimPolicy } from '@musterd/protocol';
import { findBinding } from '../config.js';
import { theme } from '../render/theme.js';
import { HARNESSES } from './harnesses/index.js';
import { classifyPrimerTarget } from './primer.js';

/**
 * `musterd init --check` — provisioning drift detector (ADR 060). A read-only checker, never a
 * writer (the `arch-trees:check` / `fmt --check` philosophy): it reports whether this folder is
 * coherently provisioned and exits non-zero on drift, so a re-run of init is idempotent and a stale
 * setup is *visible* instead of silent.
 *
 * The drift it exists to catch: the SessionStart hook keys off the committed `AGENTS.md` primer
 * marker (which travels with the repo), but the MCP-server registration lives in the harness's
 * machine-local config (`claude mcp add -s local`, never committed). On a checkout where the marker
 * is present but no `claude mcp add` ran, the hook tells an agent it's auto-joined while the `team_*`
 * tools are absent — exactly the mismatch this surfaces. (Same gap the smarter SessionStart hook now
 * guards at session start; this is the on-demand half.)
 */

/** One harness's provisioning state in this folder. */
interface HarnessState {
  label: string;
  installed: boolean;
  configured: boolean;
  detail?: string;
}

export interface DoctorReport {
  /** Does AGENTS.md carry the managed musterd primer (the hook's trigger)? */
  primerManaged: boolean;
  harnesses: HarnessState[];
  /** Actionable drift lines (empty ⇒ healthy). */
  drift: string[];
  /** True when at least one installed harness has the musterd server registered. */
  anyConfigured: boolean;
}

export async function inspectProvisioning(cwd: string): Promise<DoctorReport> {
  const primerManaged = classifyPrimerTarget(cwd) === 'managed';
  // The folder's single source of truth for which seat it claims (ADR 018). A legacy MCP registration
  // may still carry a baked `MUSTERD_CLAIM` that outranks it — the value-coherence check below.
  const binding = findBinding(cwd);
  const boundClaim = binding?.claim ? formatClaimPolicy(binding.claim) : undefined;
  const drift: string[] = [];

  const harnesses: HarnessState[] = [];
  for (const h of HARNESSES) {
    const d = await h.detect();
    harnesses.push({
      label: h.label,
      installed: d.installed,
      configured: d.configured,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
    });
    // Value-coherence: a legacy baked MUSTERD_CLAIM that disagrees with binding.json pins this
    // harness's team_* tools to a stale seat while the CLI claims the current one (the re-claim drift).
    if (
      d.registeredClaim !== undefined &&
      boundClaim !== undefined &&
      d.registeredClaim !== boundClaim
    ) {
      drift.push(
        `${h.label}'s musterd server has a baked MUSTERD_CLAIM=${d.registeredClaim} but ` +
          `.musterd/binding.json claims ${boundClaim} — the team_* tools will resolve a different ` +
          `seat than the musterd CLI in this folder. Run \`musterd init\` to re-sync (it no longer ` +
          `bakes the claim, so binding.json becomes the single source of truth).`,
      );
    }
  }
  const installed = harnesses.filter((h) => h.installed);
  const anyConfigured = installed.some((h) => h.configured);

  // The headline gap: marker present (hook will claim "auto-joined") but no server registered.
  if (primerManaged && installed.length > 0 && !anyConfigured) {
    drift.push(
      'AGENTS.md has the musterd primer but no harness has the musterd MCP server registered for ' +
        'this folder — the SessionStart hook will tell an agent it is auto-joined while the team_* ' +
        'tools are unavailable. Run `musterd init` here to register the server.',
    );
  }
  // The reverse: server wired, but agents land with no primer to orient them.
  if (anyConfigured && !primerManaged) {
    drift.push(
      'The musterd MCP server is registered but AGENTS.md has no musterd primer — agents will have ' +
        'the team_* tools but no orientation and the SessionStart hook stays silent. Run `musterd init` ' +
        'to add the primer.',
    );
  }
  return { primerManaged, harnesses, drift, anyConfigured };
}

/** Render + exit-code for `musterd init --check`. Exit 1 on drift, 0 when healthy or unprovisioned. */
export async function runInitDoctor(json: boolean, cwd: string = process.cwd()): Promise<number> {
  const report = await inspectProvisioning(cwd);
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.drift.length > 0 ? 1 : 0;
  }

  for (const h of report.harnesses) {
    if (!h.installed) {
      process.stdout.write(`${theme.meta('·')} ${h.label}: not installed\n`);
      continue;
    }
    const mark = h.configured ? theme.ok('✓') : theme.warn('•');
    const state = h.configured ? 'musterd server registered' : 'no musterd server';
    const detail = h.detail ? theme.meta(` (${h.detail})`) : '';
    process.stdout.write(`${mark} ${h.label}: ${state}${detail}\n`);
  }
  const primer = report.primerManaged
    ? `${theme.ok('✓')} AGENTS.md: musterd primer present\n`
    : `${theme.warn('•')} AGENTS.md: no musterd primer\n`;
  process.stdout.write(primer);

  if (report.drift.length > 0) {
    process.stdout.write('\n');
    for (const d of report.drift) process.stdout.write(`${theme.err('✗')} ${d}\n`);
    return 1;
  }
  if (!report.primerManaged && !report.anyConfigured) {
    process.stdout.write(
      `\n${theme.meta('·')} this folder is not provisioned for musterd — run \`musterd init\` to set it up\n`,
    );
    return 0;
  }
  process.stdout.write(`\n${theme.ok('✓')} provisioning is coherent — primer and server agree\n`);
  return 0;
}
