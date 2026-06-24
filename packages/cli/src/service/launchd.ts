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
 * The LaunchAgent property list. `RunAtLoad` + `KeepAlive` make it start at login and relaunch on
 * crash or any exit (`serve` runs forever, so any exit is restart-worthy); `ThrottleInterval` keeps a
 * crash-loop from hammering. Every dynamic value is XML-escaped — a path with `&` can't break the doc.
 */
export function buildPlist(o: PlistOpts): string {
  const programArgs = [o.node, o.binJs, ...o.serveArgs]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(o.path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(o.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(o.stderrPath)}</string>
</dict>
</plist>
`;
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
  const stateMatch = stdout.match(/\bstate = (\S+)/);
  return {
    loaded: true,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1]! : null,
  };
}
