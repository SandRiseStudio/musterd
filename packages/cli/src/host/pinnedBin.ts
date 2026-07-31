import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { configPath } from '../config.js';

/**
 * The pinned-binary shim: how a wake stops playing PATH roulette with its own toolchain.
 *
 * A woken session's musterd hooks are installed machine-wide and call a BARE `musterd`
 * (`command -v musterd >/dev/null && musterd session start --stdin`), so **PATH alone** decides
 * which build of musterd runs inside a wake. The host LaunchAgent's PATH is not the operator's
 * interactive PATH, and on the dogfood machine (measured 2026-07-29, lane `01KYQMM141`) it resolved
 * `/opt/homebrew/bin/musterd` — a Homebrew tarball frozen at the 2026-07-23 release, 147 commits of
 * hook logic behind the live dist the auto-refresher rebuilds. Both report version `0.3.1`, so
 * nothing could see the skew by version; only the ADR 130/135 `dist/build.json` ref differs.
 *
 * The fix is not a better PATH — it is *not inheriting the question*. Ordering makes PATH fixes
 * fragile in a way that is easy to get backwards: the sibling auto-refresh plist lists
 * `/opt/homebrew/bin` BEFORE `~/Library/pnpm`, so copying its PATH shape into the host plist still
 * resolves the frozen tarball. And repointing Homebrew's own symlink is machine surgery that dies on
 * the next `brew upgrade` (the Cellar trap already recorded in `resolveLiveCtx`).
 *
 * So the host exports the one binary it knows is correct: **the one it is itself running**. It writes
 * a tiny shim that execs its own `node` + entry, and prepends that directory to the spawned
 * harness's PATH. A woken session's musterd is then the actuator's build *by construction*, on any
 * machine layout — including a Homebrew-only user install, where the brew binary IS the actuator's
 * and pinning it is still the right answer. Nothing here edits a plist or a package manager, so the
 * fix ships through the auto-refresher like any other code change.
 *
 * Best-effort by contract, like every musterd hook: if the shim cannot be written the wake proceeds
 * on the inherited PATH rather than failing. A degraded pin is a stale hook; a thrown pin is a dead
 * rail.
 */

/** The shim's absolute path inside `dir`. Named `musterd` because that is what the hooks call. */
export function pinnedPath(dir: string): string {
  return join(dir, 'musterd');
}

/** Package names whose `bin.js` legitimately IS the musterd CLI. */
const MUSTERD_ENTRY_PACKAGES = new Set(['@musterd/cli', 'musterd']);

/**
 * The `name` of the package that owns `file`, by walking up to the nearest `package.json` — the same
 * ascent {@link readBuildStamp} uses, and for the same reason: it works from `src/` and `dist/`, at
 * any nesting depth. `undefined` when no package.json is found or it does not parse, which callers
 * must read as "cannot tell", never as "wrong".
 */
export function owningPackageName(file: string): string | undefined {
  try {
    let dir = dirname(file);
    for (let i = 0; i < 8; i++) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        return typeof name === 'string' ? name : undefined;
      }
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** What a woken session's `musterd` would actually be. `problem` set ⇒ its hooks are broken. */
export interface WakeMusterd {
  /** The shim the wake prepends to PATH. */
  shim: string;
  /** The entry it execs, when the shim is present and parseable. */
  binJs?: string;
  /** Set when a wake's musterd would not work; a human-readable one-liner. */
  problem?: string;
}

/**
 * Inspect the binary a wake would resolve — the report that did not exist when the shim above was
 * found poisoned, which is why it stayed broken for a day. Pure apart from the two file reads, and
 * `exists`/`read` are injectable so the states can be tested without a $HOME.
 *
 * Silent (no `problem`) when there is no shim at all: that is the un-pinned fallback, which is a
 * different lane's concern (PATH roulette) and not a fault of this file.
 */
export function inspectWakeMusterd(deps?: {
  dir?: string;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  owner?: (p: string) => string | undefined;
}): WakeMusterd {
  const dir = deps?.dir ?? join(dirname(configPath()), 'bin');
  const exists = deps?.exists ?? existsSync;
  const read = deps?.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const owner = deps?.owner ?? owningPackageName;
  const shim = pinnedPath(dir);
  if (!exists(shim)) return { shim };

  let body: string;
  try {
    body = read(shim);
  } catch {
    return { shim, problem: `the pinned shim ${shim} cannot be read` };
  }
  // The shim is ours and one line: exec "<node>" "<binJs>" "$@".
  const match = /^exec\s+"([^"]+)"\s+"([^"]+)"/m.exec(body);
  if (!match) return { shim, problem: `the pinned shim ${shim} is not in the expected exec form` };
  const [, node, binJs] = match as unknown as [string, string, string];

  if (!exists(node)) return { shim, binJs, problem: `its interpreter ${node} is missing` };
  if (!exists(binJs)) return { shim, binJs, problem: `the entry it execs (${binJs}) is missing` };
  const pkg = owner(binJs);
  if (pkg !== undefined && !MUSTERD_ENTRY_PACKAGES.has(pkg)) {
    return {
      shim,
      binJs,
      problem: `it execs ${binJs}, which belongs to "${pkg}" — not musterd`,
    };
  }
  return { shim, binJs };
}

export interface PinnedMusterdOpts {
  /** The actuator's own interpreter — `process.execPath`. */
  node: string;
  /** The actuator's own CLI entry — `process.argv[1]`, the live `dist/bin.js`. */
  binJs: string;
}

/**
 * Ensure `~/.musterd/bin/musterd` execs `node binJs`, and return the directory to prepend to a
 * woken harness's PATH. `undefined` means "could not pin" — the caller leaves PATH alone.
 *
 * Idempotent by content, so the common case touches no bytes: the host calls this on every wake.
 */
export function ensurePinnedMusterd(opts: PinnedMusterdOpts): string | undefined {
  // A relative entry would resolve against the *seat's* cwd inside the woken session, silently
  // pinning nothing (or the wrong thing). Absolute or not at all.
  if (!isAbsolute(opts.node) || !isAbsolute(opts.binJs)) return undefined;
  // …and absolute is not enough. `binJs` is `process.argv[1]`, which is only musterd's entry when
  // this code runs as musterd. Under a test runner it is the WORKER's entry, and that passed the
  // absolute check happily. Observed on the dogfood machine 2026-07-30: the shared shim was left
  // exec'ing `…/tinypool/dist/entry/process.js`, so every woken session got a `musterd` on PATH that
  // crashed on `process.send.bind` — `command -v musterd` succeeded, every hook call died, and the
  // session lost attestation, autojoin, and the interrupt line in silence for ~19 hours.
  //
  // Refuse only when the entry provably belongs to something else. An unidentifiable entry (no
  // package.json above it — a stripped tarball layout, say) still pins, because #516's whole point
  // was to serve installs like that, and failing closed there would silently restore PATH roulette
  // for the users it was written for.
  const owner = owningPackageName(opts.binJs);
  if (owner !== undefined && !MUSTERD_ENTRY_PACKAGES.has(owner)) return undefined;

  const dir = join(dirname(configPath()), 'bin');
  const shim = pinnedPath(dir);
  // Same shape Homebrew's own wrapper uses — exec, so no extra process survives the wake, and
  // "$@" passes the hook's arguments through untouched.
  const body = `#!/bin/sh\n# generated by musterd host — pins a woken session to the actuator's own build\nexec "${opts.node}" "${opts.binJs}" "$@"\n`;

  try {
    if (readFileSync(shim, 'utf8') === body) return dir;
  } catch {
    /* absent, unreadable, or stale — fall through and (re)write it */
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, body);
    chmodSync(shim, 0o755); // `command -v` only finds it if it is executable
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * The spawn environment for a woken harness: the inherited env, `wake` provenance, and PATH with the
 * pinned shim FIRST. Prepending is the whole point — `/opt/homebrew/bin` is already on the host's
 * PATH, so anything appended loses to the frozen tarball.
 */
export function wakeEnv(base: NodeJS.ProcessEnv, pinnedDir: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MUSTERD_PROVENANCE: 'wake' };
  if (!pinnedDir) return env;
  env['PATH'] = base['PATH'] ? `${pinnedDir}:${base['PATH']}` : pinnedDir;
  return env;
}
