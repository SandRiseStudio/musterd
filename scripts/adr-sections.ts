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

/**
 * A dated amendment marker, as a SPAN rather than a line: `_(Amended 2026-08-27: … )_`, or ADR 160's
 * blockquote form `> **Amended 2026-08-27.** …` running while the lines stay quoted. The date is not
 * decoration — it is what makes the marker a record rather than a note, and an undated one does not
 * match, so it is refused like any other new prose.
 *
 * A span, not a line, because the useful place for a marker is mid-sentence: ADR 326's Decision 2
 * needed one after "…then `musterd session orient-stamp`." and before "The stamp is workspace-local",
 * which is inside a line, not between two.
 */
const MARKER_SPANS: RegExp[] = [
  /_\(Amended\s+\d{4}-\d{2}-\d{2}[:.][\s\S]*?\)_/g,
  /^[ \t]*>[ \t]*\*\*Amended\s+\d{4}-\d{2}-\d{2}\.?\*\*(?:.*(?:\n[ \t]*>.*)*)/gm,
];

/** Words, not layout: markdown re-wraps freely and a line break is not a decision. */
function words(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Split a Decision into fenced and unfenced runs, in order.
 *
 * Why the comparison is not uniform (dolly's residual on #1117, 2026-08-31): outside a fence,
 * markdown re-wraps freely and a line break carries no meaning, which is what lets a mid-sentence
 * marker in at all. INSIDE a fence, whitespace is the content — indentation is the code — so a
 * word-level comparison would wave through an indent change riding a marker. Measured before taking
 * this: 22 of 329 ADR Decisions carry a fenced block, so it is a live surface, not a hypothetical.
 *
 * Markers are recognized only outside fences, for the same reason: a fence may legitimately contain
 * an EXAMPLE of a marker, and stripping that would delete code from the comparison.
 */
function segments(text: string): { fenced: boolean; text: string }[] {
  const out: { fenced: boolean; text: string }[] = [];
  let fenced = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) out.push({ fenced, text: buf.join('\n') });
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (/^[ \t]*```/.test(line)) {
      buf.push(line);
      if (fenced) {
        flush(); // the closing delimiter belongs to the fenced run
        fenced = false;
      } else {
        const opener = buf.pop()!;
        flush(); // everything before the opener was unfenced
        fenced = true;
        buf.push(opener);
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * Is `after` the same Decision as `before` with nothing added but dated amendment markers?
 *
 * The problem this solves (2026-08-31, dolly's REQUIRED 1 on #1087): an accepted ADR whose Decision
 * has been amended still reads as current to anyone who opens it and stops there. The repo's answer
 * has always been an inline dated marker — ADR 160:48, ADR 160:90, ADR 250:67 — and `check-change-adr`
 * could not express it, because it freezes the whole section and its one escape (`wasEverOnMain`) is
 * a restoration check that by construction cannot pass text that never existed. So the convention and
 * the gate contradicted each other, and the gate won: the correct fix was unwritable.
 *
 * The allowance is the narrowest thing that closes it. **Strip the marker spans from the new
 * Decision; the remaining words must be identical to the old one's.** Append-only by construction
 * rather than by promise:
 *
 *   - a reworded sentence changes the remainder → refused;
 *   - a deleted clause changes the remainder → refused;
 *   - ordinary new prose is not marker-shaped, so it stays in the remainder → refused;
 *   - an undated marker is not marker-shaped either → refused.
 *
 * This is NOT the escape hatch the gate's docstring rejects. That one ("an env override / opt-out
 * flag") says *trust me* about arbitrary text; this asserts a checkable property of the diff, and can
 * only ever admit a pointer to an amendment recorded elsewhere. The decision itself stays frozen —
 * that is what the identical remainder means.
 *
 * KNOWN AND DELIBERATE: comparing words means a re-wrap of the Decision rides along with a marker
 * unnoticed. That is the price of allowing a mid-sentence marker at all, since inserting one
 * necessarily re-wraps the paragraph around it. A re-wrap on its own still fails — a marker must
 * have been added — and no word may change either way.
 *
 * Returns false when nothing was added: an unchanged Decision is not an amendment, and the caller's
 * equality check has already passed it.
 */
export function isAppendOnlyAmendment(before: string, after: string): boolean {
  if (before === after) return false;
  const was = segments(before);
  const now = segments(after);
  if (was.length !== now.length) return false; // a fence opened or closed — not a marker's doing
  let addedMarker = false;
  for (let i = 0; i < now.length; i++) {
    const a = was[i]!;
    const b = now[i]!;
    if (a.fenced !== b.fenced) return false;
    if (a.fenced) {
      // Line-exact inside a fence: indentation is the code.
      if (a.text !== b.text) return false;
      continue;
    }
    let stripped = b.text;
    for (const span of MARKER_SPANS) {
      if (span.test(stripped)) addedMarker = true;
      span.lastIndex = 0;
      stripped = stripped.replace(span, ' ');
    }
    if (words(stripped) !== words(a.text)) return false;
  }
  return addedMarker;
}
