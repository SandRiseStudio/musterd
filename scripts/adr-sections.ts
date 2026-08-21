/*
 * ADR section extraction, shared by the doc gates.
 *
 * Its own module for the same reason `adr-status.ts` is: `check-change-adr.ts` is a script that
 * reads git and calls `process.exit` at the top level, so a consumer that imported it would run the
 * gate instead of using it.
 *
 * Two gates now depend on this boundary and must not drift apart on it. `check-change-adr` freezes
 * what this returns (an accepted ADR's Decision is immutable); `check-watches` scans it for
 * frequency claims. `## Context` is deliberately outside both — history is quoted there, not
 * asserted.
 */

/** The body of the `## Decision` section, or null when the ADR has no such heading. */
export function decisionSection(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Decision\s*$/i.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
