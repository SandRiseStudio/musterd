/**
 * The CLI's shared render toolkit — small layout primitives every command composes, built only on the
 * `theme` color seam (no new deps, 16-color-safe per brand.md §2 + docs/design/figma-brief-terminal.md).
 *
 * The design north star is the web's warm isometric office (DESIGN.md): warmth comes from the mustard
 * accent, generous structure, and cozy microcopy — not from new hues. Delight is reserved for moments
 * (a `✓` settle, an incoming `⚑`), so these primitives stay quiet and let the content breathe.
 */
import { theme } from './theme.js';

/**
 * The canonical glyph vocabulary, mirrored from the web act-glyph set (Stream.tsx / office-scene) and
 * kept to characters every 16-color terminal can render. Use these instead of inlining literals so the
 * CLI speaks one visual language.
 */
export const sym = {
  ok: '✓',
  err: '✗',
  warn: '⚠',
  flag: '⚑',
  pending: '⧖',
  arrow: '→',
  handoff: '↦',
  steer: '↪',
  online: '●',
  offline: '○',
  goal: '◆',
  branch: '⎇',
  unread: '▌',
  dot: '·',
  bullet: '•',
  more: '…',
} as const;

/** Matches SGR color/style escapes so width math counts visible characters only. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** The visible width of a possibly-colorized string (ANSI escapes stripped). */
export function visibleLen(s: string): number {
  return s.replace(ANSI, '').length;
}

/** Pad a (possibly colorized) string to `width` visible columns, always leaving ≥1 trailing space. */
export function padEndVisible(s: string, width: number): string {
  const extra = Math.max(1, width - visibleLen(s));
  return s + ' '.repeat(extra);
}

/**
 * The usable line width: the real terminal columns, clamped to a comfortable range. Non-TTY / piped
 * output has no `columns` (→ 80), which also keeps tests deterministic (they run under `pool: 'forks'`,
 * so `process.stdout.columns` is undefined and this returns 80 — the width the render tests assume).
 */
export function termWidth(max = 100): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(max, cols));
}

/** Greedy word-wrap to `width` columns. Returns `['']` for empty input so callers can always join. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** A mustard section heading — uppercased so groups read like signposted rooms on the floor. */
export function heading(s: string): string {
  return theme.accent(s.toUpperCase());
}

/** A quieter, bold subheading for within a section. */
export function subhead(s: string): string {
  return theme.bold(s);
}

/** A dim horizontal rule spanning the current width (used sparingly, e.g. the help footer). */
export function rule(width = termWidth()): string {
  return theme.meta('─'.repeat(width));
}

/** Dim/muted text — the replacement for scattered `pc.dim` / `pc.gray` calls. */
export function dim(s: string): string {
  return theme.dim(s);
}

/** A muted follow-on hint line: `→ do this next`. */
export function hint(s: string): string {
  return theme.meta(`${sym.arrow} ${s}`);
}

/**
 * A success confirmation with the signature `✓`, and — the delight-in-moments touch — an optional dim
 * `next:` line so a command never dead-ends: it names the obvious next move.
 */
export function success(msg: string, opts: { next?: string } = {}): string {
  const head = `${theme.ok(sym.ok)} ${msg}`;
  return opts.next ? `${head}\n  ${theme.meta(`next: ${opts.next}`)}` : head;
}

export interface DefRow {
  term: string;
  desc: string;
}

/**
 * One aligned two-column row: `term` padded so `desc` starts at visible column `gap`, then `desc`
 * wrapped with a hanging indent to that same column. Alignment is computed on visible length, so it
 * holds whether or not color is on.
 */
export function defRow(row: DefRow, gap: number, opts: { width?: number } = {}): string {
  const width = opts.width ?? termWidth();
  const descWidth = Math.max(20, width - gap);
  const wrapped = wrapText(row.desc, descWidth);
  const first = padEndVisible(row.term, gap) + theme.meta(wrapped[0] ?? '');
  if (wrapped.length === 1) return first;
  const indent = ' '.repeat(gap);
  const rest = wrapped.slice(1).map((l) => indent + theme.meta(l));
  return [first, ...rest].join('\n');
}

/**
 * An aligned definition list: every `desc` starts at one shared column (widest term + a 2-space
 * gutter), so a group of commands lines up cleanly. `paint` colorizes the term (default: mustard
 * `musterd <name>` style).
 */
export function defList(
  rows: DefRow[],
  opts: { paint?: (term: string) => string; width?: number } = {},
): string {
  const paint = opts.paint ?? theme.accent;
  const gap = Math.max(0, ...rows.map((r) => visibleLen(r.term))) + 2;
  const rowOpts = opts.width !== undefined ? { width: opts.width } : {};
  return rows.map((r) => defRow({ term: paint(r.term), desc: r.desc }, gap, rowOpts)).join('\n');
}
