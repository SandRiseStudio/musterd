import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

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
 * **Where this runs, and why not at write time.** `buildEntry` derives an entry's env *from* the same
 * binding it is written beside, so at write time the two always agree and a comparison there is
 * tautological. The mismatch appears LATER: Claude Code keys its local MCP config by **repo root**,
 * so every seat worktree of one repo shares a single entry (ADR 143), and the next seat's
 * provisioning overwrites it while this workspace's `binding.json` stays as it was. So these checks
 * belong to the **inspection** path — comparing an entry a harness reports back against the binding
 * of the workspace it is supposed to serve — which is where the doctor calls them.
 */

// ADR 165 removed `assertEntryIdentity`, which compared the harness entry's baked secrets against
// binding.json. The entry no longer carries secrets, so there is nothing to compare; the doctor now
// flags any baked secret on presence instead. (It was already dead code — ADR 158 §6 said the doctor
// called it, and the doctor re-implemented half of it inline. The agent_key half never ran at all.)

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
 * A note (never a refusal) when an entry's adapter lives inside a *different seat's* workspace —
 * the shape found in the wild: ryder's entry launching `agents-miley/packages/mcp/dist/index.js`.
 *
 * This is a **staleness and fragility** problem, not an identity leak. The adapter anchors identity
 * on its cwd, walking up to that folder's `binding.json` (`mcp/config.ts`), so whose *copy* of the
 * binary runs never decided which seat it claims — the baked env did, which is why the secrets above
 * refuse and this does not. What a foreign path does cost: the seat silently runs another checkout's
 * build (skew you cannot see from here), and its MCP server breaks outright if that folder moves.
 *
 * It cannot be a refusal because it is indistinguishable from the canonical flow: provisioning is
 * normally run FROM another checkout (`/Users/nick/agents`, itself a bound seat), and
 * `resolveMcpLaunch()` resolves the adapter relative to the running CLI either way. Blocking on the
 * path would refuse musterd's own provisioning workflow while still not proving anything about
 * identity.
 *
 * Returns undefined when the adapter is inside the target workspace, in a shared/global install, or
 * anywhere that is not a known sibling seat worktree.
 */
export function foreignAdapterNote(
  entry: { args: string[] },
  opts: { workspaceDir: string; siblingDirs?: string[] | undefined },
): string | undefined {
  const adapter = entry.args[entry.args.length - 1];
  if (!adapter || isInside(adapter, opts.workspaceDir)) return undefined;
  for (const sibling of opts.siblingDirs ?? []) {
    if (isInside(adapter, sibling)) {
      return (
        `the musterd MCP entry for ${basename(opts.workspaceDir)} launches its adapter from ` +
        `${adapter}, inside another seat's workspace (${basename(sibling)}) — this seat runs that ` +
        `checkout's build, and breaks if it moves. Re-run \`musterd init\` here, or wire a shared ` +
        `install, to make the entry self-contained.`
      );
    }
  }
  return undefined;
}

/**
 * Sibling seat worktrees of `workspaceDir`: directories beside it that hold their own
 * `.musterd/binding.json`. This is the dogfood layout (`agents-ryder`, `agents-miley`, … beside each
 * other), which is exactly where cross-seat wiring goes wrong. Best-effort: an unreadable parent
 * yields none, and none means the checks above simply stay quiet.
 */
export function siblingWorkspaces(workspaceDir: string): string[] {
  const parent = dirname(resolve(workspaceDir));
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(parent, e.name);
    if (isInside(dir, workspaceDir)) continue; // the workspace itself
    if (existsSync(join(dir, '.musterd', 'binding.json'))) out.push(dir);
  }
  return out;
}
