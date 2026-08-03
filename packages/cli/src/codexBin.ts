import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/** Absolute locations used by common Codex CLI installers. The resident host is often launchd,
 * whose PATH intentionally omits interactive shell setup. */
export function codexCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.npmglobal/bin/codex'),
    join(home, '.npm-global/bin/codex'),
    join(home, '.local/bin/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
}

let codexBinCache: string | null | undefined;

export type CodexCapability =
  | { supported: true; version: string }
  | { supported: false; reason: string };

/** Read-only CLI preflight for residency. It deliberately never invokes `codex exec`. */
export async function probeCodexCli(
  run: (args: string[]) => Promise<{ ok: boolean; out: string }>,
): Promise<CodexCapability> {
  const version = await run(['--version']);
  if (!version.ok) return { supported: false, reason: 'Codex CLI did not answer --version' };
  const versionMatch = /(?:codex(?:-cli)?\s+)?v?(\d+\.\d+(?:\.\d+)?[^\s]*)/i.exec(version.out);
  const renderedVersion = versionMatch?.[1] ?? 'installed';
  const fresh = await run(['exec', '--help']);
  if (!fresh.ok || !/\B--json\b/.test(fresh.out))
    return { supported: false, reason: 'Codex CLI does not advertise exec --json' };
  const resume = await run(['exec', 'resume', '--help']);
  if (!resume.ok || !/\B--json\b/.test(resume.out) || !/SESSION_ID/i.test(resume.out)) {
    return { supported: false, reason: 'Codex CLI does not advertise JSONL exact-session resume' };
  }
  return { supported: true, version: renderedVersion };
}

/** Probe the resolved executable with only read-only help/version requests. */
export async function codexCapability(): Promise<CodexCapability> {
  const bin = await resolveCodexBin();
  if (!bin)
    return { supported: false, reason: 'Codex CLI not found (PATH + known install locations)' };
  return probeCodexCli((args) => hasRunnable(bin, args));
}

/** Drop the process-local resolution result after a spawn proves a prior path stale. */
export function resetCodexBinCache(): void {
  codexBinCache = undefined;
}

/** Resolve a runnable Codex CLI without a shell. A miss is deliberately not cached, so installing
 * Codex while the host is running becomes visible on the next wake poll. */
export async function resolveCodexBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
): Promise<string | null> {
  if (codexBinCache !== undefined) return codexBinCache;
  if ((await runnable('codex', ['--version'])).ok) return (codexBinCache = 'codex');
  for (const candidate of codexCandidates()) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok)
      return (codexBinCache = candidate);
  }
  return null;
}
