# Delight C — Motion Scale Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. This plan is executed by
> the lane owner in their own seat (musterd ADR 150 lane ownership) — not by dispatched subagents.

**Goal:** Give `/live` and `/broadcast` one motion vocabulary — five frame-pinned durations and three
easing roles — shared by CSS and canvas, held honest by a CI gate.

**Architecture:** `office-scene/motion.ts` is the single source of truth. `Live.css` mirrors its
values as custom properties. A new pure module `scripts/motion-scale.ts` holds the checking logic,
wired into the existing `pnpm tokens:check` so drift breaks the build. The canvas keeps its quadratic
easings (a bezier sampler would cost initial-JS bytes that Delight 0 bought); it shares the
**durations**, and `motion.ts` documents the quadratics as the canvas approximations of the same
three roles.

**Tech Stack:** TypeScript, vitest, Node native TS for scripts (no build step), CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-25-motion-scale-design.md`

## Global Constraints

- **Frame budget:** `/broadcast` is 720p25. One frame = **40ms**. Every rung must be a whole multiple.
- **Zero new initial-JS bytes.** Delight 0 (ADR 313) split the CSS budgets by surface; `pnpm perf:check`
  enforces them. No bezier sampler, no new runtime dependency.
- **`stillMode()` (ADR 285) determinism is non-negotiable** — the contrast gate depends on it.
- **Reduced-motion parity** — `Live.css` has 17 `prefers-reduced-motion` blocks; every rung used in a
  transition needs an answer under one.
- **`Broadcast.css` gets no `prefers-reduced-motion` blocks** (spec §6, deliberate).
- **Vitest runs from the repo root only.** `pnpm perf:check` reads `dist` — rebuild first.
- Commit trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

### Task 1: `motion.ts` — the source of truth

**Files:**
- Create: `packages/web/src/live/office-scene/motion.ts`
- Create: `packages/web/src/live/office-scene/motion.test.ts`
- Modify: `docs/superpowers/specs/2026-08-25-motion-scale-design.md` §4

**Interfaces:**
- Produces: `DUR` (`Record<'d1'|'d2'|'d3'|'d4'|'d5', number>`, ms), `EASE_CSS`
  (`Record<'out'|'inOut'|'pop', readonly [number,number,number,number]>`), `FRAME_MS: 40`,
  `CANVAS_EASE` (`Record<'in'|'out'|'inOut'|'linear', (t:number)=>number>`), `cssDuration(k)`,
  `cssEase(k)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/live/office-scene/motion.test.ts
import { describe, expect, it } from 'vitest';
import { CANVAS_EASE, DUR, EASE_CSS, FRAME_MS, cssDuration, cssEase } from './motion';

describe('the motion scale', () => {
  it('every rung is a whole number of frames at 25fps', () => {
    for (const [name, ms] of Object.entries(DUR)) {
      expect(ms % FRAME_MS, `${name}=${String(ms)}ms is not a whole frame`).toBe(0);
    }
  });

  it('rungs ascend and are distinct', () => {
    const values = Object.values(DUR);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the fastest rung is at least 3 frames — below that it reads as a snap on the stream', () => {
    expect(Math.min(...Object.values(DUR))).toBeGreaterThanOrEqual(3 * FRAME_MS);
  });

  it('renders CSS-ready strings', () => {
    expect(cssDuration('d2')).toBe('200ms');
    expect(cssEase('out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });

  it('canvas easings are normalised: f(0)=0, f(1)=1, monotonic', () => {
    for (const [name, f] of Object.entries(CANVAS_EASE)) {
      expect(f(0), name).toBeCloseTo(0, 6);
      expect(f(1), name).toBeCloseTo(1, 6);
      for (let t = 0; t < 1; t += 0.05) {
        expect(f(t + 0.05), `${name} monotonic at ${String(t)}`).toBeGreaterThanOrEqual(f(t) - 1e-9);
      }
    }
  });

  it('every CSS easing is a unit-interval bezier (x control points in [0,1])', () => {
    for (const [name, cp] of Object.entries(EASE_CSS)) {
      const [x1, , x2] = cp;
      expect(x1, name).toBeGreaterThanOrEqual(0);
      expect(x1, name).toBeLessThanOrEqual(1);
      expect(x2, name).toBeGreaterThanOrEqual(0);
      expect(x2, name).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /Users/nick/agents-miley && npx vitest run packages/web/src/live/office-scene/motion.test.ts`
Expected: FAIL — `Failed to resolve import "./motion"`.

- [ ] **Step 3: Write `motion.ts`**

```ts
/**
 * The motion scale (spec 2026-08-25-motion-scale-design.md).
 *
 * ONE source of truth for durations and easing roles. `Live.css` mirrors these values as custom
 * properties and `pnpm tokens:check` fails if the two ever disagree — a mirror rather than a build
 * step or a runtime read, because both of those cost initial-JS bytes that Delight 0 (ADR 313)
 * bought and this repo already holds every other invariant with a gate.
 *
 * WHY THE NUMBERS ARE THESE NUMBERS: /broadcast captures at 720p25, so one frame is 40ms. A
 * duration that is not a whole multiple lands mid-frame and its last rendered step is a partial one
 * — the judder the Delight C lane brief warns about. Every rung below is a whole frame count.
 */

/** One frame at the /broadcast capture rate (720p25). */
export const FRAME_MS = 40;

/** The five rungs. Frame counts: 3, 5, 7, 10, 15. */
export const DUR = {
  /** hover, press, focus feedback */
  d1: 120,
  /** the default transition */
  d2: 200,
  /** enter/exit of small elements */
  d3: 280,
  /** panels, layout shifts */
  d4: 400,
  /** sweeps, traces, one-shot flourishes */
  d5: 600,
} as const;

export type DurKey = keyof typeof DUR;

/**
 * The three easing roles, as CSS bezier control points.
 *
 * `pop` is the overshoot role and the riskiest at 25fps: an overshoot peak can fall between two
 * captured frames and simply not exist on the stream. Its control point is chosen against the
 * capture falsifier in the spec §7, not by eye.
 */
export const EASE_CSS = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.4, 0, 0.2, 1],
  pop: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type EaseKey = keyof typeof EASE_CSS;

/**
 * The canvas counterparts. These are QUADRATICS, not samples of the beziers above, and that is
 * deliberate: sampling a bezier per frame would ship a solver into the initial bundle for a
 * difference no viewer can name. The two engines share the DURATIONS (which is what reads as
 * consistency) and approximate the same three roles.
 */
export const CANVAS_EASE = {
  in: (t: number): number => t * t,
  out: (t: number): number => 1 - (1 - t) * (1 - t),
  inOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  linear: (t: number): number => t,
} as const;

/** `DUR.d2` → `'200ms'`, for a CSS-shaped consumer. */
export function cssDuration(key: DurKey): string {
  return `${String(DUR[key])}ms`;
}

/** `EASE_CSS.out` → `'cubic-bezier(0.16, 1, 0.3, 1)'` — the exact text `Live.css` must mirror. */
export function cssEase(key: EaseKey): string {
  return `cubic-bezier(${EASE_CSS[key].join(', ')})`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/nick/agents-miley && npx vitest run packages/web/src/live/office-scene/motion.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Amend the spec's §4**

The spec says `motion.ts` exports "control-point tuples plus sampling functions". It does not — a
sampler contradicts §4's own zero-bytes rationale. Replace that phrase with:

> It exports durations as numbers (the canvas needs ms, not CSS strings), the easing roles as control
> points for the CSS mirror, and the canvas's quadratic approximations of the same three roles. It
> deliberately does **not** sample the beziers: a solver in the initial bundle would cost the bytes
> Delight 0 bought, for a difference no viewer can name. The engines share durations, not curve math.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/motion.ts \
        packages/web/src/live/office-scene/motion.test.ts \
        docs/superpowers/specs/2026-08-25-motion-scale-design.md
git commit -m "feat(motion): the motion scale — five frame-pinned rungs, three easing roles

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: the gate's pure core

**Files:**
- Create: `scripts/motion-scale.ts`
- Create: `scripts/motion-scale.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately — it parses CSS text, so it stays testable without the web package).
- Produces: `declaredMotionTokens(css)`, `rawMotionLiterals(css)`, `offFrameDurations(css)`,
  `type MotionFinding = { kind: 'disagree'|'raw'|'off-frame'; line: number; detail: string }`.

Why a separate module: `check-css-tokens.ts` is straight-line script code with no exports and no
test. `scripts/adr-sections.ts` is the precedent — extracted from `check-change-adr.ts` so the logic
could be tested and shared. `scripts/**/*.test.ts` is already in the vitest include.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/motion-scale.test.ts
import { describe, expect, it } from 'vitest';
import { declaredMotionTokens, offFrameDurations, rawMotionLiterals } from './motion-scale.ts';

describe('declaredMotionTokens', () => {
  it('reads duration and easing custom properties with their line numbers', () => {
    const css = [':root {', '  --lc-dur-2: 200ms;', '  --lc-ease-out: cubic-bezier(0.16, 1, 0.3, 1);', '}'].join('\n');
    expect(declaredMotionTokens(css)).toEqual([
      { token: '--lc-dur-2', value: '200ms', line: 2 },
      { token: '--lc-ease-out', value: 'cubic-bezier(0.16, 1, 0.3, 1)', line: 3 },
    ]);
  });

  it('ignores non-motion custom properties', () => {
    expect(declaredMotionTokens(':root { --lc-r-sm: 6px; --lc-z-rail: 1; }')).toEqual([]);
  });
});

describe('rawMotionLiterals', () => {
  it('flags an inline cubic-bezier in a transition', () => {
    const css = '.a { transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1); }';
    expect(rawMotionLiterals(css)).toEqual([
      { kind: 'raw', line: 1, detail: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    ]);
  });

  it('flags a bare ms literal in a transition', () => {
    expect(rawMotionLiterals('.a { transition: opacity 240ms var(--lc-ease-out); }')).toEqual([
      { kind: 'raw', line: 1, detail: '240ms' },
    ]);
  });

  it('does not flag the :root declarations themselves — that is where values are allowed to live', () => {
    expect(rawMotionLiterals(':root { --lc-dur-2: 200ms; }')).toEqual([]);
  });

  it('does not flag an infinite animation — ambient loops are exempt by rule (spec §5)', () => {
    expect(rawMotionLiterals('.a { animation: drift 2.4s ease-in-out infinite; }')).toEqual([]);
  });
});

describe('offFrameDurations', () => {
  it('flags a duration that is not a whole frame at 25fps', () => {
    expect(offFrameDurations(':root { --lc-dur-x: 220ms; }')).toEqual([
      { kind: 'off-frame', line: 1, detail: '--lc-dur-x: 220ms is 5.5 frames at 25fps' },
    ]);
  });

  it('accepts a whole-frame duration', () => {
    expect(offFrameDurations(':root { --lc-dur-2: 200ms; }')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /Users/nick/agents-miley && npx vitest run scripts/motion-scale.test.ts`
Expected: FAIL — cannot resolve `./motion-scale.ts`.

- [ ] **Step 3: Write `scripts/motion-scale.ts`**

```ts
/*
 * The motion-scale checks behind `pnpm tokens:check` (spec 2026-08-25-motion-scale-design.md §4).
 *
 * Its own module for the same reason as `adr-sections.ts`: `check-css-tokens.ts` is a script that
 * reads files and calls process.exit, so logic living inside it cannot be tested. These are pure
 * text→findings functions; the script wires them to the filesystem and the exit code.
 *
 * Three rules:
 *   1. DISAGREE  — a motion token in CSS whose value differs from `motion.ts`.
 *   2. RAW       — a cubic-bezier() or bare ms literal in a transition/animation outside :root.
 *   3. OFF-FRAME — a duration that is not a whole frame at the 720p25 capture rate.
 *
 * EXEMPT BY RULE, not by list: an `infinite` animation is ambient life (clock sheen, breathing,
 * drift), not interaction feedback, and is not on the same scale as a hover transition.
 */

/** One frame at 720p25. Mirrors `FRAME_MS` in office-scene/motion.ts. */
export const FRAME_MS = 40;

export type MotionFinding = { kind: 'disagree' | 'raw' | 'off-frame'; line: number; detail: string };
export type MotionToken = { token: string; value: string; line: number };

const MOTION_TOKEN = /^\s*(--lc-(?:dur-\d+|ease(?:-[a-z]+)?))\s*:\s*([^;]+);/;
const DECLARATION = /^\s*--/;

/** Custom properties whose name marks them as motion. Line numbers are 1-indexed. */
export function declaredMotionTokens(css: string): MotionToken[] {
  const out: MotionToken[] = [];
  css.split('\n').forEach((text, i) => {
    // A `:root { --a: 1; --b: 2; }` one-liner holds several declarations on one line.
    for (const part of text.split(';')) {
      const m = MOTION_TOKEN.exec(`${part};`);
      if (m?.[1] && m[2]) out.push({ token: m[1], value: m[2].trim(), line: i + 1 });
    }
  });
  return out;
}

/** True when the line animates something rather than declaring a value. */
function isMotionUse(text: string): boolean {
  return /(transition|animation)\s*:/.test(text) && !DECLARATION.test(text);
}

/** Rule 2 — inline bezier / bare ms outside a declaration. `infinite` lines are exempt (spec §5). */
export function rawMotionLiterals(css: string): MotionFinding[] {
  const out: MotionFinding[] = [];
  css.split('\n').forEach((text, i) => {
    if (!isMotionUse(text) || /\binfinite\b/.test(text)) return;
    for (const m of text.matchAll(/cubic-bezier\([^)]*\)|\b\d+ms\b/g)) {
      out.push({ kind: 'raw', line: i + 1, detail: m[0] });
    }
  });
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

/** Rule 1 — CSS mirror vs the TS source. `expected` comes from office-scene/motion.ts. */
export function disagreeingTokens(
  css: string,
  expected: ReadonlyMap<string, string>,
): MotionFinding[] {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '');
  const out: MotionFinding[] = [];
  for (const { token, value, line } of declaredMotionTokens(css)) {
    const want = expected.get(token);
    if (want !== undefined && norm(want) !== norm(value)) {
      out.push({ kind: 'disagree', line, detail: `${token}: CSS has ${value}, motion.ts has ${want}` });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/nick/agents-miley && npx vitest run scripts/motion-scale.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/motion-scale.ts scripts/motion-scale.test.ts
git commit -m "feat(gate): motion-scale checking logic, extracted so it can be tested

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: wire the gate, and let it produce the worklist

This task's deliverable is a **failing gate with a real list of offenders**. Do not fix anything here.

**Files:**
- Modify: `scripts/check-css-tokens.ts` (append a motion section before the findings report)

- [ ] **Step 1: Import the checks and the expected values**

Add near the top of `scripts/check-css-tokens.ts`:

```ts
import { DUR, EASE_CSS } from '../packages/web/src/live/office-scene/motion.ts';
import { disagreeingTokens, offFrameDurations, rawMotionLiterals } from './motion-scale.ts';

/** The CSS text each motion token must carry, derived from the TS source. */
const expectedMotion = new Map<string, string>([
  ...Object.entries(DUR).map(([k, ms]) => [`--lc-${k.replace('d', 'dur-')}`, `${String(ms)}ms`] as const),
  ...Object.entries(EASE_CSS).map(
    ([k, cp]) =>
      [`--lc-ease-${k === 'inOut' ? 'in-out' : k}`, `cubic-bezier(${cp.join(', ')})`] as const,
  ),
]);
```

- [ ] **Step 2: Run the motion rules over every CSS file**

After the existing colour `findings` loop, before the report:

```ts
for (const file of files) {
  const css = readFileSync(file, 'utf8');
  const rel = relative(repoRoot, file);
  for (const f of [
    ...disagreeingTokens(css, expectedMotion),
    ...offFrameDurations(css),
    ...rawMotionLiterals(css),
  ]) {
    findings.push({ file: rel, line: f.line, message: `motion (${f.kind}): ${f.detail}` });
  }
}
```

Match the shape of the existing `Finding` type — read its declaration at
`scripts/check-css-tokens.ts:155` and adapt the push above to its exact fields rather than assuming.

- [ ] **Step 3: Run the gate and capture the worklist**

Run: `cd /Users/nick/agents-miley && pnpm tokens:check 2>&1 | tee /tmp/motion-worklist.txt`
Expected: **FAIL**, listing roughly 8 raw beziers, ~10 bare-ms transitions, and the off-frame
declarations (`--lc-fast: 140ms` = 3.5 frames, `--lc-med: 220ms` = 5.5 frames).

- [ ] **Step 4: Read the list and confirm it matches the spec's measurements**

The spec §1 counted 8 distinct beziers and 25 distinct `ms` durations. If the gate finds materially
fewer, a rule is too narrow — most likely `isMotionUse` missing multi-line `transition:` blocks,
which are common in this stylesheet (see `Live.css:1782-1785`). Fix the rule and re-run before
moving on; a gate that under-reports is worse than no gate.

- [ ] **Step 5: Commit the gate, still red**

```bash
git add scripts/check-css-tokens.ts
git commit -m "feat(gate): tokens:check gains a motion arm (red — worklist follows)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `Live.css` — mirror the tokens, snap the clusters

**Files:**
- Modify: `packages/web/src/live/Live.css` (token block at lines 101-104; call sites throughout)
- Modify: `packages/web/src/styles/tokens.css` (remove `--ease-out`, `--ease-in-out` at lines 70-71)

- [ ] **Step 1: Replace the token block**

`Live.css:101-104` currently reads:

```css
  --lc-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --lc-ease-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --lc-fast: 140ms;
  --lc-med: 220ms;
```

Replace with:

```css
  /* The motion scale — mirrors office-scene/motion.ts, enforced by `pnpm tokens:check`.
     Frame counts at the 720p25 capture rate: 3, 5, 7, 10, 15. */
  --lc-dur-1: 120ms;
  --lc-dur-2: 200ms;
  --lc-dur-3: 280ms;
  --lc-dur-4: 400ms;
  --lc-dur-5: 600ms;
  --lc-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --lc-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --lc-ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);
```

- [ ] **Step 2: Migrate every call site, using this mapping**

| Was | Becomes |
|---|---|
| `45ms`, `50ms`, `90ms`, `120ms`, `140ms`, `160ms` | `var(--lc-dur-1)` |
| `180ms`, `200ms`, `220ms`, `240ms` | `var(--lc-dur-2)` |
| `260ms`, `280ms`, `300ms`, `320ms` | `var(--lc-dur-3)` |
| `380ms`, `420ms`, `440ms`, `460ms`, `480ms` | `var(--lc-dur-4)` |
| `520ms`, `560ms`, `620ms`, `700ms` | `var(--lc-dur-5)` |
| `900ms`, `1200ms` | `var(--lc-dur-5)`, or allowlist with a reason if the length is deliberate |
| `var(--lc-fast)` | `var(--lc-dur-1)` |
| `var(--lc-med)` | `var(--lc-dur-2)` |
| `cubic-bezier(0.16, 1, 0.3, 1)`, `cubic-bezier(0.22, 1, 0.36, 1)`, `var(--lc-ease)`, `var(--lc-ease-quart)` | `var(--lc-ease-out)` |
| `cubic-bezier(0.4, 0, 0.2, 1)`, `var(--ease-in-out)` | `var(--lc-ease-in-out)` |
| `cubic-bezier(0.34, 1.56, 0.64, 1)`, `cubic-bezier(0.34, 1.4, 0.5, 1)`, `cubic-bezier(0.2, 0.9, 0.3, 1.4)`, `cubic-bezier(0.2, 0.9, 0.25, 1.08)` | `var(--lc-ease-pop)` |

The three sub-frame values (`45ms`, `50ms`, `90ms`) are the spec's named defects — they cannot render
as motion at 25fps, so they rise to `--lc-dur-1` rather than rounding to the nearest rung.

Leave every `infinite` animation untouched — exempt by rule.

- [ ] **Step 3: Handle the six one-shot second-scale outliers**

`0.42s`, `0.5s`, `1.4s`, `1.5s`, `2.8s`, `3.6s`. For each: read the rule it belongs to and decide.

- If it is interaction feedback, snap it to the nearest rung.
- If it is a deliberate long one-shot, add it to an `ALLOWED_LONG` list in `scripts/motion-scale.ts`
  as `{ value, file, reason }` — the reason is a sentence naming what breaks if it shortens.

The spec flags `0.42s` and `0.5s` as likely drift rather than intent. Test that: shorten them to a
rung, look at the element, and keep the change unless something visibly breaks.

- [ ] **Step 4: Delete the superseded global tokens**

Remove `--ease-out` and `--ease-in-out` from `packages/web/src/styles/tokens.css:70-71`. Note these
are two *different* curves from their `Live.css` counterparts — `--ease-in-out` is
`(0.65, 0, 0.35, 1)` where the literal in use is `(0.4, 0, 0.2, 1)`. Anything still pointing at the
global tokens moves to `--lc-ease-in-out` and will therefore change slightly. That is the agreed
near-duplicate collapse, not a regression.

Run `grep -rn "var(--ease-out)\|var(--ease-in-out)" packages/web/src` first; migrate every hit.

- [ ] **Step 5: Run the gate**

Run: `cd /Users/nick/agents-miley && pnpm tokens:check`
Expected: PASS.

- [ ] **Step 6: Run the a11y and perf gates**

```bash
cd /Users/nick/agents-miley
pnpm -r build && pnpm perf:check
```

Expected: PASS. CSS bytes should fall slightly — tokens are shorter than repeated literals. If
`perf:check` reports growth, a `var()` chain has been introduced where a literal was; find it.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/live/Live.css packages/web/src/styles/tokens.css scripts/motion-scale.ts
git commit -m "feat(motion): Live.css moves onto the scale — one vocabulary, gate green

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: reduced-motion parity

**Files:**
- Modify: `packages/web/src/live/Live.css` (the 17 `prefers-reduced-motion` blocks)
- Modify: `scripts/motion-scale.ts`
- Modify: `scripts/motion-scale.test.ts`

- [ ] **Step 1: Write the failing test for rule 4**

```ts
// append to scripts/motion-scale.test.ts
import { rungsWithoutReducedAnswer } from './motion-scale.ts';

describe('rungsWithoutReducedAnswer', () => {
  it('flags a rung used in a transition that no reduced-motion block answers', () => {
    const css = ['.a { transition: opacity var(--lc-dur-2) var(--lc-ease-out); }'].join('\n');
    expect(rungsWithoutReducedAnswer(css)).toEqual(['--lc-dur-2']);
  });

  it('accepts a rung the reduced block neutralises', () => {
    const css = [
      '.a { transition: opacity var(--lc-dur-2) var(--lc-ease-out); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .a { transition-duration: 0s; }',
      '}',
    ].join('\n');
    expect(rungsWithoutReducedAnswer(css)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /Users/nick/agents-miley && npx vitest run scripts/motion-scale.test.ts`
Expected: FAIL — `rungsWithoutReducedAnswer` is not exported.

- [ ] **Step 3: Implement it**

```ts
/**
 * Rule 4 — every rung used in a transition needs a reduced-motion answer somewhere in the file.
 *
 * Deliberately coarse: it asks whether the stylesheet neutralises motion under
 * `prefers-reduced-motion` at all for each rung, not whether every selector is individually covered.
 * A per-selector rule would need a CSS cascade model; this catches the case that actually happens —
 * a new rung landing with no reduced-motion story at all.
 */
export function rungsWithoutReducedAnswer(css: string): string[] {
  const used = new Set<string>();
  for (const line of css.split('\n')) {
    if (!isMotionUse(line) || /\binfinite\b/.test(line)) continue;
    for (const m of line.matchAll(/var\((--lc-dur-\d+)\)/g)) if (m[1]) used.add(m[1]);
  }
  const reduced = css.split('@media (prefers-reduced-motion');
  const answered = reduced.length > 1 && /transition-duration:\s*0s|animation:\s*none/.test(css);
  return answered ? [] : [...used].sort();
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/nick/agents-miley && npx vitest run scripts/motion-scale.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire rule 4 into the gate and run it**

Add `...rungsWithoutReducedAnswer(css).map((t) => ({ kind: 'reduced' as const, line: 1, detail: t }))`
to the findings loop in `check-css-tokens.ts`, widening `MotionFinding['kind']` to include
`'reduced'`.

Run: `cd /Users/nick/agents-miley && pnpm tokens:check`
Expected: PASS for `Live.css` (17 blocks exist). `Broadcast.css` has zero blocks — if it fails there,
add `Broadcast.css` to an explicit skip with the spec §6 reason as its comment. It is a capture
surface with no human viewer to hold a preference.

- [ ] **Step 6: Commit**

```bash
git add scripts/motion-scale.ts scripts/motion-scale.test.ts scripts/check-css-tokens.ts
git commit -m "feat(gate): a rung in a transition must have a reduced-motion answer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: the canvas joins the scale

**Files:**
- Modify: `packages/web/src/live/office-scene/actors.ts:39-44`
- Modify: `packages/web/src/live/office-scene/render.ts:4198`
- Modify: `packages/web/src/live/office-scene/actors.test.ts`

- [ ] **Step 1: Point `actors.ts` at `motion.ts`**

Delete the three local definitions at `actors.ts:39-41` and the `EASE` record at line 44. Replace:

```ts
import { CANVAS_EASE } from './motion';

const EASE: Record<Ease, (t: number) => number> = CANVAS_EASE;
```

The four keys (`in`, `out`, `inOut`, `linear`) are unchanged, so every call site keeps working. The
functions are byte-identical to the ones they replace — this is a move, not a retune, and the
existing `actors.test.ts` is the proof.

- [ ] **Step 2: Run the scene suite to prove nothing moved**

Run: `cd /Users/nick/agents-miley && npx vitest run packages/web/src/live/office-scene/`
Expected: PASS, unchanged count. Any failure here means the functions were not identical — revert and
compare them character by character before continuing.

- [ ] **Step 3: Replace the inline expression in `render.ts`**

`render.ts:4198` reads `const eased = 1 - Math.pow(1 - t, 2);` — that is exactly `CANVAS_EASE.out`.

```ts
const eased = CANVAS_EASE.out(t);
```

Add `CANVAS_EASE` to the existing `./motion` import.

- [ ] **Step 4: Add a test that the canvas and CSS share durations**

```ts
// packages/web/src/live/office-scene/motion.test.ts — append
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('Live.css mirrors every rung — the gate enforces this, this test explains it', () => {
  const css = readFileSync(join(__dirname, '../Live.css'), 'utf8');
  for (const [key, ms] of Object.entries(DUR)) {
    expect(css, `--lc-${key.replace('d', 'dur-')} missing from Live.css`).toContain(
      `--lc-${key.replace('d', 'dur-')}: ${String(ms)}ms;`,
    );
  }
});
```

- [ ] **Step 5: Run the suite**

Run: `cd /Users/nick/agents-miley && npx vitest run packages/web/src/live/office-scene/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/actors.ts \
        packages/web/src/live/office-scene/render.ts \
        packages/web/src/live/office-scene/motion.test.ts
git commit -m "feat(motion): the canvas shares the scale's durations

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: tune `--lc-ease-pop` against the capture

This is the spec's §7 falsifier and the one task that cannot be satisfied by a test.

**Files:**
- Modify: `packages/web/src/live/office-scene/motion.ts` (`EASE_CSS.pop`)
- Modify: `packages/web/src/live/Live.css` (`--lc-ease-pop`)
- Create: `docs/perf/motion-capture.md`

- [ ] **Step 1: Bring up a 720p25 capture**

The hosted stream was stopped on 2026-08-25. Either restart it (`musterd stream start`) or run a
local capture at the same settings. Confirm the rate before trusting any frame count.

- [ ] **Step 2: Capture the three interactions**

Step frame-by-frame through: (a) one hover, (b) one panel open, (c) one accept-confetti.

- [ ] **Step 3: Count frames and record them**

Write `docs/perf/motion-capture.md` with a row per interaction: expected frames (from the rung),
observed frames, and whether the `--lc-ease-pop` overshoot peak is visible in at least one frame.

- [ ] **Step 4: If the overshoot peak is missing, retune**

`(0.34, 1.56, 0.64, 1)` peaks around t≈0.7. On a 280ms (7-frame) transition that is frame 5 — it
should be visible. If it is not, either the rung is too short for an overshoot or the control point
needs its peak moved toward a frame boundary. Change `EASE_CSS.pop` in `motion.ts`, mirror it in
`Live.css`, re-run `pnpm tokens:check`, and re-capture.

**Do not skip to a "looks fine locally" conclusion.** A 120Hz laptop shows every overshoot; the
stream is the only surface that can falsify this.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/motion.ts packages/web/src/live/Live.css docs/perf/motion-capture.md
git commit -m "perf(motion): tune the overshoot against the 720p25 capture

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: the ADR, and the full gate chain

**Files:**
- Create: `docs/decisions/<N>-motion-scale-gate.md`

- [ ] **Step 1: Get a number with `pnpm adr:next` — NOT by listing the directory**

Run: `cd /Users/nick/agents-miley && pnpm adr:next`

**Do not use `ls docs/decisions/ | sort -n | tail -1`.** That reads only this checkout, so it cannot
see a number an *open PR* has already claimed — which is exactly how this plan's first attempt
collided: it took 327, and `327-team-insight-act.md` was already claimed on another branch. CI's
`adr-numbers:check` catches it, but only after a push. `pnpm adr:next` reads the open PRs too.

- [ ] **Step 2: Write the ADR**

Follow the shape of `docs/decisions/313-*.md` (the Delight 0 budget split) — it is the closest
precedent: a gate added to protect a measured property of the web surface. Cover:

- **Context** — three namespaces, 25 durations, 8 beziers, two engines; the 40ms frame.
- **Decision** — the five rungs and three roles; mirror-and-gate rather than codegen or runtime read;
  `infinite` exempt by rule; `Broadcast.css` deliberately without reduced-motion blocks.
- **Consequences** — a new value now costs a gate conversation; the canvas and CSS share durations
  but not curve math.
- **Observability** — `pnpm tokens:check` fails on drift; `docs/perf/motion-capture.md` holds the
  frame counts.

- [ ] **Step 3: Run the full chain**

```bash
cd /Users/nick/agents-miley
pnpm format:check && pnpm lint && npx vitest run && pnpm -r build && pnpm perf:check
```

Expected: all green. `format:check` runs `tokens:check`, `vocab:check`, `adr-numbers:check` and the
rest — this is the real gate.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/decisions/329-motion-scale-gate.md
git commit -m "docs: ADR 329 — the motion scale and its gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin miley/motion-scale
gh pr create --title "Delight C: the motion scale — frame-pinned rungs, one vocabulary, a gate (ADR 329)" --body "..."
```

- [ ] **Step 5: Submit the lane for acceptance**

`lane_submit` on `01M0GVP9KV4J4S4P21EGGDQH0M` with the PR number and merge SHA. Acceptance is
cross-model per the team's routing.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 frame constraint | Task 1 (test), Task 2 (rule 3) |
| §3 the scale + easing roles | Task 1, Task 4 |
| §4 mirror and gate | Tasks 2, 3, 4 |
| §5 exemptions (`infinite` rule, six outliers) | Task 2 (rule), Task 4 step 3 (outliers) |
| §6 parity | Task 5 |
| §7 verification | Task 7 |
| §9 open question 1 (ADR) | Task 8 |
| §9 open question 2 (`pop` control point) | Task 7 |

No gaps.

**Type consistency:** `MotionFinding` gains `'reduced'` in Task 5 — noted in that task rather than
left to be discovered. `CANVAS_EASE` keys match `actors.ts`'s existing `Ease` type. `DUR` keys are
`d1…d5` in TS and `--lc-dur-1…5` in CSS; the `k.replace('d', 'dur-')` mapping appears in Task 3 and
Task 6 and is identical in both.

**Known risk:** Task 4 is the largest step and touches ~60 call sites in one file. It is one task
because a half-migrated stylesheet fails the gate and cannot be committed green — splitting it would
mean committing red. If it proves unwieldy, split by section of `Live.css` with the gate temporarily
scoped to the migrated sections, never by leaving the gate red.
