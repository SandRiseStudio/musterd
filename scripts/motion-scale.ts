/*
 * The motion-scale checks behind `pnpm tokens:check` (spec 2026-08-25-motion-scale-design.md §4).
 *
 * Its own module for the same reason as `adr-sections.ts`: `check-css-tokens.ts` is a script that
 * reads files and calls process.exit, so logic living inside it cannot be tested. These are pure
 * text→findings functions; the script wires them to the filesystem and the exit code.
 *
 * Four rules:
 *   1. DISAGREE  — a motion token in CSS whose value differs from `motion.ts`.
 *   2. RAW       — a cubic-bezier() or bare ms literal in a transition/animation outside :root.
 *   3. OFF-FRAME — a duration that is not a whole frame at the 720p25 capture rate.
 *   4. REDUCED   — a rung used in a transition with no prefers-reduced-motion answer in the file.
 *
 * EXEMPT BY RULE, not by list: an `infinite` animation is ambient life (clock sheen, breathing,
 * drift), not interaction feedback, and is not on the same scale as a hover transition. A rule the
 * gate can check beats a list someone has to remember to update.
 *
 * A NOTE ON THE NAMESPACE. Rules 1, 3 and 4 govern the `--lc-dur-*` / `--lc-ease*` names. A duration
 * hidden under some other name (the pre-scale `--lc-fast: 140ms` was exactly this) is invisible to
 * them. That is deliberate rather than a hole worth closing with a value-sniffing heuristic: rule 2
 * catches the *uses* regardless of what the token is called, so a stylesheet cannot smuggle motion
 * past the gate — only mis-file where its value is declared.
 *
 * A NOTE ON MULTI-LINE DECLARATIONS. `Live.css` writes most of its transitions across several lines
 * (see the four-property block at Live.css:1782). A per-line scan would silently miss every
 * continuation line — a gate that under-reports is worse than no gate — so declarations are
 * assembled from their opening `transition:`/`animation:` to the terminating `;` before anything is
 * judged, and each literal is still reported against the line it physically sits on.
 */

/** One frame at 720p25. Mirrors `FRAME_MS` in office-scene/motion.ts. */
export const FRAME_MS = 40;

export type MotionFinding = {
  kind: 'disagree' | 'raw' | 'off-frame' | 'reduced';
  line: number;
  detail: string;
};
export type MotionToken = { token: string; value: string; line: number };

/** `--lc-dur-*` and `--lc-ease*` are the motion namespace. Deliberately not `--lc-r-*`/`--lc-z-*`. */
const MOTION_TOKEN = /(--lc-(?:dur-[\w-]+|ease[\w-]*))\s*:\s*([^;]+)/;
const LITERAL = /cubic-bezier\([^)]*\)|\b\d+ms\b/g;

/** Custom properties whose name marks them as motion. Line numbers are 1-indexed. */
export function declaredMotionTokens(css: string): MotionToken[] {
  const out: MotionToken[] = [];
  css.split('\n').forEach((text, i) => {
    // A `:root { --a: 1; --b: 2; }` one-liner holds several declarations on one line.
    for (const part of text.split(';')) {
      const m = MOTION_TOKEN.exec(part);
      if (m?.[1] && m[2]) out.push({ token: m[1], value: m[2].trim(), line: i + 1 });
    }
  });
  return out;
}

type MotionDecl = { text: string; lines: { text: string; line: number }[] };

/**
 * Every `transition:` / `animation:` declaration, assembled across the lines it spans.
 * `transition-duration:` and friends deliberately do not open one — the regex requires the colon to
 * follow the property name directly.
 */
function motionDeclarations(css: string): MotionDecl[] {
  const out: MotionDecl[] = [];
  let cur: MotionDecl | null = null;
  css.split('\n').forEach((text, i) => {
    if (!cur && /(?:^|[;{\s])(?:transition|animation)\s*:/.test(text)) {
      cur = { text: '', lines: [] };
    }
    if (cur) {
      cur.text += ` ${text}`;
      cur.lines.push({ text, line: i + 1 });
      if (text.includes(';')) {
        out.push(cur);
        cur = null;
      }
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** Rule 2 — inline bezier / bare ms inside a transition. `infinite` declarations are exempt (§5). */
export function rawMotionLiterals(css: string): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const decl of motionDeclarations(css)) {
    if (/\binfinite\b/.test(decl.text)) continue; // ambient loop, exempt by rule
    for (const { text, line } of decl.lines) {
      for (const m of text.matchAll(LITERAL)) out.push({ kind: 'raw', line, detail: m[0] });
    }
  }
  return out;
}

/** Rule 3 — a declared duration that is not a whole frame at 25fps. */
export function offFrameDurations(css: string): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const { token, value, line } of declaredMotionTokens(css)) {
    const ms = /^(\d+)ms$/.exec(value);
    if (!ms?.[1]) continue;
    const n = Number(ms[1]);
    if (n % FRAME_MS !== 0) {
      const frames = (n / FRAME_MS).toFixed(1).replace(/\.0$/, '');
      out.push({
        kind: 'off-frame',
        line,
        detail: `${token}: ${String(n)}ms is ${frames} frames at 25fps`,
      });
    }
  }
  return out;
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '');

/** Rule 1 — CSS mirror vs the TS source. `expected` is derived from office-scene/motion.ts. */
export function disagreeingTokens(
  css: string,
  expected: ReadonlyMap<string, string>,
): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const { token, value, line } of declaredMotionTokens(css)) {
    const want = expected.get(token);
    if (want !== undefined && norm(want) !== norm(value)) {
      out.push({
        kind: 'disagree',
        line,
        detail: `${token}: CSS has ${value}, motion.ts has ${want}`,
      });
    }
  }
  return out;
}

/**
 * Rule 4 — every rung used in a transition needs a reduced-motion answer somewhere in the file.
 *
 * Deliberately coarse: it asks whether the stylesheet neutralises motion under
 * `prefers-reduced-motion` at all, not whether every selector is individually covered. A
 * per-selector rule would need a CSS cascade model; this catches the case that actually happens — a
 * new rung landing in a stylesheet with no reduced-motion story whatsoever.
 */
export function rungsWithoutReducedAnswer(css: string): string[] {
  const used = new Set<string>();
  for (const decl of motionDeclarations(css)) {
    if (/\binfinite\b/.test(decl.text)) continue;
    for (const m of decl.text.matchAll(/var\((--lc-dur-[\w-]+)\)/g)) if (m[1]) used.add(m[1]);
  }
  if (used.size === 0) return [];
  const answered =
    css.includes('@media (prefers-reduced-motion') &&
    /transition-duration:\s*0s|animation:\s*none|transition:\s*none/.test(css);
  return answered ? [] : [...used].sort();
}
