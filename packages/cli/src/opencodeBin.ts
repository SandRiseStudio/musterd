import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/** Absolute locations used by common OpenCode installs. The resident host is often launchd,
 *  whose PATH intentionally omits interactive shell setup (same problem as codexBin.ts). */
export function opencodeCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.npmglobal/bin/opencode'),
    join(home, '.npm-global/bin/opencode'),
    join(home, '.local/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];
}

let opencodeBinCache: string | null | undefined;

export type OpencodeCapability =
  | { supported: true; version: string }
  | { supported: false; reason: string };

/** Read-only CLI preflight for residency. It deliberately never invokes `opencode run`. */
export async function probeOpencodeCli(
  run: (args: string[]) => Promise<{ ok: boolean; out: string }>,
): Promise<OpencodeCapability> {
  const version = await run(['--version']);
  if (!version.ok) return { supported: false, reason: 'OpenCode CLI did not answer --version' };
  const versionMatch = /(?:opencode\s+)?v?(\d+\.\d+(?:\.\d+)?[^\s]*)/i.exec(version.out);
  const renderedVersion = versionMatch?.[1] ?? 'installed';
  const fresh = await run(['run', '--help']);
  if (!fresh.ok || !/\B--format\b/.test(fresh.out) || !/\bjson\b/.test(fresh.out))
    return { supported: false, reason: 'OpenCode CLI does not advertise run --format json' };
  const resumeOk = /\B--session\b/.test(fresh.out) || (await run(['session', 'list', '--help'])).ok;
  if (!resumeOk)
    return { supported: false, reason: 'OpenCode CLI does not advertise exact-session resume' };
  return { supported: true, version: renderedVersion };
}

/** Resolve a runnable OpenCode CLI without a shell. A miss is deliberately not cached, so
 *  installing opencode while the host is running becomes visible on the next wake poll. */
export async function resolveOpencodeBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
): Promise<string | null> {
  if (opencodeBinCache !== undefined) return opencodeBinCache;
  if ((await runnable('opencode', ['--version'])).ok) return (opencodeBinCache = 'opencode');
  for (const candidate of opencodeCandidates()) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok)
      return (opencodeBinCache = candidate);
  }
  return null;
}

/** Probe the resolved executable with only read-only help/version requests. */
export async function opencodeCapability(): Promise<OpencodeCapability> {
  const bin = await resolveOpencodeBin();
  if (!bin)
    return { supported: false, reason: 'OpenCode CLI not found (PATH + known install locations)' };
  return probeOpencodeCli((args) => hasRunnable(bin, args));
}

/** Drop the process-local resolution result after a spawn proves a prior path stale. */
export function resetOpencodeBinCache(): void {
  opencodeBinCache = undefined;
}
