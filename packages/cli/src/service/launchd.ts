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
 * The `/live` web-viewer agents (ADR 124). The viewer is a *bundle* of two agents in the same user
 * domain: `LIVE_LABEL` is the KeepAlive dev server (checks out `origin/main`, builds, serves `:5173`),
 * and `LIVE_SYNC_LABEL` polls `origin/main` on an interval and restarts the server when it moves — so
 * the viewer tracks main with no manual step. Distinct from the daemon (`SERVICE_LABEL`) so `--live`
 * can target them without touching the daemon.
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

/* ─── /live viewer (ADR 124): generated scripts + their two plists ──────────────────────────────────
 * The viewer's logic lives in two shell scripts (a server that syncs+builds+serves, a tracker that
 * restarts it when main moves) rather than inline in a plist, because they do multi-step git/pnpm work.
 * Both scripts and both plists are generated from these builders — versioned here, written to disk by
 * `installLive`, so the setup is reproducible and testable instead of hand-authored per machine. */

export interface LiveScriptOpts {
  /** The dedicated detached-on-`origin/main` viewer worktree. */
  worktree: string;
  /** Dev-server port (default 5173). */
  port: number;
  /** Dir holding the `node`/`pnpm` binaries the server needs on PATH. */
  nodeDir: string;
  /** Dir holding `git` (the tracker needs it on a minimal PATH). */
  gitDir: string;
  uid: string | number;
  /** launchd label of the server agent — the tracker restarts it by this. */
  serverLabel: string;
}

const GEN_HEADER =
  '# Generated by `musterd service install --live` (ADR 124) — edits are overwritten on reinstall.';

/**
 * The server script: advance the viewer worktree to the tip of `origin/main` (best-effort — serve the
 * last-good checkout rather than nothing on a network hiccup), rebuild the one workspace dependency the
 * web app imports as built dist (`@musterd/protocol`), then hand the process to `vite dev`. Re-run on
 * every (re)start by launchd's KeepAlive and by the tracker's `kickstart`.
 */
export function buildLiveServeScript(o: LiveScriptOpts): string {
  // pnpm resolves from ~/Library/pnpm (corepack/standalone) or nodeDir; include both plus homebrew.
  const path = `${o.nodeDir}:\${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `#!/bin/bash
${GEN_HEADER}
# musterd /live viewer — launchd job main process (KeepAlive).
export PATH="${path}"
set -u
WORKTREE="${o.worktree}"
cd "$WORKTREE" || exit 1

# Get to the tip of main. Best-effort: on a fetch failure serve the current checkout, don't go dark.
if git fetch --quiet origin main; then
  git checkout --quiet --detach origin/main || true
fi
echo "$(date '+%F %T') serving $(git rev-parse --short HEAD)"

# The web app imports the built @musterd/protocol dist — install (cheap no-op when unchanged) and
# rebuild it so a protocol change on main is reflected, then hand the process to vite.
pnpm install --prefer-offline --silent 2>&1 || true
pnpm --filter @musterd/protocol build 2>&1 || true

cd "$WORKTREE/packages/web" || exit 1
exec pnpm dev --port ${o.port}
`;
}

/**
 * The main-tracker script: every interval, if `origin/main` has moved past the viewer worktree,
 * `kickstart -k` the server agent (which re-syncs, rebuilds, and reserves, reconnecting the open tab).
 * A full restart, not an in-place checkout, is deliberate — it reliably reloads the browser and covers
 * any change type (web, protocol, deps). No-op when already current, so the poll is cheap.
 */
export function buildLiveSyncScript(o: LiveScriptOpts): string {
  return `#!/bin/bash
${GEN_HEADER}
# musterd /live viewer — main-tracker (StartInterval).
export PATH="${o.gitDir}:/usr/bin:/bin"
cd "${o.worktree}" || exit 0
git fetch --quiet origin main 2>/dev/null || exit 0
[ "$(git rev-parse HEAD 2>/dev/null)" = "$(git rev-parse origin/main 2>/dev/null)" ] && exit 0
echo "$(date '+%F %T') main moved $(git rev-parse --short HEAD)→$(git rev-parse --short origin/main); restarting viewer"
/bin/launchctl kickstart -k gui/${o.uid}/${o.serverLabel}
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

/** The server agent plist — KeepAlive (relaunch on any exit; `vite dev` runs forever) + a throttle. */
export function buildLiveServePlist(o: LivePlistOpts): string {
  return renderPlist({
    label: o.label,
    programArguments: ['/bin/bash', o.scriptPath],
    workingDir: o.workingDir,
    stdoutPath: o.stdoutPath,
    stderrPath: o.stderrPath,
    keepAlive: true,
    runAtLoad: true,
    throttleInterval: 10,
  });
}

/** The tracker agent plist — runs on load and every `intervalSeconds`; NOT KeepAlive (it exits). */
export function buildLiveSyncPlist(o: LivePlistOpts & { intervalSeconds: number }): string {
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
