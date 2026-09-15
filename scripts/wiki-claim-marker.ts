/*
 * The wiki's claim label, as it lives on the claim line.
 *
 * A rule-2 claim line ends with `<!-- claim: defect -->` or `<!-- claim: other -->` — invisible in
 * rendered markdown, and read by the coverage meter (wiki-coverage.ts). It sits here, in a module
 * of its own, because THREE consumers must agree on it and two of them are not the meter: anything
 * that compares wiki prose to wiki prose has to strip the marker first, or a marker reads as an
 * edit to the sentence. That is not hypothetical — adding the markers turned every marked heading
 * into a false "eaten section" and every marked summary line into an INDEX.md diff, because both
 * checks compare heading/body TEXT across two versions of a page (lane 01M2H121AA, 2026-09-15).
 *
 * The label used to live in scripts/wiki-claim-labels.json, keyed by the whole prose line; that
 * file was the busiest merge conflict in the repo. See the header of wiki-coverage.ts.
 */

export type ClaimLabel = 'defect' | 'other';

/** Anchored to end of line: a marker is a property of the whole claim, and allowing it mid-line
 *  would make "which text is the claim" ambiguous. */
export const MARKER_RE = /\s*<!--\s*claim:\s*([^>]*?)\s*-->\s*$/;

/** The line as its author wrote it, marker removed. Trailing whitespace goes with the marker. */
export function stripMarker(line: string): string {
  return line.replace(MARKER_RE, '');
}

/** The raw label text of a line's marker, or null when it carries none. Raw, not validated: an
 *  unreadable label must be reportable as itself. */
export function markerLabel(line: string): string | null {
  return MARKER_RE.exec(line.trimEnd())?.[1] ?? null;
}

export function renderMarker(label: ClaimLabel): string {
  return `<!-- claim: ${label} -->`;
}
