/*
 * The motion-scale checks behind `pnpm tokens:check` (spec 2026-08-25-motion-scale-design.md §4).
 *
 * Its own module for the same reason as `adr-sections.ts`: `check-css-tokens.ts` is a script that
 * reads files and calls process.exit, so logic living inside it cannot be tested. These are pure
 * text→findings functions; the script wires them to the filesystem and the exit code.
 *
 * Five rules:
 *   1. DISAGREE  — a motion token in CSS whose value differs from `motion.ts`.
 *   2. RAW       — a cubic-bezier() or a bare duration (ms OR s) in a motion declaration. Fails
 *                  closed like rule 3: a duration-shaped value it cannot read is UNREADABLE.
 *   3. OFF-FRAME — a duration that is not a whole frame at the 720p25 capture rate. Fails closed:
 *                  a rung it cannot read is reported (UNREADABLE), never skipped.
 *   4. REDUCED   — a rung used in a transition with no prefers-reduced-motion answer in the file.
 *   5. PHANTOM   — a motion var() in a transition that no stylesheet declares.
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
 * Rule 5 is NOT namespace-bound, and this note used to imply that by listing the three rules that
 * are — while rule 5's own pattern was `--lc-(?:dur-…|ease…|fast|med)`, i.e. bound harder than any
 * of them. dolly measured the consequence on #1109: `transition: opacity 200ms var(--lc-motion-ease,
 * ease)` in Live.css passed a green gate, on the motion surface, under a `--lc-` name. Rule 5 judges
 * by SITE now — a var() inside a motion declaration is a motion value whatever it is called, and one
 * that resolves to nothing does not animate. Closing the class by construction, the same move rule 2
 * made with `TIMING_WORD` and rule 3 with `durationMs`, after widening-by-enumeration failed twice.
 *
 * A NOTE ON MULTI-LINE DECLARATIONS. `Live.css` writes most of its transitions across several lines
 * (see the four-property block at Live.css:1782). A per-line scan would silently miss every
 * continuation line — a gate that under-reports is worse than no gate — so declarations are
 * assembled from their opening `transition:`/`animation:` to the terminating `;` before anything is
 * judged, and each literal is still reported against the line it physically sits on.
 */

/** One frame at 720p25 — imported, not mirrored. It was a copy with a "mirrors motion.ts" comment
 *  and no gate: the one ungated mirror in a change whose whole thesis is that mirrors get gates. */
export { FRAME_MS } from '../packages/web/src/live/office-scene/motion.ts';
import { FRAME_MS } from '../packages/web/src/live/office-scene/motion.ts';

export type MotionFinding = {
  kind: 'disagree' | 'raw' | 'off-frame' | 'unreadable' | 'reduced' | 'phantom';
  line: number;
  detail: string;
};
export type MotionToken = { token: string; value: string; line: number };

/** `--lc-dur-*` and `--lc-ease*` are the motion namespace. Deliberately not `--lc-r-*`/`--lc-z-*`. */
const MOTION_TOKEN = /(--lc-(?:dur-[\w-]+|ease[\w-]*))\s*:\s*([^;]+)/;

/**
 * A bezier, or a whole word that might be a duration. NOT a duration grammar — that is `durationMs`.
 *
 * This was `/cubic-bezier\(...\)|(?<![\w.-])(?:\d+(?:\.\d+)?|\.\d+)m?s\b/`: rule 2's own private
 * pattern for what a duration looks like, and the third one in this file. It was case-sensitive and
 * knew nothing of signs or exponents, so `0.18S`, `180MS` and `1.8e-1s` — all 180ms, all browser
 * valid, all rule 2's own defect class — rode a green gate while `180ms` failed it. ryder's REQUIRED
 * on #1082 round 3, and the same defect rule 3 had one round earlier.
 *
 * Widening it again was the wrong shape twice, so this does not try to describe a duration at all:
 * it hands `rawMotionLiterals` every word in the declaration, and a word that LOOKS like a duration
 * (has a digit, ends in an s unit) is put through `durationMs` — counted if it reads, reported as
 * UNREADABLE if it does not. The class closes by construction rather than by enumeration.
 */
const TIMING_WORD = /cubic-bezier\([^)]*\)|[\w.+-]+/g;

/** Looks like a duration, whatever it turns out to be: has a digit and ends in an s unit. */
function isDurationShaped(word: string): boolean {
  return /\d/.test(word) && /m?s$/i.test(word);
}

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

type MotionSegment = { text: string; start: number };
type MotionDecl = { property: string; text: string; start: number; segments: MotionSegment[] };

/**
 * The properties that carry motion. `-duration` and `-timing-function` longhands are included:
 * without them the standing falsifier's promise — "a reintroduced bare 240ms fails CI" — was simply
 * false for `transition-duration: 240ms` (ryder's non-blocking (a) on #1079).
 *
 * `-delay` is deliberately absent, and that is a claim rather than an omission: a delay shifts WHEN
 * motion starts, it is not motion, so no whole-frame requirement applies to it. Getting this
 * backwards is what made ADR 329 call three stagger delays "defects" (ryder's REQUIRED 2).
 */
const OPENER = /(?:^|[;{}\s])((?:transition|animation)(?:-duration|-timing-function)?)\s*:/g;

/** Offset → 1-indexed line, by binary search over line starts. */
function lineIndexer(css: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < css.length; i++) if (css[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Split a shorthand value on TOP-LEVEL commas — one segment per animation, parens protected. */
function topLevelSegments(text: string, start: number): MotionSegment[] {
  const segs: MotionSegment[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      segs.push({ text: text.slice(from, i), start: start + from });
      from = i + 1;
    }
  }
  segs.push({ text: text.slice(from), start: start + from });
  return segs;
}

/**
 * Every motion declaration, from its property to the `;` (or `}`) that ends it.
 *
 * Scanned over the whole text by offset rather than line-by-line. The line-based version closed a
 * declaration on the first `;` it saw on the OPENING line — so `.a { color: red; transition:` ended
 * the declaration before its value began and dropped every continuation line (ryder's
 * non-blocking (c)).
 */
function motionDeclarations(css: string): MotionDecl[] {
  const out: MotionDecl[] = [];
  for (const m of css.matchAll(OPENER)) {
    const valueStart = (m.index ?? 0) + m[0].length;
    const semi = css.indexOf(';', valueStart);
    const brace = css.indexOf('}', valueStart);
    let stop = semi === -1 ? css.length : semi;
    if (brace !== -1 && brace < stop) stop = brace; // an unterminated final declaration
    const text = css.slice(valueStart, stop);
    out.push({
      property: m[1] ?? '',
      text,
      start: valueStart,
      segments: topLevelSegments(text, valueStart),
    });
  }
  return out;
}

/**
 * Rule 2 — a raw bezier or duration inside a motion declaration.
 *
 * The `infinite` exemption applies PER ANIMATION, not per declaration. Applying it to the whole
 * declaration let a comma-separated shorthand smuggle a finite animation past the gate behind an
 * ambient sibling — `animation: sheen 3s linear infinite, card-in 200ms ease` (stanley's finding on
 * the Delight C acceptance).
 */
export function rawMotionLiterals(css: string, file = ''): MotionFinding[] {
  const lineAt = lineIndexer(css);
  const out: MotionFinding[] = [];
  for (const decl of motionDeclarations(css)) {
    for (const seg of decl.segments) {
      if (/\binfinite\b/.test(seg.text)) continue; // ambient loop, exempt by rule
      for (const m of seg.text.matchAll(TIMING_WORD)) {
        const literal = m[0];
        const line = lineAt(seg.start + (m.index ?? 0));
        if (literal.startsWith('cubic-bezier(')) {
          out.push({ kind: 'raw', line, detail: literal });
          continue;
        }
        if (!isDurationShaped(literal)) continue;
        const ms = durationMs(literal);
        if (ms === null) {
          // Fails CLOSED, exactly as rule 3 does: the gate cannot count this one's frames, so it
          // says so. Staying quiet would let the reader infer it counted them and was happy.
          out.push({
            kind: 'unreadable',
            line,
            detail:
              `${literal} — reads as a duration but cannot be parsed as one, so its frame count ` +
              `is unknown. Write it as a plain number of ms or s (e.g. 200ms, 0.2s); ` +
              `signs, exponents and indirection are not accepted here on purpose.`,
          });
          continue;
        }
        if (ms === 0) continue; // no transition at all — never a scale violation
        if (isAllowedLong(ms, file, decl.property, seg.text)) continue;
        out.push({ kind: 'raw', line, detail: literal });
      }
    }
  }
  return out;
}

/*
 * `0s` / `0ms` is never a scale violation — a zero duration means "no transition". It is the
 * reduced-motion neutralisation idiom, and it is also how `transition: visibility 0s linear <delay>`
 * toggles visibility without animating it (Live.css:4826). Flagging zero would demand the
 * reduced-motion answers be broken to satisfy the rule that requires them.
 *
 * This was a fourth private grammar (`/^0(?:\.0+)?m?s$/`, case-sensitive like the rest). It is now
 * `durationMs(literal) === 0` at the call site, so `0S` and `0.0ms` are the same zero the browser
 * sees.
 */

/**
 * The deliberate one-shot outliers the spec (§5) promised an allowlist for and never got one,
 * because rule 2 could not see `s` units at all — the blindness hid the need.
 *
 * Every entry costs a sentence. That is the point: an exception should be cheap to read and
 * annoying to add. These are keyframe one-shots and a countdown, none of which are interaction
 * feedback, so none of them belong on a scale built for interaction feedback.
 */
const ALLOWED_LONG: {
  value: string;
  file: string;
  property: string;
  token: string;
  reason: string;
}[] = [
  {
    value: '1s',
    file: 'ApprovalCard.css',
    property: 'transition',
    token: 'width',
    reason: 'the expiry bar is a countdown driven by a per-second tick; a rung would desync it',
  },
  {
    value: '0.42s',
    file: 'Live.css',
    property: 'animation',
    token: 'lc-enter',
    reason: 'lc-enter one-shot entrance, tuned with the scene',
  },
  {
    value: '1.7s',
    file: 'Live.css',
    property: 'animation',
    token: 'lc-settle',
    reason: 'lc-settle one-shot, deliberately slower than any UI rung',
  },
  {
    value: '1.5s',
    file: 'Live.css',
    property: 'animation',
    token: 'lc-flash',
    reason: 'lc-flash one-shot attention beat',
  },
  {
    value: '0.5s',
    file: 'Live.css',
    property: 'animation',
    token: 'lc-rise',
    reason: 'lc-rise one-shot entrance',
  },
  {
    value: '3.6s',
    file: 'Live.css',
    property: 'animation-duration',
    token: '',
    reason: 'ambient duration longhand on a looping keyframe',
  },
];

/**
 * `within` is ryder's non-blocking (a) on #1082, twice over.
 *
 * Round one: the check was value + filename, so `1s` was exempt ANYWHERE in ApprovalCard.css,
 * including a hover transition nobody had reasoned about.
 *
 * Round two: keying on `within` alone via `context.includes()` matched a bare substring against
 * `property:segment`, so `max-width` inherited `width`'s exemption — one property silently taking
 * another's. And the doc-comment claimed the exemption "binds to the declaration that earned it"
 * while the code bound it to file + property substring. The claim is the thing that gets cited, so
 * either the claim or the match had to narrow; narrowing the match is the honest direction.
 *
 * So an entry names its `property` exactly and the `token` that identifies the site within it
 * (an animation name, or the animated property). Both must hold. `3.6s` is exempt as a duration
 * longhand and has no animation name, so its token is empty — the property alone identifies it.
 *
 * Matched on the VALUE in milliseconds, not on the spelling: an entry written `1s` exempts `1S` and
 * `1000ms` at the same site, because they are the same second and the exemption was reasoned about
 * the duration, not the characters.
 */
function isAllowedLong(ms: number, file: string, property: string, segment: string): boolean {
  return ALLOWED_LONG.some(
    (a) =>
      durationMs(a.value) === ms &&
      file.endsWith(a.file) &&
      property.trim().toLowerCase() === a.property &&
      (a.token === '' || new RegExp(`(?<![\\w-])${a.token}(?![\\w-])`).test(segment)),
  );
}

/** Two decimals, trailing zeros trimmed — `180` stays `180`, `4.5` stays `4.5`, `4.50` doesn't. */
const trim2 = (n: number) =>
  n
    .toFixed(2)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

/**
 * A declared duration in milliseconds, or null if the value isn't a bare duration.
 *
 * BOTH UNITS, and this is ryder's REQUIRED 1 on #1082. Rule 3 used to parse `/^(\d+)ms$/` and
 * `continue` on anything else, so a rung declared in seconds was never counted in frames at all —
 * and no other rule covered the gap: rule 2 doesn't scan `:root` declarations, and rule 1 only
 * fires for tokens already in motion.ts's map, so a NEW rung was in neither. `--lc-dur-6: 0.18s`
 * left the whole gate green: 4.5 frames, rule 3's own defect class, on the scale itself.
 *
 * Seconds are converted by decimal shift rather than `* 1000` because `0.18 * 1000` is
 * 180.00000000000003 in IEEE754, and a gate that reports `--lc-dur-6: 180.00000000000003ms is
 * 4.500000000000001 frames` has found the right defect and made itself impossible to trust.
 *
 * The unit is matched case-insensitively because CSS units are. Everything else this does NOT
 * accept — `+0.18s`, `1.8e-1s` — is deliberate: see `offFrameDurations`, which treats a value it
 * cannot read as a finding rather than a skip. Widening this pattern is the move that has already
 * failed twice; the next unlisted form would slip through a third time.
 */
export function durationMs(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(m?s)$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2]?.toLowerCase() === 'ms' ? n : Math.round(n * 1e6) / 1e3;
}

/** A rung — a `--lc-dur-*` token. `--lc-ease*` holds beziers and is rule 1's business, not rule 3's. */
const IS_RUNG = /^--lc-dur-/;

/**
 * Rule 3 — a declared duration that is not a whole frame at 25fps.
 *
 * FAILS CLOSED, and this is ryder's second REQUIRED on #1082. The rule used to `continue` on
 * anything it could not parse, so the parser's blind spots became the gate's blind spots silently.
 * Widening the regex fixed one round and left the next: at 9e0ddf90, `--lc-dur-6:` set to `0.18S`,
 * `180MS`, `+0.18s` or `1.8e-1s` all left `tokens:check` green, and all four are 4.5 frames — a new
 * rung at rule 3's own defect class, the exact sentence the previous round was supposed to retire.
 *
 * So an unreadable rung is now a finding. The case fix above is real (CSS units are
 * case-insensitive); the other forms are reported rather than parsed, which closes the class BY
 * CONSTRUCTION instead of by enumeration. A gate that cannot count the frames must say so — the one
 * thing it must never do is stay quiet and let the reader infer that it counted them and was happy.
 */
export function offFrameDurations(css: string): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const { token, value, line } of declaredMotionTokens(css)) {
    const n = durationMs(value);
    if (n === null) {
      if (IS_RUNG.test(token)) {
        out.push({
          kind: 'unreadable',
          line,
          detail:
            `${token}: ${value} — cannot be read as a duration, so its frame count is unknown. ` +
            `Write it as a plain number of ms or s (e.g. 200ms, 0.2s); ` +
            `signs, exponents and indirection are not accepted here on purpose.`,
        });
      }
      continue;
    }
    // Non-integer ms are reachable now (`0.0005s`), so the whole-frame test is a remainder on a
    // float. Compare the rounded remainder, not the raw one, or 6ms-exact values spelled in
    // seconds fail on representation error rather than on frames.
    const off = Math.round((n % FRAME_MS) * 1e3) / 1e3;
    if (off !== 0) {
      // toFixed(1) rounded 281ms to "7 frames" — a message asserting the value IS whole while
      // failing it for not being, which is the one thing this line must never say.
      const frames = trim2(n / FRAME_MS);
      const nearest = Math.round(n / FRAME_MS) * FRAME_MS;
      out.push({
        kind: 'off-frame',
        line,
        // Reported in ms whatever unit it was written in — the value is the frame count, and the
        // author needs the rung, not their own spelling read back to them.
        detail:
          `${token}: ${trim2(n)}ms is ${frames} frames at 25fps ` +
          `(off by ${trim2(Math.min(off, FRAME_MS - off))}ms — nearest whole frame is ${String(nearest)}ms)`,
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
 * Rule 5 — a `var()` in a motion declaration that nothing declares and nothing sets.
 *
 * Found by the Task 4 migration doing the damage itself: deleting `--lc-fast` left four references
 * in ApprovalCard.css pointing at nothing, and a transition whose duration does not resolve simply
 * does not animate. Nothing in CSS complains, and none of rules 1-4 could see it — they judge
 * declarations and literals, and this is neither.
 *
 * JUDGED BY SITE, NOT BY NAME, and that is dolly's finding on #1109. The pattern was
 * `--lc-(?:dur-…|ease…|fast|med)`, so the rule only caught a phantom whose author had already
 * filed it in the motion namespace — and `var(--lc-motion-ease, ease)` in Live.css, on the motion
 * surface, under a `--lc-` name, rode a green gate. The name was never what made it motion: the
 * position was. Any var() between `transition:`/`animation:` and its `;` is a motion value, and an
 * unresolved one silently drops the declaration.
 *
 * Widening the name pattern instead would have been the third round of the move this file has
 * already watched fail twice (rule 2's private duration grammar, rule 3's `/^(\d+)ms$/`), and it
 * would leave the next unlisted prefix through.
 *
 * `declared` is every custom property declared across all stylesheets, so a token declared in one
 * file and used in another (the normal case — the scale lives in Live.css) is not a false positive.
 * `runtimeSet` is the tokens TS writes with `setProperty`, and it is load-bearing exactly as it is
 * for the colour arm: `--lc-mote-delay` and `--lc-twinkle-delay` are undeclared in CSS ON PURPOSE
 * and carry a fallback for the frame before JS sets them. They are the only three uses the widening
 * newly reaches (measured 2026-08-31), so without this the honest fix would have shipped three
 * false failures on its first run.
 */
export function phantomMotionRefs(
  css: string,
  declared: ReadonlySet<string>,
  runtimeSet: ReadonlySet<string> = new Set(),
): MotionFinding[] {
  const lineAt = lineIndexer(css);
  const out: MotionFinding[] = [];
  for (const decl of motionDeclarations(css)) {
    for (const m of decl.text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)) {
      const token = m[1];
      if (token && !declared.has(token) && !runtimeSet.has(token)) {
        out.push({
          kind: 'phantom',
          line: lineAt(decl.start + (m.index ?? 0)),
          detail: `var(${token}) is used in a motion declaration but declared nowhere and never set at runtime`,
        });
      }
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
    for (const seg of decl.segments) {
      if (/\binfinite\b/.test(seg.text)) continue; // per animation, not per declaration
      for (const m of seg.text.matchAll(/var\((--lc-dur-[\w-]+)\)/g)) if (m[1]) used.add(m[1]);
    }
  }
  if (used.size === 0) return [];
  const answered =
    css.includes('@media (prefers-reduced-motion') &&
    /transition-duration:\s*0s|animation:\s*none|transition:\s*none/.test(css);
  return answered ? [] : [...used].sort();
}
