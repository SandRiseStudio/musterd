import type { WorkspaceRepairBody } from '@musterd/protocol';
import { isDeclined } from './declined.js';
import { inspectArtifactDrift } from './doctor.js';
import { checkoutBehindHooks } from './harnesses/claudeCode.js';
import { runRefreshGuidance, runRefreshHooks, type RefreshHooksResult } from './init.js';

/**
 * Workspace self-heal (spec `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`,
 * ADR 408): the inspect → repair → re-inspect step the SessionStart probe runs before it reports.
 *
 * Pure over injected deps so the policy line is testable without a real folder's hooks. The line
 * itself is visible by ABSENCE: there is no permissions dep, because the ADR 261 floor is the
 * harness's own security boundary and is never written from a hook; and hooks are refreshed with
 * `withinWorktreeOnly`, so a file every seat shares is skipped and named, never made.
 */

/** The tombstone surface that switches self-heal off for one folder. */
export const SELF_HEAL_SURFACE = 'musterd:self-heal';

export interface SelfHealDeps {
  inspect: (cwd: string) => { guidance: string[]; hooks: string[]; permissions: string[] };
  refreshGuidance: (cwd: string, opts: { quiet: true }) => number;
  refreshHooks: (
    cwd: string,
    opts: { withinWorktreeOnly: true; quiet: true },
  ) => RefreshHooksResult;
  declined: (cwd: string) => boolean;
  checkoutBehind: (cwd: string) => boolean;
  /** The build doing the repairing — the dist stamp (ADR 135), or `unstamped`. */
  build: string;
}

export interface SelfHealOutcome {
  /** false when declined, checkout-behind, or there was nothing to do. */
  ran: boolean;
  /** null only when there was nothing to do. */
  report: WorkspaceRepairBody | null;
  /** '' when clean; otherwise ONE line, no trailing newline. */
  line: string;
}

type Skip = WorkspaceRepairBody['skipped'][number];

export function selfHealWorkspace(cwd: string, deps: SelfHealDeps): SelfHealOutcome {
  const before = deps.inspect(cwd);
  if (before.guidance.length + before.hooks.length + before.permissions.length === 0) {
    return { ran: false, report: null, line: '' };
  }

  const declined = deps.declined(cwd);
  const behind = !declined && deps.checkoutBehind(cwd);
  const held = declined || behind;

  const skipped: Skip[] = [];
  let repairedGuidance = 0;
  let repairedHooks = 0;

  if (held) {
    const reason = declined ? 'declined' : 'checkout_behind';
    if (before.guidance.length > 0) skipped.push({ class: 'guidance', reason });
    if (before.hooks.length > 0) skipped.push({ class: 'hooks', reason });
  } else {
    if (before.guidance.length > 0) {
      // A throwing refresh is reported as unrepaired below, never surfaced: the probe's contract
      // is exit 0 and one line, and the re-inspect is what says whether anything changed.
      try {
        if (deps.refreshGuidance(cwd, { quiet: true }) === 0) {
          repairedGuidance = before.guidance.length;
        }
      } catch {
        /* counted as remaining by the re-inspect */
      }
    }
    if (before.hooks.length > 0) {
      try {
        const r = deps.refreshHooks(cwd, { withinWorktreeOnly: true, quiet: true });
        repairedHooks = r.refused > 0 ? 0 : r.files.length;
        for (const path of r.skipped)
          skipped.push({ class: 'hooks', reason: 'outside_worktree', path });
      } catch {
        /* counted as remaining by the re-inspect */
      }
    }
  }
  // The permission floor is policy, not a failure — it is listed so the row says it was seen.
  if (before.permissions.length > 0) skipped.push({ class: 'permissions', reason: 'policy' });

  const after = held ? before : deps.inspect(cwd);
  const report: WorkspaceRepairBody = {
    build: deps.build,
    repaired: { guidance: repairedGuidance, hooks: repairedHooks },
    skipped,
    remaining: {
      guidance: after.guidance.length,
      hooks: after.hooks.length,
      permissions: after.permissions.length,
    },
  };
  return { ran: !held, report, line: composeLine(report, declined, behind) };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * ONE line, bounded by construction: counts and repair commands, never file lists — this lands in
 * model context at every session start (ADR 171). The only path it names is a skipped
 * outside-worktree file, because that is the one thing the reader must hand to a human.
 */
function composeLine(r: WorkspaceRepairBody, declined: boolean, behind: boolean): string {
  const fixes = [
    r.remaining.guidance > 0 ? '`musterd init --refresh-guidance`' : null,
    r.remaining.hooks > 0 ? '`musterd init --refresh-hooks`' : null,
    r.remaining.permissions > 0 ? '`musterd init --refresh-permissions`' : null,
  ].filter((s): s is string => s !== null);
  if (declined) {
    return (
      "musterd: this folder's provisioning is behind what this build writes and self-heal is " +
      `declined in this folder — run ${fixes.join(' and ')} to repair.`
    );
  }
  if (behind) {
    return (
      "musterd: this folder's provisioning differs from this build, but a hook here was written " +
      'by a NEWER musterd — this checkout is behind. Update it (`git pull` + `pnpm build`); ' +
      'nothing was rewritten (ADR 168).'
    );
  }
  const did = [
    r.repaired.guidance > 0 ? plural(r.repaired.guidance, 'guidance file', 'guidance files') : null,
    r.repaired.hooks > 0 ? plural(r.repaired.hooks, 'hook', 'hooks') : null,
  ].filter((s): s is string => s !== null);
  // A shared file is skipped on every run, drifted or not — the refresh never looks inside it. It
  // is the human's job only while hook drift remains after the repair; a current one is not named.
  const outside =
    r.remaining.hooks > 0
      ? r.skipped.filter((s) => s.reason === 'outside_worktree').map((s) => s.path ?? '')
      : [];
  const still: string[] = [];
  if (r.remaining.permissions > 0) still.push('the harness permission layer is still behind');
  if (outside.length > 0) {
    still.push(`${outside.join(', ')} is shared by every seat and needs a human`);
  }
  const unrepaired = r.remaining.guidance > 0 || (r.remaining.hooks > 0 && outside.length === 0);
  if (unrepaired) still.push('some drift could not be repaired');
  const head =
    did.length > 0 ? `musterd: repaired ${did.join(' and ')}` : 'musterd: repaired nothing';
  const tail = still.length > 0 ? `; ${still.join('; ')} — run ${fixes.join(' and ')}.` : '.';
  return head + tail;
}

/** The real wiring — every dep is the production function it names. */
export function defaultSelfHealDeps(build: string): SelfHealDeps {
  return {
    inspect: inspectArtifactDrift,
    refreshGuidance: (cwd, opts) => runRefreshGuidance(cwd, opts),
    refreshHooks: (cwd, opts) => runRefreshHooks(cwd, opts),
    declined: (cwd) => isDeclined(cwd, SELF_HEAL_SURFACE),
    checkoutBehind: checkoutBehindHooks,
    build,
  };
}
