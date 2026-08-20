/**
 * Pure helpers for managing the musterd daemon as a macOS **LaunchAgent** (ADR 045). Everything here
 * is side-effect-free — plist generation and the `launchctl` argv builders — so the wiring is testable
 * without writing to `~/Library/LaunchAgents` or shelling out (mirrors the `notify/os.ts` split).
 *
 * macOS only for now. systemd (`--user`) and Windows are the named cross-platform seam — the
 * `serviceSupported` guard is where they slot in, exactly like `buildNotifyCommand`'s platform branch.
 */

/** The reverse-DNS LaunchAgent label (SandRise Studio owns the daemon). One per user domain. */
export const SERVICE_LABEL = 'studio.sandrise.musterd';

/**
 * The `/live` viewer's build-publisher (ADR 132). A single `StartInterval` agent: on each poll it
 * advances the dedicated `…/agents-live` worktree to `origin/main`, builds the web app, and atomically
 * publishes `dist/client` into the daemon's web-root — which the daemon (`SERVICE_LABEL`) serves from its
 * own origin. Distinct from the daemon so `--live` targets it without touching the daemon; it runs no
 * server and drops no session.
 *
 * `LIVE_SYNC_LABEL` is the *retired* ADR 124 main-tracker (`musterd-live-sync`) — kept only so
 * `uninstall`/`install --live` can boot out the old two-agent dev-server bundle on an in-place upgrade.
 */
export const LIVE_LABEL = 'studio.sandrise.musterd-live';
export const LIVE_SYNC_LABEL = 'studio.sandrise.musterd-live-sync';

/**
 * The wake actuator (ADR 131 inc 5): `musterd host` as a LaunchAgent, so "musterd makes any
 * harness always-on" survives a reboot instead of depending on a terminal someone left open.
 * `service … --wake` targets it (NOT `--host` — that flag is the daemon's bind host). Distinct
 * from the daemon: it runs no server and drops no teammate session when bounced; in-flight wake
 * runs keep their own watchdogs.
 */
export const HOST_LABEL = 'studio.sandrise.musterd-host';

/**
 * The daemon auto-refresher (ADR 118/130 fast-follow): a `StartInterval` agent that runs
 * `musterd service refresh --auto` on a poll. It is the daemon analogue of the `/live` publisher —
 * but where the publisher swaps flat files with no restart, the daemon's code can't hot-swap, so a
 * pickup *must* bounce the process. That makes the quiet-period policy (idle-else-notice) the whole
 * point, and it lives in the `--auto` tick, not here. `service … --auto` targets this agent (NOT
 * `--refresh`, which would collide with the `refresh` verb). Distinct from the daemon: it runs no
 * server and is safe to bounce.
 */
export const AUTOREFRESH_LABEL = 'studio.sandrise.musterd-autorefresh';

/**
 * The ADR 166 liveness sweep: a `StartInterval` agent that runs
 * `scripts/research/adr-166-slot-sweep.ts` over the binding registry and appends one JSONL row per
 * run. It exists because the flip (increment 2) left `demoted` — enumeration wrongly judging a live
 * seat not-live — watched by nothing but a script a human had to remember to type. Read-only: no
 * seat, no daemon, no lane, which is why it is safe on a timer at all. `service … --sweep` targets
 * it.
 */
export const SWEEP_LABEL = 'studio.sandrise.musterd-sweep';

/** Guardian probe (2026-08-13 guardian spec §1) — outside the daemon and autorefresh, both of
 *  which it watches. */
export const GUARDIAN_LABEL = 'studio.sandrise.musterd-guardian';

/** Stream supervisor (ADR 293) — reconciles the broadcast machine against the desired-state file. */
export const STREAMWATCH_LABEL = 'studio.sandrise.musterd-streamwatch';

/** Is process lifecycle management implemented for this platform yet? */
export function serviceSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inverse of {@link xmlEscape} — `&amp;` must resolve last so `&amp;lt;` round-trips to `&lt;`. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Read an installed daemon plist back to the `ProgramArguments` it runs — `[node, binJs, 'serve',
 * …]`. This is how `service refresh` learns the checkout the daemon *actually* runs from (ADR 118
 * hardening): the plist is the source of truth, not wherever the CLI happened to be invoked from, so
 * running `refresh` from a seat worktree still rebuilds the daemon's own checkout instead of silently
 * rebuilding the worktree and restarting the daemon on stale code. Returns null when the file isn't a
 * parseable plist with a non-empty `ProgramArguments` array.
 */
export function parsePlistProgramArguments(xml: string): string[] | null {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return null;
  const strings = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    xmlUnescape(m[1]!),
  );
  return strings.length > 0 ? strings : null;
}

/**
 * The `EnvironmentVariables` dict of an installed plist, or null when it has none. Used by
 * `service install` to PRESERVE a value nobody re-passed: the plist is rewritten from scratch on
 * every install, so without reading it back, one `musterd service install` would silently drop an
 * allow-list someone set weeks ago and break the overlay with a ✓ printed.
 *
 * Deliberately tolerant of hand-authored plists (PlistBuddy, a text editor) — the machine this
 * lands on has exactly that shape today, and a parser that only understood our own output would
 * "preserve" nothing on the one plist that most needs preserving.
 */
/** The plist's `Label`, or null when the file isn't a parseable plist. Hand-authored files
 *  walk past `service install` (ADR 232 §4) — the census reads the Label, never the filename. */
export function parsePlistLabel(xml: string): string | null {
  const m = xml.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/);
  if (!m) return null;
  const label = xmlUnescape(m[1]!).trim();
  return label.length > 0 ? label : null;
}

export function parsePlistEnvironment(xml: string): Record<string, string> | null {
  const block = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!block) return null;
  const out: Record<string, string> = {};
  for (const m of block[1]!.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g))
    out[xmlUnescape(m[1]!)] = xmlUnescape(m[2]!);
  return Object.keys(out).length > 0 ? out : null;
}

export interface PlistOpts {
  label: string;
  /** Absolute node binary (the one running the CLI — `process.execPath`). */
  node: string;
  /** Absolute path to the CLI entry (`…/packages/cli/dist/bin.js`). */
  binJs: string;
  /** Args after the binary — `['serve']`, optionally with `--port`/`--host`. */
  serveArgs: string[];
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
  /** PATH for child shellouts (osascript/notify-send/tail live here); launchd's default is minimal. */
  path: string;
  /**
   * Extra daemon environment baked into the plist. `MUSTERD_ALLOWED_HOSTS` is the first customer
   * (ADR 040): reaching the daemon over a Tailscale overlay needs the tailnet host allow-listed, and
   * before this the only way to set it was editing the plist by hand.
   */
  env?: Record<string, string>;
}

/**
 * The knobs a single LaunchAgent plist varies on. Daemon and viewer agents differ only in these —
 * `renderPlist` is the one XML template they share, so every plist escapes identically.
 */
export interface AgentPlistOpts {
  label: string;
  /** The `ProgramArguments` array, in order (already absolute). */
  programArguments: string[];
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
  /** `EnvironmentVariables > PATH`; omit for an agent whose script sets its own PATH. */
  path?: string;
  /** Extra daemon environment, merged into the same dict as PATH (`MUSTERD_ALLOWED_HOSTS`, ADR 040). */
  env?: Record<string, string>;
  /** Relaunch on any exit (the daemon + the KeepAlive viewer server); default false. */
  keepAlive?: boolean;
  /** Start at load/login; default true. */
  runAtLoad?: boolean;
  /** Re-run every N seconds (the viewer's main-tracker) instead of running forever. */
  startInterval?: number;
  /** Crash-loop damper (seconds); paired with `keepAlive`. */
  throttleInterval?: number;
}

/** The shared LaunchAgent XML template. Every dynamic value is XML-escaped — a path with `&` can't
 * break the doc. Keys are emitted in a fixed order; optional ones are elided when unset. */
/**
 * Rewrite a version-pinned Homebrew node path to the stable symlink beside it, when the two resolve
 * to the same binary. `/opt/homebrew/Cellar/node@22/22.22.0/bin/node` becomes
 * `/opt/homebrew/opt/node@22/bin/node`.
 *
 * **Why this exists.** `install` embeds `process.execPath`, which under Homebrew is a path with the
 * exact version in it. When Homebrew upgrades the formula, that directory goes away and every plist
 * still naming it becomes unloadable — launchd reports `EX_CONFIG` (78) and throttles, and because
 * `launchctl print` still says "loaded", nothing announces it. On 2026-07-25 both the wake actuator
 * and the auto-refresher were found dead this way, silently, since a `node@22` upgrade two days
 * earlier: the old binary was still on disk but its `libsimdjson` dylib had been removed with the
 * upgrade, so it failed at dyld load. The daemon survived only because a `service install` had
 * happened to run since.
 *
 * **Why the `opt/<formula>` link and not `bin/node`.** `/opt/homebrew/opt/node@22/bin/node` follows
 * the formula, so it tracks 22.22 → 22.23 and keeps the same major — which keeps `better-sqlite3`'s
 * native ABI valid. `/opt/homebrew/bin/node` follows whatever `node` is currently linked, which on
 * this machine is **node 26**: embedding that would swap the ABI out from under the daemon, the
 * exact crashloop the `install` ABI guard exists to prevent.
 *
 * The `resolve` check is the safety rail: the rewrite only happens when the stable path resolves to
 * the binary we are actually running, so this can never quietly point an agent at a different node.
 * Injected rather than imported so this module stays free of filesystem side effects.
 */
export function stableNodePath(exec: string, resolve: (p: string) => string): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/.exec(exec);
  if (!m) return exec; // not a Cellar path (nvm, system node, a container) — nothing to stabilise
  const candidate = `${m[1]}/opt/${m[2]}/${m[3]}`;
  try {
    if (resolve(candidate) === resolve(exec)) return candidate;
  } catch {
    /* no such link, or unreadable — keep the concrete path we know works */
  }
  return exec;
}

function renderPlist(o: AgentPlistOpts): string {
  const programArgs = o.programArguments
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const parts: string[] = [
    `  <key>Label</key>\n  <string>${xmlEscape(o.label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${programArgs}\n  </array>`,
    `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(o.workingDir)}</string>`,
    `  <key>RunAtLoad</key>\n  <${o.runAtLoad === false ? 'false' : 'true'}/>`,
  ];
  if (o.keepAlive) parts.push(`  <key>KeepAlive</key>\n  <true/>`);
  if (typeof o.startInterval === 'number')
    parts.push(`  <key>StartInterval</key>\n  <integer>${o.startInterval}</integer>`);
  if (typeof o.throttleInterval === 'number')
    parts.push(`  <key>ThrottleInterval</key>\n  <integer>${o.throttleInterval}</integer>`);
  // PATH and any extra env share ONE EnvironmentVariables dict: launchd keeps the last key of a
  // duplicated one, so emitting two dicts would silently drop PATH and leave the daemon's shellouts
  // with launchd's minimal default. PATH first, then the rest in sorted order so the plist is
  // byte-stable across installs (a re-install that reorders keys reads as a spurious change).
  const envEntries: [string, string][] = [
    ...(o.path ? ([['PATH', o.path]] as [string, string][]) : []),
    ...Object.entries(o.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ];
  if (envEntries.length > 0)
    parts.push(
      `  <key>EnvironmentVariables</key>\n  <dict>\n` +
        envEntries
          .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
          .join('\n') +
        `\n  </dict>`,
    );
  parts.push(`  <key>StandardOutPath</key>\n  <string>${xmlEscape(o.stdoutPath)}</string>`);
  parts.push(`  <key>StandardErrorPath</key>\n  <string>${xmlEscape(o.stderrPath)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${parts.join('\n')}
</dict>
</plist>
`;
}

/**
 * The daemon LaunchAgent plist. `RunAtLoad` + `KeepAlive` make it start at login and relaunch on crash
 * or any exit (`serve` runs forever, so any exit is restart-worthy); `ThrottleInterval` keeps a
 * crash-loop from hammering.
 */
export function buildPlist(o: PlistOpts): string {
  return renderPlist({
    label: o.label,
    programArguments: [o.node, o.binJs, ...o.serveArgs],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    path: o.path,
    ...(o.env ? { env: o.env } : {}),
    keepAlive: true,
    runAtLoad: true,
    throttleInterval: 10,
  });
}

/**
 * The wake-actuator LaunchAgent plist (ADR 131 inc 5): `musterd host` under the same
 * RunAtLoad+KeepAlive+throttle posture as the daemon — the poll loop runs forever, so any exit is
 * restart-worthy. `hostArgs` carries the operator's cadence/watchdog flags, baked at install time
 * (`--interval`/`--timeout` stay operator facts; per-seat policy arrives per wake order). PATH
 * matters twice here: launchd's default is minimal, and the actuator must both load the CLI's
 * native modules and let spawned harnesses find their own tooling.
 */
export function buildHostPlist(o: Omit<PlistOpts, 'serveArgs'> & { hostArgs: string[] }): string {
  return renderPlist({
    label: o.label,
    programArguments: [o.node, o.binJs, 'host', ...o.hostArgs],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    path: o.path,
    keepAlive: true,
    runAtLoad: true,
    throttleInterval: 10,
  });
}

/**
 * The auto-refresher LaunchAgent plist (ADR 118/130 fast-follow): runs `node bin.js service refresh
 * --auto …` on load and every `intervalSeconds`, then exits — so it is `StartInterval`, NOT KeepAlive
 * (unlike the daemon/host, which run forever). No generated script: the tick logic lives in the
 * testable `service refresh --auto` subcommand, so the plist runs the node command directly (like the
 * wake host). `refreshArgs` carries `['refresh', '--auto', '--mode', <mode>]`. PATH matters: the tick
 * shells out to `git` and `pnpm` for the rebuild, and launchd's default PATH is minimal.
 */
export function buildAutoRefreshPlist(
  o: Omit<PlistOpts, 'serveArgs'> & { refreshArgs: string[]; intervalSeconds: number },
): string {
  return renderPlist({
    label: o.label,
    programArguments: [o.node, o.binJs, 'service', ...o.refreshArgs],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    path: o.path,
    runAtLoad: true,
    startInterval: o.intervalSeconds,
    ...(o.env ? { env: o.env } : {}),
  });
}

/**
 * The ADR 166 liveness-sweep plist. Like the auto-refresher it is `StartInterval`, not KeepAlive —
 * one pass over the registry (~1s, read-only) and exit. Unlike it, the program is the research
 * script itself rather than a CLI verb: ADR 166 names that script as the primary instrument, and
 * running exactly the thing the ADR points at is what keeps the prose true. `scriptArgs` carries
 * `['--quiet']` so a clean run logs nothing and the log holds findings only.
 */
export function buildSweepPlist(
  o: Omit<PlistOpts, 'serveArgs' | 'binJs'> & {
    /** Absolute path to `scripts/research/adr-166-slot-sweep.ts`. */
    scriptPath: string;
    scriptArgs: string[];
    intervalSeconds: number;
  },
): string {
  return renderPlist({
    label: o.label,
    // Type-stripping the .ts source needs the flag on Node 22; harmless on 24+.
    programArguments: [
      o.node,
      '--disable-warning=ExperimentalWarning',
      o.scriptPath,
      ...o.scriptArgs,
    ],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    path: o.path,
    runAtLoad: true,
    startInterval: o.intervalSeconds,
  });
}

/**
 * The ADR 293 stream-supervisor plist. StartInterval like the sweep — one `stream ensure`
 * reconcile pass (~1s: read a JSON file, one `fly machine list`) and exit; a KeepAlive would
 * spin. The program is the CLI verb itself, the auto-refresher's shape.
 */
export function buildStreamwatchPlist(
  o: Omit<PlistOpts, 'serveArgs'> & { intervalSeconds: number },
): string {
  return renderPlist({
    label: o.label,
    programArguments: [o.node, o.binJs, 'stream', 'ensure'],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    path: o.path,
    runAtLoad: true,
    startInterval: o.intervalSeconds,
  });
}

/* ─── /live viewer (ADR 132): the build-publisher script + its plist ─────────────────────────────────
 * The viewer's logic is one generated shell script (advance the worktree to main, build the web app,
 * atomically publish the bundle into the daemon's web-root) rather than inline in a plist, because it does
 * multi-step git/pnpm/fs work. Script + plist are generated from these builders — versioned here, written
 * to disk by `installLive`, so the setup is reproducible and testable instead of hand-authored. */

export interface LiveScriptOpts {
  /** The dedicated detached-on-`origin/main` viewer worktree (the build happens here). */
  worktree: string;
  /** The checkout the worktree hangs off — used to re-create the worktree if it goes missing. */
  sourceRepo: string;
  /** The daemon's web-root — where the built bundle is atomically published for the daemon to serve. */
  webRoot: string;
  /** Dir holding the `node`/`pnpm` binaries the build needs on PATH. */
  nodeDir: string;
  /** Dir holding `git`. */
  gitDir: string;
}

const GEN_HEADER =
  '# Generated by `musterd service install --live` (ADR 132) — edits are overwritten on reinstall.';

/**
 * The build-publisher script: advance the viewer worktree to the tip of `origin/main`, build
 * `@musterd/protocol` then `@musterd/web`, and atomically publish `dist/client` into the daemon's
 * web-root (`webRoot`). Skips the (expensive) build when already current *and* the published tip
 * stamp matches `origin/main` (ADR 139) — so a failed build retries on the next poll instead of
 * exiting early because `index.html` from an older SHA is still present. The publish is a staged
 * copy on the web-root's own filesystem followed by a `rename` swap — so a request is never served
 * a half-written or emptied bundle. A failed build leaves the previously-published bundle in place.
 * Runs on load and every interval; it exits (no long-lived process, no server, no daemon restart).
 */
export function buildLiveBuildScript(o: LiveScriptOpts): string {
  // pnpm resolves from ~/Library/pnpm (corepack/standalone) or nodeDir; include both plus git + homebrew.
  // nodeDir first so launchd doesn't pick up an older Node from /usr/local/bin (Vite wants ≥20.19 / 22).
  const path = `${o.nodeDir}:${o.gitDir}:\${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `#!/bin/bash
${GEN_HEADER}
# musterd /live viewer — build-publisher (StartInterval). Builds protocol + web and publishes into the
# daemon's web-root; the daemon serves it from its own origin. No dev server, no daemon restart.
export PATH="${path}"
set -u
WORKTREE="${o.worktree}"
SOURCE_REPO="${o.sourceRepo}"
WEBROOT="${o.webRoot}"
STAMP="$WEBROOT/.published-sha"
# A deleted worktree must not become a silent success: the old \`cd || exit 0\` made every 60s run
# a quiet no-op while the daemon served a stale bundle (observed for a full day, 2026-07-24).
# Recover in place — prune the stale registration, re-add the worktree — and if that fails, say so
# loudly and exit 1 so the log and launchd both show a real failure.
if [ ! -e "$WORKTREE/.git" ]; then
  echo "$(date '+%F %T') worktree missing at $WORKTREE — re-creating from $SOURCE_REPO"
  git -C "$SOURCE_REPO" worktree prune 2>&1 || true
  git -C "$SOURCE_REPO" fetch --quiet origin main 2>&1 || true
  git -C "$SOURCE_REPO" worktree add --detach "$WORKTREE" origin/main 2>&1 || {
    echo "$(date '+%F %T') worktree re-create FAILED — /live will serve a stale bundle until this is fixed"
    exit 1
  }
fi
cd "$WORKTREE" || { echo "$(date '+%F %T') cannot cd to $WORKTREE"; exit 1; }

git fetch --quiet origin main 2>/dev/null || exit 0
TIP="$(git rev-parse origin/main 2>/dev/null || true)"
PUBLISHED="$(cat "$STAMP" 2>/dev/null || true)"
# Nothing to do when already on tip *and* that tip is what we last published — keep the poll cheap.
# (Do not key off index.html alone: a failed build leaves an older bundle and would never retry.)
if [ "$(git rev-parse HEAD 2>/dev/null)" = "$TIP" ] && [ -n "$TIP" ] && [ "$PUBLISHED" = "$TIP" ]; then
  exit 0
fi
git checkout --quiet --detach origin/main || true
echo "$(date '+%F %T') building $(git rev-parse --short HEAD)"

# Hold the build transcript aside and print it ONLY if the build fails. A successful publish is a
# one-line fact; its vite asset table is ~158 lines that nobody has ever read and that grew this log
# to 4.6 MB across 395 builds (measured 2026-08-04). A FAILED build is the opposite — the transcript
# is the entire reason the log exists — so failure dumps everything, install output included.
BUILD_OUT="$(mktemp -t musterd-live-build)"
trap 'rm -f "$BUILD_OUT"' EXIT
pnpm install --prefer-offline --silent > "$BUILD_OUT" 2>&1 || true
# Protocol first: web imports @musterd/protocol from dist; a new export is invisible until rebuilt.
if pnpm --filter @musterd/protocol build >> "$BUILD_OUT" 2>&1 && pnpm --filter @musterd/web build >> "$BUILD_OUT" 2>&1; then
  SRC="$WORKTREE/packages/web/dist/client"
  mkdir -p "$(dirname "$WEBROOT")"
  STAGE="$(dirname "$WEBROOT")/.web.next"
  rm -rf "$STAGE"
  cp -R "$SRC" "$STAGE"                       # stage on the web-root's own filesystem
  rm -rf "$WEBROOT.prev"
  [ -e "$WEBROOT" ] && mv "$WEBROOT" "$WEBROOT.prev"
  mv "$STAGE" "$WEBROOT"                       # atomic swap into place
  rm -rf "$WEBROOT.prev"
  git rev-parse HEAD > "$STAMP"
  echo "$(date '+%F %T') published $(git rev-parse --short HEAD) → $WEBROOT"
else
  echo "$(date '+%F %T') web build failed; keeping the previously published bundle. Build output:"
  cat "$BUILD_OUT"
fi
`;
}

export interface LivePlistOpts {
  label: string;
  /** Absolute path to the generated shell script this agent runs. */
  scriptPath: string;
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
}

/** The build-publisher plist — runs on load and every `intervalSeconds`; NOT KeepAlive (it exits). */
export function buildLiveBuildPlist(o: LivePlistOpts & { intervalSeconds: number }): string {
  return renderPlist({
    label: o.label,
    programArguments: ['/bin/bash', o.scriptPath],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    runAtLoad: true,
    startInterval: o.intervalSeconds,
  });
}

/** The launchd `gui/<uid>` domain target. */
export function guiDomain(uid: string | number): string {
  return `gui/${uid}`;
}

/** The launchd `gui/<uid>/<label>` service target. */
export function serviceTarget(uid: string | number, label: string): string {
  return `${guiDomain(uid)}/${label}`;
}

/** `launchctl bootstrap gui/<uid> <plist>` — load + (via RunAtLoad) start the agent. */
export function bootstrapArgs(uid: string | number, plistPath: string): string[] {
  return ['bootstrap', guiDomain(uid), plistPath];
}

/** `launchctl bootout gui/<uid>/<label>` — unload; KeepAlive cannot relaunch a booted-out agent. */
export function bootoutArgs(uid: string | number, label: string): string[] {
  return ['bootout', serviceTarget(uid, label)];
}

/** `launchctl kickstart -k gui/<uid>/<label>` — restart in place (kill if running, then start). */
export function kickstartArgs(uid: string | number, label: string): string[] {
  return ['kickstart', '-k', serviceTarget(uid, label)];
}

/** `launchctl print gui/<uid>/<label>` — the status source we parse. */
export function printArgs(uid: string | number, label: string): string[] {
  return ['print', serviceTarget(uid, label)];
}

export interface LaunchctlStatus {
  loaded: boolean;
  pid: number | null;
  state: string | null;
  /**
   * The agent's last exit code, when launchctl reports one. A non-zero value on an agent that is
   * "loaded" is the shape a silent death takes: `state = spawn scheduled` reads like health, and the
   * only thing distinguishing it from a working agent is this number. `78` (EX_CONFIG) is the one to
   * know — launchd could not execute the program at all, which is what a stale Homebrew node path
   * produces after an upgrade.
   */
  lastExit: number | null;
}

/**
 * Parse `launchctl print` output into a coarse status. When `print` failed (the agent isn't loaded),
 * pass `loaded: false` via `ok=false` and this returns the not-loaded shape without scanning.
 */
export function parseLaunchctlPrint(stdout: string, ok: boolean): LaunchctlStatus {
  if (!ok) return { loaded: false, pid: null, state: null, lastExit: null };
  const pidMatch = stdout.match(/\bpid = (\d+)/);
  // Capture the whole state value ("running", "waiting", "not running") — not just the first token,
  // which truncated an interval agent's "not running" to a misleading "not".
  const stateMatch = stdout.match(/\bstate = ([^\n]+)/);
  const exitMatch = stdout.match(/\blast exit code = (\d+)/);
  return {
    loaded: true,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1]!.trim() : null,
    lastExit: exitMatch ? Number(exitMatch[1]) : null,
  };
}

/**
 * The health headline for a **periodic one-shot** agent (`StartInterval`), or null when it is not
 * loaded and the caller owns that wording.
 *
 * launchd reports an interval agent as `state = not running` for almost its entire life — that is
 * simply what "idle between ticks" looks like, since the process only exists during a tick. Printing
 * that string as a status inverts its meaning for a human reader. Measured 2026-08-03: `service
 * status --auto` rendered `✓ daemon auto-refresher: not running` for a refresher with 2775 runs, a
 * zero last exit, and ticks observed landing on schedule — and it was read, reasonably, as an outage
 * worth investigating. A health line whose healthy case reads as "down" is broken however accurate
 * the underlying string is; the ✓ cannot out-argue the words next to it.
 *
 * So: name the state the *agent* is in, not the state the process is in. A real failure still reads
 * as one — `agentFailureNote` prints the detail beneath, and this refuses to say "idle" over a
 * non-zero exit rather than paper over it.
 */
export function intervalAgentLabel(st: LaunchctlStatus): string | null {
  if (!st.loaded) return null;
  if (st.pid !== null) return 'running a tick now';
  // Never ticked: `last exit code` is absent until the first run finishes. Distinct from idle —
  // right after `install` it is the expected state, and calling it "idle · last tick ok" would
  // claim a success that has not happened.
  if (st.lastExit === null) return 'loaded · no tick yet';
  if (st.lastExit !== 0) return `not running · last tick exited ${st.lastExit}`;
  return 'idle between ticks · last tick ok';
}

/**
 * A human-readable warning when a "loaded" agent is in fact dead, or null when it looks fine.
 *
 * The failure this exists for is quiet by construction: launchd keeps a crash-looping agent
 * *loaded*, so `status` reported health while the wake actuator and auto-refresher had been unable
 * to start for two days. An agent with no pid and a non-zero last exit is not running, whatever the
 * state string says.
 */
export function agentFailureNote(st: LaunchctlStatus, programExists?: boolean): string | null {
  if (!st.loaded) return null;
  if (programExists === false) {
    return 'its plist names a program that no longer exists — reinstall to re-point it (a Homebrew upgrade moves the node path)';
  }
  if (st.pid === null && st.lastExit !== null && st.lastExit !== 0) {
    return st.lastExit === 78
      ? 'launchd cannot execute it (EX_CONFIG 78) — usually a stale node path after an upgrade; reinstall'
      : `not running — last exit code ${st.lastExit}`;
  }
  return null;
}
