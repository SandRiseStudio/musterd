/*
 * The ADR front-matter status parser, shared by the doc gates.
 *
 * Its own module because `check-change-adr.ts` is a script: it reads git and calls `process.exit`
 * at the top level, so a test that imported it would run the gate instead of testing it.
 */

/**
 * The status token of an ADR's front-matter line, lowercased — `accepted`, `proposed`, `draft`,
 * `superseded` — or null when there is no status line at all.
 *
 * PARSED PERMISSIVELY ON PURPOSE, because the corpus is not uniform and the previous matcher
 * (`/^-\s*Status:\s*accepted\s*$/im`, inline in `check-change-adr.ts`) required the line to be the
 * bare word and nothing else. That end-anchor silently disabled the Decision-immutability rule for
 * **94 of the 223 accepted ADRs** — and for the wrong ones. Three independent ways to miss, all
 * present in `docs/decisions` on 2026-08-05:
 *
 *   - an ANNOTATED status (86 files) — the house style records shipping detail inline:
 *     `- Status: accepted — implemented 2026-06-25`, `- Status: accepted — 2026-07-28. Authored by …`
 *   - a BOLD KEY (3: ADRs 224, 227, 228) — `- **Status:** accepted`
 *   - NO LEADING DASH (5: ADRs 077, 206, 231, 233, 235) — `Status: **Accepted**`
 *
 * The selection was systematically backwards: ADRs reading "accepted — design frozen; increments N
 * are the build arc" (131, 144, 145) were all unprotected, and those are exactly the long-arc ADRs
 * people come back to and amend. The gate protected the ADRs nobody edits and skipped the ones
 * everybody edits — which is how PR #733 rewrote ADR 131's frozen `## Decision` with CI green, and
 * the violation was caught hours later by a human reviewer reading from memory.
 *
 * Annotation is GOOD PRACTICE and stays: the fix is to parse the token, never to demand that
 * everyone rewrite 94 status lines into a shape the regex happens to like.
 */
export function adrStatus(text: string): string | null {
  for (const line of text.split('\n')) {
    // optional list marker, optional bold around the key, `Status`, optional bold, `:` — then the
    // first bare word of the value, itself optionally bolded.
    const m = /^\s*[-*]?\s*\**\s*Status\s*\**\s*:\s*\**\s*([A-Za-z]+)/i.exec(line);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}

/**
 * Is this ADR's `## Decision` frozen? `accepted` only — deliberately NOT widened to `superseded`
 * while fixing the detector, though the argument that a superseded decision is *more* historical
 * rather than less is a real one. That is a change to the RULE and belongs in its own decision, not
 * smuggled in with a parser fix.
 *
 * ADR 010's `accepted; superseded by ADR 017` reads as `accepted` and stays frozen, which is right:
 * it was accepted, and the later supersession is recorded rather than retracted.
 */
export function isAcceptedAdr(text: string): boolean {
  return adrStatus(text) === 'accepted';
}
