/**
 * Harness glyphs for the nameplate's harness segment. The keys mirror SURFACE_SHORT in
 * ./presenceLabel.ts — a harness added there that wants a mark gets an entry here too.
 *
 * Only the harnesses whose seats are otherwise indistinguishable get one: a cursor seat runs a
 * claude model, so the provider pin says Claude and nothing on the plate says cursor. claude-code
 * stays bare text — its provider pin already is its identity.
 *
 * Shapes are hand-drawn geometry, not brand marks: at the 8px they render at, a licensed logo's
 * detail is gone anyway, and a simple silhouette (pointer / prompt / block cursor) reads better.
 * Everything tints via currentColor so the per-harness ink token on the seg (Live.css,
 * --lc-hz-*-ink) drives the colour — unlike the provider pins, no colour is baked in here.
 *
 * This module is imported only from the lazy office-scene chunk; do not import it from anything
 * on the eager /live graph.
 */

const SVG_OPEN =
  '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">';

/** cursor — a pointer arrowhead. */
const CURSOR_SVG = `${SVG_OPEN}<path fill="currentColor" d="M5 2.5l14.5 10.1-7.4 1.2 4.1 7.2-3 1.6-4-7.3-4.2 4.6z"/></svg>`;

/** codex — a shell prompt: chevron and underscore. */
const CODEX_SVG = `${SVG_OPEN}<path fill="currentColor" d="M4.5 5.6L12.9 12l-8.4 6.4 1.9 2.4L17.5 12 6.4 3.2zM13.5 19.4h8v2.6h-8z"/></svg>`;

/** opencode — a terminal block cursor mid-line. */
const OPENCODE_SVG = `${SVG_OPEN}<path fill="currentColor" d="M3 16.8h5.2v3.4H3zM9.8 13.4h8.4v6.8H9.8zM3 3.8h15.2v3.4H3zM3 8.6h10.4V12H3z"/></svg>`;

export type SurfaceGlyphId = 'codex' | 'cursor' | 'opencode';

export interface SurfaceGlyph {
  id: SurfaceGlyphId;
  svg: string;
}

const GLYPHS: Record<SurfaceGlyphId, string> = {
  codex: CODEX_SVG,
  cursor: CURSOR_SVG,
  opencode: OPENCODE_SVG,
};

export function surfaceGlyph(surface: string | null | undefined): SurfaceGlyph | null {
  if (!surface) return null;
  if (surface === 'codex' || surface === 'cursor' || surface === 'opencode') {
    return { id: surface, svg: GLYPHS[surface] };
  }
  return null;
}
