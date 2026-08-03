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
