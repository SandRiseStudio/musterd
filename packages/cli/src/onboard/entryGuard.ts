import { basename, relative, resolve, sep } from 'node:path';

/**
 * The provisioning identity guard.
 *
 * `resolveMcpLaunch()` resolves the adapter path from the **provisioning process's own location**
 * (`import.meta.resolve`, with a relative dev fallback), so provisioning seat A's folder by running
 * seat B's CLI wires A to launch B's adapter — permanently, and silently. Found in the wild: ryder's
 * folder launching `/Users/nick/agents-miley/packages/mcp/dist/index.js`, carrying a grant from a
 * different provisioning run. That is what planted the stale model the observed-attestation tier
 * exists to correct; fixing only the precedence ladder would leave the planting mechanism intact.
 *
 * This is the one place musterd **blocks** rather than warns. The failure is silent, cross-seat, and
 * survived weeks undetected, while the cost of a refusal is re-running one provisioning command.
 */
export class EntryIdentityError extends Error {
  override name = 'EntryIdentityError';
}

export interface EntryIdentityOpts {
  /** Absolute path of the workspace this entry is being written for. */
  workspaceDir: string;
  /** The binding that workspace holds, if any — its secrets must match the entry's. */
  binding?: { agent_key?: string | undefined; grant?: string | undefined } | undefined;
  /**
   * Known sibling seat worktrees to reject adapter paths into. Only a *known* sibling is a refusal:
   * a global install or an unrelated checkout stays legal, because this guard exists to stop
   * cross-seat leakage, not to police unusual layouts.
   */
  siblingDirs?: string[] | undefined;
}

/**
 * Is `child` inside `parent` (or the same path)? Path-segment aware, so `/a/bc` is NOT inside `/a/b`
 * — sibling worktrees are routinely name-prefixed (`agents-ryder` / `agents-ryder2`), and a plain
 * `startsWith` would both over- and under-fire on exactly the paths this must tell apart.
 *
 * Exported because the doctor's read-only sweep needs the identical comparison — one definition,
 * so the live guard and the after-the-fact report can never disagree about what "inside" means.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * Throw {@link EntryIdentityError} if this MCP entry does not belong to the workspace it is being
 * written for: an adapter path inside a *sibling seat's* worktree, or secrets from another
 * provisioning run. Silent on everything else.
 */
export function assertEntryIdentity(
  entry: { args: string[]; env: Record<string, string> },
  opts: EntryIdentityOpts,
): void {
  const adapter = entry.args[entry.args.length - 1];
  if (adapter) {
    for (const sibling of opts.siblingDirs ?? []) {
      if (isInside(adapter, sibling) && !isInside(adapter, opts.workspaceDir)) {
        throw new EntryIdentityError(
          `refusing to wire ${basename(opts.workspaceDir)}: the adapter path ${adapter} lives inside ` +
            `another seat's workspace (${basename(sibling)}, at ${sibling}). This seat would launch ` +
            `${basename(sibling)}'s adapter forever, inheriting its provisioning. Re-run from ` +
            `${opts.workspaceDir}, or wire a shared install.`,
        );
      }
    }
  }

  const entryGrant = entry.env['MUSTERD_GRANT'];
  if (entryGrant && opts.binding?.grant && entryGrant !== opts.binding.grant) {
    throw new EntryIdentityError(
      `refusing to wire ${basename(opts.workspaceDir)}: the entry carries a grant that does not match ` +
        `this workspace's binding — it belongs to a different provisioning run. Re-mint with ` +
        `\`musterd agent <seat> --path ${opts.workspaceDir}\`.`,
    );
  }

  const entryKey = entry.env['MUSTERD_AGENT_KEY'];
  if (entryKey && opts.binding?.agent_key && entryKey !== opts.binding.agent_key) {
    throw new EntryIdentityError(
      `refusing to wire ${basename(opts.workspaceDir)}: the entry's agent key does not match this ` +
        `workspace's binding — it belongs to a different team or provisioning run.`,
    );
  }
}
