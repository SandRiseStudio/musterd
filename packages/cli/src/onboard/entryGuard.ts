import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
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
 * The primary checkout of **`workspaceDir`'s own repo**, or `undefined` when it cannot be determined.
 *
 * Read from `workspaceDir/.git` and nothing else. A git *worktree* carries a `.git` **file** holding
 * `gitdir: <common>/.git/worktrees/<name>`, so the primary checkout is the directory containing that
 * common `.git`. A primary checkout carries a `.git` **directory**, and is therefore its own answer.
 * No git subprocess, which matters in a path the doctor runs on every `init --check`.
 *
 * It must be derived from this workspace's own pointer rather than by scanning neighbours for one that
 * looks repo-ish. An earlier attempt did the latter and picked `/Users/nick/MoveTrail` — an unrelated
 * project that merely sat beside the seats and carried a binding. "Is a primary checkout" is a much
 * weaker question than "is the primary checkout of THIS worktree family", and only the second one is
 * safe to silence a drift check on.
 *
 * `undefined` is an abstention, not a verdict (ADR 173): it means "could not determine", which is NOT
 * the same fact as "the adapter is not in the primary checkout". `foreignAdapterNote` says so out loud
 * rather than collapsing it into either answer.
 */
export function primaryCheckoutFor(workspaceDir: string): string | undefined {
  const dotGit = join(workspaceDir, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return undefined; // no .git at all — not a checkout, or unreadable. Either way: cannot say.
  }
  if (stat.isDirectory()) return resolve(workspaceDir); // this IS the primary checkout
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!m?.[1]) return undefined;
  // `<common>/.git/worktrees/<name>` — everything before `/worktrees/` is the shared git dir, and its
  // parent is the primary checkout. A pointer without that segment is some other linking scheme, and
  // guessing at it is exactly what this function must not do.
  const idx = m[1].lastIndexOf(`${sep}worktrees${sep}`);
  if (idx === -1) return undefined;
  // Relative pointers are legal (git can write them), and resolve against the worktree itself.
  return dirname(resolve(workspaceDir, m[1].slice(0, idx)));
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
 * ## The primary checkout is not drift (2026-07-29)
 *
 * Claude Code keys the local MCP entry by **repo root**, so ONE entry serves every worktree of the
 * repo (ADR 143), and `resolveMcpLaunch()` points it at whichever checkout ran `musterd init` last.
 * Those two facts together made the original note unsatisfiable: measured on the dogfood fleet, the
 * adapter sat in the primary checkout and the note fired in **11 of 12** bound workspaces, each
 * telling its seat to run `musterd init` — a "repair" that repoints the single shared entry into
 * that seat and hands the same drift line to the other 11. Zero-sum, which is the exact shape ADR
 * 165 was written to remove ("every repair created the next victim"), and the same parity defect ADR
 * 171 fixed for the guidance doctor: a check must expect what its own repair would actually write,
 * across the whole fleet rather than in the folder it happens to run in.
 *
 * So an adapter in the repo's **primary checkout** is not drift — for a single shared slot it is the
 * best available state, and the only one all N seats can agree on. An adapter in a peer **worktree**
 * still is drift, and still gets the note: that is the original wild case, where one seat's build
 * silently serves everyone and vanishes if that seat's folder is removed.
 *
 * Returns undefined when the adapter is inside the target workspace, inside the primary checkout, in
 * a shared/global install, or anywhere that is not a known sibling seat worktree.
 */
export function foreignAdapterNote(
  entry: { args: string[] },
  opts: {
    workspaceDir: string;
    siblingDirs?: string[] | undefined;
    /** The repo's primary checkout, from `primaryCheckoutOf`. `undefined` = could not determine. */
    primaryCheckout?: string | undefined;
  },
): string | undefined {
  const adapter = entry.args[entry.args.length - 1];
  if (!adapter || isInside(adapter, opts.workspaceDir)) return undefined;
  // The shared install, not drift — see the block comment above. Checked before the sibling sweep
  // because the primary checkout is itself a bound seat in the dogfood layout, so it appears as a
  // sibling and would otherwise be reported as a peer worktree.
  if (opts.primaryCheckout !== undefined && isInside(adapter, opts.primaryCheckout))
    return undefined;
  for (const sibling of opts.siblingDirs ?? []) {
    if (isInside(adapter, sibling)) {
      // ADR 173: when the primary checkout could not be determined, this may in fact BE the shared
      // install and therefore fine. Keep reporting — the note is advisory and cheap — but name the
      // abstention rather than letting the reader assume it was ruled out.
      const caveat =
        opts.primaryCheckout === undefined
          ? ' (could not determine this repo’s primary checkout, so this may be the shared ' +
            'install rather than drift — treat it as unconfirmed)'
          : '';
      return (
        `the musterd MCP entry for ${basename(opts.workspaceDir)} launches its adapter from ` +
        `${adapter}, inside another seat's worktree (${basename(sibling)}) — this seat runs that ` +
        `checkout's build, and breaks if that folder moves${caveat}. Wire a shared install to make ` +
        `the entry self-contained. Do NOT run \`musterd init\` here to fix it: one entry is shared ` +
        `by every worktree of this repo (ADR 143), so that repoints it into this seat and hands the ` +
        `same line to all the others (ADR 165).`
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
