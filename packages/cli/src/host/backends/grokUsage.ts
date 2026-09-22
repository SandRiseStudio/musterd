import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type WakeUsage } from '@musterd/protocol';
import { z } from 'zod';

/**
 * The cost reader for Grok CLI wakes (ADR 436 clause 2: a reader per harness over the artifact
 * that harness actually writes). Grok writes `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<id>/
 * usage.json` at turn end with per-session token totals, a model-call count and `costUsdTicks`
 * (2026-09-21, grok CLI with grok-4.7-build). The token totals map onto `WakeUsage` field by field
 * and ride the wake-cost row; `costUsdTicks` is a price whose unit the host cannot verify, so it is
 * NOT converted into `harness_cost_usd` — the row says `harness_price_unverified` (ADR 364) and
 * carries the tokens. Pure over a string; the reader over the filesystem never throws.
 */
const GrokUsageFile = z
  .object({
    session: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedReadTokens: z.number().int().nonnegative().optional(),
        cacheCreationTokens: z.number().int().nonnegative().optional(),
        reasoningTokens: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function parseGrokUsage(text: string): WakeUsage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = GrokUsageFile.safeParse(raw);
  if (!parsed.success) return undefined;
  const s = parsed.data.session;
  return {
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    ...(s.cachedReadTokens !== undefined ? { cached_input_tokens: s.cachedReadTokens } : {}),
    ...(s.cacheCreationTokens !== undefined
      ? { cache_write_input_tokens: s.cacheCreationTokens }
      : {}),
    ...(s.reasoningTokens !== undefined ? { reasoning_output_tokens: s.reasoningTokens } : {}),
  };
}

/** Grok groups sessions by the URL-encoded absolute cwd (matches `enumerateGrokSessions`). */
export function grokSessionsDirFor(home: string, workspace: string): string {
  return join(home, 'sessions', encodeURIComponent(resolve(workspace)));
}

/**
 * The usage of the wake that started at `startedAt` in `workspace`: the newest `usage.json` under
 * the workspace's session group whose mtime is at-or-after the spawn. Undefined when there is none
 * or the directory cannot be read — "cannot tell", never zeros.
 */
export function readGrokWakeUsage(
  workspace: string,
  startedAt: number,
  home = process.env['GROK_HOME'] ?? join(homedir(), '.grok'),
): WakeUsage | undefined {
  const dir = grokSessionsDirFor(home, workspace);
  let best: { mtime: number; path: string } | undefined;
  try {
    for (const id of readdirSync(dir)) {
      const path = join(dir, id, 'usage.json');
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime < startedAt) continue;
        if (!best || mtime > best.mtime) best = { mtime, path };
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  if (!best) return undefined;
  try {
    return parseGrokUsage(readFileSync(best.path, 'utf8'));
  } catch {
    return undefined;
  }
}
