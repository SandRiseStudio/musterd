/*
 * CSS colour-token check — break the build when a stylesheet's palette lies about itself.
 *
 * Two lies, both found live in packages/web on 2026-08-05 (lane 01KZA27Q7C), both silent:
 *
 *   1. PHANTOM  — `var(--lc-warn, #f4cf52)` where `--lc-warn` is defined NOWHERE. The fallback is
 *      quietly doing the work of the token. Harmless while every use agrees, and a landmine twice
 *      over: the day someone *defines* it, every use silently changes; and the day someone reaches
 *      for it in a new rule, they inherit a value nothing vouches for. That is not hypothetical —
 *      it is how a fill amber nearly shipped as body text at ~2.4:1 on the broadcast card.
 *
 *   2. DISAGREEING — `var(--lc-danger, #ef4444)` where `--lc-danger` is defined as `#d1503f`. The
 *      fallback is DEAD (the token resolves, so it never applies) but it tells the next reader the
 *      wrong colour, and a wrong colour read in one rule gets copied into the next.
 *
 * TWO EXEMPTIONS, and both are load-bearing. A custom property set at RUNTIME from inline style or
 * JS is *supposed* to be undefined in the stylesheet and *supposed* to carry a fallback for the
 * frame before it is set — that is the correct idiom, not a defect, and a check that flagged
 * "undefined tokens" wholesale would demand the office animations be broken to satisfy it.
 *
 *   1. Non-colour values (`--i`, `--lc-mote-delay`, `--lc-speech-h`): numbers, times and lengths.
 *   2. Colour values that TS/TSX actually sets at runtime. This one is not optional and the check
 *      shipped without it for one draft: `--lc-amb-tint` is a genuine colour AND genuinely
 *      parametric (`office-scene/index.ts` writes it per light environment), so "colour-valued
 *      excludes parametric for free" was simply false. The sources are scanned for
 *      `setProperty('--x', …)` and `style={{ '--x': … }}` and those tokens are never phantoms.
 *
 *   pnpm tokens:check
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUR, EASE_CSS } from '../packages/web/src/live/office-scene/motion.ts';
import {
  declaredMotionTokens,
  disagreeingTokens,
  offFrameDurations,
  phantomMotionRefs,
  rawMotionLiterals,
  rungsWithoutReducedAnswer,
  type MotionFinding,
} from './motion-scale.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ROOTS = [join(repoRoot, 'packages/web/src')];

/** A literal colour: hex, or a colour function. Deliberately NOT matching `var(...)` — a fallback
 *  that defers to another token is a chain, not a claimed value, and has nothing to disagree with. */
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|lab|color-mix)\()/i;

const isColour = (value: string) => COLOUR.test(value.trim());

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap(cssFiles);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Tokens the app writes at runtime — `el.style.setProperty('--x', v)` or `style={{ '--x': v }}`.
 * These are parametric by design and must never be reported as phantoms however colour-like their
 * fallback is. Scanned rather than allowlisted so a new one needs no edit here.
 */
const runtimeSet = new Set<string>();
for (const file of ROOTS.flatMap(sourceFiles)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)['"`]/gi)) runtimeSet.add(m[1]!);
  for (const m of src.matchAll(/['"`](--[a-z0-9-]+)['"`]\s*:/gi)) runtimeSet.add(m[1]!);
}

/** Every `--token: value;` declaration, by token name. A token may be defined more than once —
 *  scoped overrides (`.bc-reel { --lc-paper: … }`) are legitimate and common here — so we keep the
 *  SET of declared values and a fallback only has to match one of them. */
const defined = new Map<string, Set<string>>();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    const [, name, value] = m;
    if (!defined.has(name!)) defined.set(name!, new Set());
    defined.get(name!)!.add(value!.trim().toLowerCase());
  }
}

/** Whitespace inside a colour function is not a difference: `rgba(43, 31, 19, 0.72)` and
 *  `rgba(43,31,19,0.72)` are one value. Compare on a normalized form so formatting never fails a build. */
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');

/**
 * Every `var(--token, fallback)` in a line, with the fallback captured by BALANCED parens rather
 * than by a regex. Nested colour functions are the common case here (`var(--x, rgba(1, 2, 3, .7))`,
 * `var(--x, color-mix(in srgb, …))`) and a non-greedy `\)` truncates them mid-value, which reported
 * a token as disagreeing with its own definition — the check lying about the lie.
 */
function varsWithFallback(text: string): { token: string; fallback: string }[] {
  const out: { token: string; fallback: string }[] = [];
  const head = /var\(\s*(--[a-z0-9-]+)\s*,/gi;
  for (const m of text.matchAll(head)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    if (depth !== 0) continue; // fallback continues onto the next line — skip rather than guess
    out.push({ token: m[1]!, fallback: text.slice(start, i - 1).trim() });
  }
  return out;
}

/**
 * The declared values of a token, normalized — following a definition that is itself a `var()` chain
 * (`--lc-accent-bright: var(--mustard-500, #e1ad01)`) down to the literals it can reach. Without
 * this, a chained token reads as disagreeing with a fallback that resolves to exactly the same
 * colour. Returns undefined when the token is defined nowhere (a genuine phantom), and an EMPTY set
 * when it is defined but resolves to nothing literal — unjudgeable, so the caller stays quiet rather
 * than guessing.
 */
function resolveDeclared(token: string, seen = new Set<string>()): Set<string> | undefined {
  const raw = defined.get(token);
  if (!raw) return undefined;
  if (seen.has(token)) return new Set(); // cyclic definition — refuse to judge
  seen.add(token);
  const out = new Set<string>();
  for (const value of raw) {
    if (isColour(value) && !value.startsWith('var(')) {
      out.add(normalize(value));
      continue;
    }
    for (const inner of varsWithFallback(value)) {
      if (isColour(inner.fallback)) out.add(normalize(inner.fallback));
      const chained = resolveDeclared(inner.token, seen);
      if (chained) for (const v of chained) out.add(v);
    }
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  token: string;
  fallback: string;
  kind: 'phantom' | 'disagrees';
  declared?: string[];
}

const findings: Finding[] = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const { token, fallback } of varsWithFallback(text)) {
      if (!isColour(fallback)) continue; // parametric runtime var — correct idiom, never a finding
      const declared = resolveDeclared(token);
      if (!declared) {
        if (runtimeSet.has(token)) continue; // written by TS at runtime — the fallback is the idiom
        findings.push({ file, line: i + 1, token, fallback, kind: 'phantom' });
      } else if (declared.size > 0 && !declared.has(normalize(fallback))) {
        findings.push({
          file,
          line: i + 1,
          token,
          fallback,
          kind: 'disagrees',
          declared: [...declared],
        });
      }
    }
  });
}

/*
 * The motion arm (spec 2026-08-25-motion-scale-design.md §4). The colour rules above ask whether a
 * palette lies about itself; these ask whether motion has a shared vocabulary at all. They ride the
 * same command because they answer the same question — does this stylesheet agree with its own
 * declared source of truth — and because the header's non-colour exemption is exactly the hole they
 * fill.
 */
const expectedMotion = new Map<string, string>([
  ...Object.entries(DUR).map(
    ([k, ms]) => [`--lc-${k.replace('d', 'dur-')}`, `${String(ms)}ms`] as const,
  ),
  ...Object.entries(EASE_CSS).map(
    ([k, cp]) =>
      [`--lc-ease-${k === 'inOut' ? 'in-out' : k}`, `cubic-bezier(${cp.join(', ')})`] as const,
  ),
]);

/* Rule 5 needs every motion token declared ANYWHERE — the scale lives in Live.css and is used from
 * sibling stylesheets, so a per-file view would call every cross-file reference a phantom. */
const knownMotion = new Set<string>();
for (const file of files) {
  for (const { token } of declaredMotionTokens(readFileSync(file, 'utf8'))) knownMotion.add(token);
}

/*
 * The motion arm judges the /live SURFACE, not every stylesheet in the repo.
 *
 * The scale is a /live scale: ADR 313 already splits the CSS budgets by surface, and the public
 * site (components/*.css) was never migrated onto the rungs — its lane has not happened. Judging it
 * here would report a surface nobody has agreed to move as broken, which is how a gate teaches
 * people to ignore it. When the site adopts the scale, widen this.
 */
const onMotionSurface = (rel: string) => rel.includes('packages/web/src/live/');

const motionFindings: (MotionFinding & { file: string })[] = [];
for (const file of files) {
  const css = readFileSync(file, 'utf8');
  const rel = relative(repoRoot, file);
  if (!onMotionSurface(rel)) continue;
  for (const f of [
    ...disagreeingTokens(css, expectedMotion),
    ...offFrameDurations(css),
    ...rawMotionLiterals(css, rel),
    ...phantomMotionRefs(css, knownMotion),
    // Rule 4. /broadcast is exempt by design (spec §6): it is a capture surface, and the harness
    // rather than a person decides what it renders — there is no viewer there to hold a preference.
    ...(rel.endsWith('Broadcast.css')
      ? []
      : rungsWithoutReducedAnswer(css).map(
          (t): MotionFinding => ({
            kind: 'reduced',
            line: 1,
            detail: `${t} animates here with no prefers-reduced-motion answer in this file`,
          }),
        )),
  ]) {
    motionFindings.push({ ...f, file: rel });
  }
}

if (findings.length === 0 && motionFindings.length === 0) {
  console.log(
    `tokens:check — ${files.length} stylesheets, no colour token lies and motion is on the scale`,
  );
  process.exit(0);
}

if (motionFindings.length > 0 && findings.length === 0) {
  reportMotion();
  process.exit(1);
}

console.error(`tokens:check FAILED — ${findings.length} colour token issue(s)\n`);
for (const f of findings) {
  const where = `${relative(repoRoot, f.file)}:${f.line}`;
  if (f.kind === 'phantom') {
    console.error(
      `  ${where}\n    ${f.token} is used with the colour fallback ${f.fallback} but is DEFINED NOWHERE.\n` +
        `    The fallback is silently acting as the token. Define ${f.token} (use ${f.fallback} to keep\n` +
        `    today's pixels), or drop the var() and name the colour outright.\n`,
    );
  } else {
    console.error(
      `  ${where}\n    ${f.token} is defined as ${f.declared!.join(' / ')} but this fallback says ${f.fallback}.\n` +
        `    The fallback is dead (the token resolves) and it misinforms the next reader.\n` +
        `    Drop the fallback: var(${f.token}).\n`,
    );
  }
}
console.error(
  'Runtime-parametric properties are never reported — neither non-colour ones (--i, --lc-mote-delay)\n' +
    'nor colour ones the sources actually set (--lc-amb-tint). A fallback there is the correct idiom.\n',
);
reportMotion();
process.exit(1);

/** The motion arm's report. A function so both exit paths above can reach it. */
function reportMotion(): void {
  if (motionFindings.length === 0) return;
  console.error(`tokens:check FAILED — ${motionFindings.length} motion issue(s)\n`);
  for (const f of motionFindings) {
    console.error(`  ${f.file}:${f.line}\n    ${f.kind}: ${f.detail}`);
  }
  console.error(
    '\n  The motion scale lives in packages/web/src/live/office-scene/motion.ts. Five rungs, each a\n' +
      '  whole number of frames at the 720p25 capture rate (120/200/280/400/600ms), and three easing\n' +
      '  roles (--lc-ease-out / --lc-ease-in-out / --lc-ease-pop). Use var(--lc-dur-N), never a bare\n' +
      '  duration or an inline cubic-bezier. `infinite` animations are ambient life and exempt.\n',
  );
}
