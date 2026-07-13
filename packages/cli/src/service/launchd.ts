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
  if (o.path)
    parts.push(
      `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xmlEscape(o.path)}</string>\n  </dict>`,
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
    keepAlive: true,
    runAtLoad: true,
    throttleInterval: 10,
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
 * The build-publisher script: advance the viewer worktree to the tip of `origin/main`, build the web
 * app, and atomically publish `dist/client` into the daemon's web-root (`webRoot`). Skips the (expensive)
 * build when already current *and* already published, so the interval poll is cheap. The publish is a
 * staged copy on the web-root's own filesystem followed by a `rename` swap — so a request is never served
 * a half-written or emptied bundle (which serving a live Vite `emptyOutDir` build dir would risk). A
 * failed build leaves the previously-published bundle in place (the daemon keeps serving the last good
 * one). Runs on load and every interval; it exits (no long-lived process, no server, no daemon restart).
 */
export function buildLiveBuildScript(o: LiveScriptOpts): string {
  // pnpm resolves from ~/Library/pnpm (corepack/standalone) or nodeDir; include both plus git + homebrew.
  const path = `${o.nodeDir}:${o.gitDir}:\${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `#!/bin/bash
${GEN_HEADER}
# musterd /live viewer — build-publisher (StartInterval). Builds the web app and publishes it into the
# daemon's web-root; the daemon serves it from its own origin. No dev server, no daemon restart.
export PATH="${path}"
set -u
WORKTREE="${o.worktree}"
WEBROOT="${o.webRoot}"
cd "$WORKTREE" || exit 0

git fetch --quiet origin main 2>/dev/null || exit 0
# Nothing to do when already on main and already published — keep the poll cheap.
if [ "$(git rev-parse HEAD 2>/dev/null)" = "$(git rev-parse origin/main 2>/dev/null)" ] && [ -f "$WEBROOT/index.html" ]; then
  exit 0
fi
git checkout --quiet --detach origin/main || true
echo "$(date '+%F %T') building $(git rev-parse --short HEAD)"

pnpm install --prefer-offline --silent 2>&1 || true
if pnpm --filter @musterd/web build 2>&1; then
  SRC="$WORKTREE/packages/web/dist/client"
  mkdir -p "$(dirname "$WEBROOT")"
  STAGE="$(dirname "$WEBROOT")/.web.next"
  rm -rf "$STAGE"
  cp -R "$SRC" "$STAGE"                       # stage on the web-root's own filesystem
  rm -rf "$WEBROOT.prev"
  [ -e "$WEBROOT" ] && mv "$WEBROOT" "$WEBROOT.prev"
  mv "$STAGE" "$WEBROOT"                       # atomic swap into place
  rm -rf "$WEBROOT.prev"
  echo "$(date '+%F %T') published $(git rev-parse --short HEAD) → $WEBROOT"
else
  echo "$(date '+%F %T') web build failed; keeping the previously published bundle"
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
}

/**
 * Parse `launchctl print` output into a coarse status. When `print` failed (the agent isn't loaded),
 * pass `loaded: false` via `ok=false` and this returns the not-loaded shape without scanning.
 */
export function parseLaunchctlPrint(stdout: string, ok: boolean): LaunchctlStatus {
  if (!ok) return { loaded: false, pid: null, state: null };
  const pidMatch = stdout.match(/\bpid = (\d+)/);
  // Capture the whole state value ("running", "waiting", "not running") — not just the first token,
  // which truncated an interval agent's "not running" to a misleading "not".
  const stateMatch = stdout.match(/\bstate = ([^\n]+)/);
  return {
    loaded: true,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1]!.trim() : null,
  };
}
