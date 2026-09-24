import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseContentStamp } from './guidance.js';

/**
 * Every relative path musterd guidance can occupy in a workspace — the canonical skill plus each
 * harness's native placement (ADR 085/171).
 *
 * It lives HERE, in protocol, rather than in the CLI's harness definitions, because two packages
 * need to answer the same question and must answer it identically: the CLI claims a seat and so
 * does the MCP adapter, `@musterd/mcp` cannot import `@musterd/cli` (the dependency runs the other
 * way), and a census that reports a different epoch depending on which route a seat claimed by
 * would be worse than no census. `build-stamp.ts` is the precedent — protocol already reads a stamp
 * off disk for exactly this kind of shared attestation.
 *
 * The CLI's harness definitions remain the source of truth for what gets WRITTEN; a test there
 * (`guidance.test.ts`) asserts this list covers everything `guidanceTargets(HARNESSES)` produces, so
 * the two cannot drift silently.
 */
export const GUIDANCE_INSTALL_PATHS: readonly string[] = [
  // Canonical — written for every harness, including those with no native mechanism.
  '.musterd/skill/SKILL.md',
  '.musterd/skill/orient.md',
  // Claude Code
  '.claude/skills/musterd/SKILL.md',
  '.claude/skills/musterd-orient/SKILL.md',
  '.claude/commands/musterd-standup.md',
  '.claude/commands/musterd-handoff.md',
  '.claude/commands/musterd-claim.md',
  // Cursor
  '.cursor/rules/musterd.mdc',
  '.cursor/rules/musterd-label-session.mdc',
  '.cursor/rules/musterd-orient.mdc',
  '.cursor/commands/musterd-standup.md',
  '.cursor/commands/musterd-handoff.md',
  '.cursor/commands/musterd-claim.md',
  // Grok
  '.grok/skills/musterd/SKILL.md',
  '.grok/skills/musterd-orient/SKILL.md',
  '.grok/commands/musterd-standup.md',
  '.grok/commands/musterd-handoff.md',
  '.grok/commands/musterd-claim.md',
];

/**
 * The guidance epoch a WORKSPACE is running (ADR 417) — parsed from the `<!-- musterd:content vN -->`
 * stamps in the files installed there, never from `GUIDANCE_CONTENT_VERSION`.
 *
 * The constant is a build's CEILING: what it would write. The stamps are what is actually in the
 * model's context. Attesting the constant would repeat the self-referential defect the doctor's own
 * comment names — a binary that writes v21 pronouncing v21 current — one layer up, on the wire.
 *
 * Three rulings, all deliberate:
 * - **Disagreement takes the minimum.** A workspace whose files carry different stamps ran the
 *   weakest rule in the set, and the weakest rule is the one a census exists to find.
 * - **An unstamped file is skipped, not zeroed.** No stamp is an absence of evidence, not evidence
 *   of epoch 0 — zeroing would drag the minimum to 0 and report every hand-edited workspace as
 *   maximally stale.
 * - **Nothing readable ⇒ `undefined`,** so the field is omitted rather than guessed (ADR 135).
 *
 * Never memoised: `musterd init --refresh-guidance` and ADR 408 self-heal both rewrite these files
 * mid-session, and a session that outlives the rule it started under is the defect this attestation
 * exists to make visible.
 */
export function installedGuidanceEpoch(dir: string): number | undefined {
  let lowest: number | undefined;
  for (const rel of GUIDANCE_INSTALL_PATHS) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue; // absent: no evidence, not a zero
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable: likewise no evidence
    }
    const stamp = parseContentStamp(text);
    if (stamp === null) continue; // unstamped or hand-written
    lowest = lowest === undefined ? stamp.version : Math.min(lowest, stamp.version);
  }
  return lowest;
}
