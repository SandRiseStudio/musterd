import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/** Absolute locations used by common Grok CLI installs. The resident host is often launchd,
 *  whose PATH intentionally omits interactive shell setup (same problem as opencodeBin.ts). */
export function grokCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.grok', 'bin', 'grok'),
    join(home, '.local', 'bin', 'grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
  ];
}

let grokBinCache: string | null | undefined;

export type GrokCapability =
  | { supported: true; version: string }
  | { supported: false; reason: string };

/** Read-only CLI preflight for residency. It deliberately never invokes `grok -p`. */
export async function probeGrokCli(
  run: (args: string[]) => Promise<{ ok: boolean; out: string }>,
): Promise<GrokCapability> {
  const version = await run(['--version']);
  if (!version.ok) return { supported: false, reason: 'Grok CLI did not answer --version' };
  const versionMatch = /(?:grok\s+)?v?(\d+\.\d+(?:\.\d+)?[^\s]*)/i.exec(version.out);
  const renderedVersion = versionMatch?.[1] ?? 'installed';
  const help = await run(['--help']);
  if (!help.ok) return { supported: false, reason: 'Grok CLI did not answer --help' };
  const fresh = /\B-p\b/.test(help.out) || /\B--single\b/.test(help.out);
  if (!fresh) return { supported: false, reason: 'Grok CLI does not advertise -p / --single' };
  const resume = /\B-r\b/.test(help.out) || /\B--resume\b/.test(help.out);
  if (!resume) return { supported: false, reason: 'Grok CLI does not advertise -r / --resume' };
  return { supported: true, version: renderedVersion };
}

/** Resolve a runnable Grok CLI without a shell. A miss is deliberately not cached. */
export async function resolveGrokBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
): Promise<string | null> {
  if (grokBinCache !== undefined) return grokBinCache;
  if ((await runnable('grok', ['--version'])).ok) return (grokBinCache = 'grok');
  for (const candidate of grokCandidates()) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok)
      return (grokBinCache = candidate);
  }
  return null;
}

export async function grokCapability(): Promise<GrokCapability> {
  const bin = await resolveGrokBin();
  if (!bin)
    return { supported: false, reason: 'Grok CLI not found (PATH + known install locations)' };
  return probeGrokCli((args) => hasRunnable(bin, args));
}

export function resetGrokBinCache(): void {
  grokBinCache = undefined;
}
