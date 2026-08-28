/*
 * What kind of value is this, and is it a kind `tokens:check` can judge?
 *
 * Its own module for the same reason as `motion-scale.ts`: `check-css-tokens.ts` reads files and
 * calls process.exit, so logic living inside it cannot be tested. These are pure value→kind
 * functions; the script wires them to the filesystem and the exit code.
 *
 * WHY THIS EXISTS. The colour arm of `tokens:check` guards two silent lies — a token used with a
 * fallback but defined nowhere, and a fallback that disagrees with the definition. It skipped
 * everything that was not a colour, and the header called that an exemption for "numbers, times and
 * lengths" on the grounds that a runtime-parametric property is SUPPOSED to be undefined in the
 * stylesheet and carry a fallback.
 *
 * That reasoning was right about numbers and times and wrong about lengths, and the exemption was
 * drawn around the wrong thing. Being non-colour was only ever a cheap proxy for being parametric —
 * and the check already has a precise test for parametric (it scans the sources for
 * `setProperty('--x', …)` and `style={{ '--x': … }}`), which made the proxy redundant the day it
 * landed. Measured 2026-08-28: `color: var(--nope, #ff0000)` failed the gate and
 * `font-size: var(--nope, 13px)` passed it — the identical lie, one property over. See
 * docs/wiki/constraint-outlives-its-premise.md, which is about exactly this shape of stale premise
 * and cites this gate as one of its two instances.
 *
 * So `length` joins `colour` as judgeable, and `other` keeps the exemption that was always the real
 * one: bare numbers, durations and angles, which stay parametric and stay quiet.
 *
 * `other` HOLDS ONE MORE CLASS, and it is not exempt for the reason above. An easing keyword or a
 * `cubic-bezier(...)` also lands in `other`, and it is neither parametric nor runtime-set — nothing
 * writes it from TS, and a phantom easing is exactly the lie this gate was built to catch. It is
 * quiet HERE because it is loud ELSEWHERE: `motion-scale.ts` rule 5 owns the `--lc-dur-*` /
 * `--lc-ease*` namespace and fails on both `var(--lc-ease, ease)` and a bare `var(--lc-ease)`.
 * Judging timing functions here would mean this module reaching outside its own subject, and the
 * two arms would then disagree about who owns the finding. So: `other` is not one exemption but
 * two — the parametric one, and a jurisdictional one that assumes rule 5 is doing its job.
 *
 * WHERE THAT ASSUMPTION RUNS OUT, measured 2026-08-28 at 903aa7ac. Rule 5 is scoped by
 * `onMotionSurface` to /live, because the public site never moved onto the scale. So the same
 * `transition: opacity 200ms var(--lc-ease, ease)` fails in Live.css and PASSES in
 * components/Footer.css — uncovered by rule 5 (wrong surface) and by this module (wrong kind).
 * A phantom easing outside /live, or under a name outside `--lc-*`, is caught by neither arm.
 * That is a known gap, not an oversight: closing it means widening rule 5's surface, which is a
 * decision about the public site's motion, not about value kinds. Do not close it here.
 */

/** A literal colour: hex, or a colour function. Deliberately NOT matching `var(...)` — a fallback
 *  that defers to another token is a chain, not a claimed value, and has nothing to disagree with. */
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|lab|color-mix)\()/i;

/**
 * A literal length: a number with a CSS length or percentage unit.
 *
 * UNIT REQUIRED, and that is the line between this and the exemption. `--i` (a stagger index) and
 * `--lc-mote-delay` (a time) are parametric by design and legitimately carry a fallback for the
 * frame before JS sets them; a bare `0` or `3` or `200ms` must stay invisible to this gate or the
 * correct idiom becomes a build failure, which is how a gate gets disabled rather than fixed.
 *
 * `calc()` is excluded on purpose: it may well resolve to a length, but it claims no value this
 * gate could compare a definition against, so judging it would mean guessing.
 */
const LENGTH =
  /^-?(?:\d*\.\d+|\d+)(px|rem|em|ch|ex|vw|vh|vmin|vmax|%|pt|pc|in|cm|mm|q|cqw|cqh|cqi|cqb|cqmin|cqmax)$/i;

export type ValueKind = 'colour' | 'length' | 'other';

export const isColour = (value: string): boolean => COLOUR.test(value.trim());

export const isLength = (value: string): boolean => LENGTH.test(value.trim());

/**
 * The kind of a `var()` fallback. `other` means "not this gate's business" — either parametric
 * (bare numbers, durations, angles) or another arm's subject (easing, which rule 5 owns) — and is
 * the only kind the caller should skip.
 */
export function valueKind(value: string): ValueKind {
  if (isColour(value)) return 'colour';
  if (isLength(value)) return 'length';
  return 'other';
}
