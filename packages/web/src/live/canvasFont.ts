// Canvas text that follows the type tokens (styles/tokens.css) — so the tokens' "one swap point"
// re-fonts the canvas surfaces (office scene, character sheet) too, not just the DOM.
//
// Two facts about canvas make this indirect:
//   1. `ctx.font` can't read CSS custom properties, so we resolve a token's font stack from the DOM
//      once (`getComputedStyle`) and reuse it.
//   2. Canvas paints the *fallback* synchronously and never itself triggers a web-font download. So
//      we reuse a weight the DOM already loads (the chyron 700), which costs no extra fetch, and
//      `preloadCanvasFont` kicks the CSS Font Loading API so the real face is ready on the next
//      frame instead of flashing the fallback.

const FALLBACK: Record<string, string> = {
  '--font-display': '"Space Grotesk", system-ui, sans-serif',
  '--font-mono': '"Space Mono", ui-monospace, monospace',
  '--font-sans': '"Fraunces", Georgia, serif',
};

const cache = new Map<string, string>();

/** The token's resolved font stack (e.g. `'Space Grotesk', 'Inter', …`), cached; a literal fallback
 *  before the DOM exists (SSR/prerender) so a server render still produces a valid `ctx.font`. */
function stack(token: string): string {
  const hit = cache.get(token);
  if (hit !== undefined) return hit;
  let value = FALLBACK[token] ?? 'system-ui, sans-serif';
  if (typeof document !== 'undefined') {
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (resolved) value = resolved;
  }
  cache.set(token, value);
  return value;
}

/**
 * A `ctx.font` shorthand at `px`, from a type token. Defaults to `--font-display` at weight 700 —
 * the izzocam chyron face (Space Grotesk), already loaded for the DOM headings, so canvas labels
 * match the UI with no extra download.
 */
export function canvasFont(px: number, token = '--font-display', weight = 700): string {
  return `${weight} ${px}px ${stack(token)}`;
}

/** Warm the CSS Font Loading API for a canvas face so it's ready on the next frame rather than
 *  painting the fallback until some DOM element happens to pull it. No-op without `document.fonts`. */
export function preloadCanvasFont(px = 16, token = '--font-display', weight = 700): void {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    void document.fonts.load(`${weight} ${px}px ${stack(token)}`).catch(() => {});
  } catch {
    /* malformed shorthand only — the resolved stack is well-formed, so this never fires in practice */
  }
}

/** Test seam: drop the resolved-stack cache so a re-styled document is re-read. */
export function _resetCanvasFontCache(): void {
  cache.clear();
}
