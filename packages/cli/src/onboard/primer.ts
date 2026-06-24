import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIMER_END_MARKER, PRIMER_START_PREFIX } from '@musterd/protocol';

/**
 * AGENTS.md file I/O for the agent primer (ADR 012 / docs/design/agent-primer.md). The **pure
 * renderer** lives in `@musterd/protocol` (`renderPrimer`, re-exported below) so the CLI and the MCP
 * server share one source of truth; this module adds the idempotent create/append/update + uninstall
 * against the binding folder's `AGENTS.md` (the cross-tool agent-context file harnesses read each
 * session). Without it, a fresh agent doesn't know it's on a team or how to coordinate (2026-06-12).
 */

// The shared renderer, re-exported so existing call sites keep importing it from here.
export { renderPrimer } from '@musterd/protocol';

// Stable prefixes used for matching, so a hand-edited start line still re-anchors on re-run.
const START_PREFIX = PRIMER_START_PREFIX;
const END_MARKER = PRIMER_END_MARKER;

/** True when `content` already carries a managed musterd primer block (both markers present). */
export function hasPrimerMarkers(content: string): boolean {
  return content.includes(START_PREFIX) && content.includes(END_MARKER);
}

/**
 * What writing the primer into `<dir>/AGENTS.md` will do — so the confirm prompt can be honest at
 * the decision point (the dogfood paper-cut: a "Write an AGENTS.md?" prompt next to an existing,
 * unmarked AGENTS.md reads like overwrite when it is actually an append). Maps 1:1 to
 * {@link upsertPrimer}'s action: `none`→`created`, `unmarked`→`appended`, `managed`→`updated`.
 */
export type PrimerTarget = 'none' | 'unmarked' | 'managed';

/** Classify the AGENTS.md in `dir`: absent, present-without-markers, or already-managed. */
export function classifyPrimerTarget(dir: string): PrimerTarget {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) return 'none';
  try {
    return hasPrimerMarkers(readFileSync(path, 'utf8')) ? 'managed' : 'unmarked';
  } catch {
    // Unreadable AGENTS.md: treat as absent so init still offers to write (upsert handles the rest).
    return 'none';
  }
}

/**
 * Write or update the primer block in `<dir>/AGENTS.md`, idempotently and without clobbering the
 * user's own content: create the file if absent, replace the managed block in place if markers are
 * present, otherwise append the block below existing prose.
 */
export function upsertPrimer(
  dir: string,
  block: string,
): { path: string; action: 'created' | 'appended' | 'updated' } {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) {
    writeFileSync(path, block + '\n', 'utf8');
    return { path, action: 'created' };
  }
  const content = readFileSync(path, 'utf8');
  const startIdx = content.indexOf(START_PREFIX);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx >= 0 && endIdx > startIdx) {
    const next = content.slice(0, startIdx) + block + content.slice(endIdx + END_MARKER.length);
    writeFileSync(path, next, 'utf8');
    return { path, action: 'updated' };
  }
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, content + sep + block + '\n', 'utf8');
  return { path, action: 'appended' };
}

/**
 * Remove the managed primer block from `<dir>/AGENTS.md` (ADR 027 reversibility — `musterd
 * uninstall`), keeping the user's own prose outside the markers. Tidies the seam left behind so the
 * file doesn't accumulate blank lines. Returns what happened: `removed`, `absent` (no markers), or
 * `missing` (no AGENTS.md). Never throws on a missing file.
 */
export function removePrimer(dir: string): {
  path: string;
  action: 'removed' | 'absent' | 'missing';
} {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) return { path, action: 'missing' };
  const content = readFileSync(path, 'utf8');
  const startIdx = content.indexOf(START_PREFIX);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx < 0 || endIdx <= startIdx) return { path, action: 'absent' };
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
  const joined = [before, after].filter((s) => s.length > 0).join('\n\n');
  writeFileSync(path, joined.length > 0 ? joined + '\n' : '', 'utf8');
  return { path, action: 'removed' };
}
