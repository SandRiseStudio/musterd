/**
 * The musterd chip, as data — the mustard block, the reversed `m`, the cursor notch (ADR 154).
 *
 * It lives here rather than inside `MusterdWord.tsx` because two very different renderers need the
 * same mark and only one of them is React. The office scene builds raw DOM in a lazily-loaded chunk
 * (`office-scene/index.ts`), and importing a `.tsx` component to reach a path string would drag
 * React's component into that chunk to get at a constant — the packages/web perf contract's exact
 * objection. So the geometry is a plain module both sides import, and `MusterdWord.tsx` renders it
 * as JSX while `musterdChipSvg` renders it as markup.
 *
 * The alternative — pasting the path into the scene — is how a brand mark quietly becomes two brand
 * marks that disagree after the next tweak. One definition, two renderers.
 */

/** Rounded mustard tile. */
export const CHIP_BG = '#E1AD01';
/** The mark and the notch. */
export const CHIP_FG = '#18181B';
export const CHIP_RADIUS = 7;
/** The reversed lowercase `m`, on a 32×32 viewBox. */
export const CHIP_M_PATH =
  'M7.5 22V11.8h2.3v2.4c0-1.7 1-2.8 2.5-2.8 1.4 0 2.3.9 2.3 2.6V22h-2.3v-5.6c0-.9-.5-1.4-1.2-1.4-.8 0-1.2.5-1.2 1.4V22H7.5zm7.2 0v-6.2c0-1.9 1-3 2.6-3 1.1 0 1.9.5 2.2 1.3v-1.1h2.3V22h-2.3v-5.7c0-.9-.5-1.4-1.2-1.4-.8 0-1.2.5-1.2 1.4V22h-2.4z';
/** The cursor notch at the lower right. */
export const CHIP_NOTCH = { x: 24.5, y: 18, width: 2.5, height: 10, rx: 0.4 } as const;

/**
 * The chip as an SVG string, for renderers that build markup rather than elements.
 *
 * `aria-hidden` is baked in: every place this is used, the word "musterd" is already present as
 * text beside it, so the mark is decoration and announcing it would make a screen reader say the
 * product name twice.
 */
export function musterdChipSvg(size: number): string {
  const n = CHIP_NOTCH;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<rect width="32" height="32" rx="${CHIP_RADIUS}" fill="${CHIP_BG}"/>` +
    `<path fill="${CHIP_FG}" d="${CHIP_M_PATH}"/>` +
    `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${n.rx}" fill="${CHIP_FG}"/>` +
    `</svg>`
  );
}
