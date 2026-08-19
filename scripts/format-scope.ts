/*
 * The ONE list of paths Prettier governs in this repo (ADR 284).
 *
 *   pnpm format         — rewrite them
 *   pnpm format:check   — verify them
 *
 * Both scripts call this file. That is the whole point, and it is a structural guarantee rather
 * than a rule anyone has to remember: there is no second list to drift out of sync with, so the
 * writer's scope CANNOT exceed the checker's.
 *
 * WHAT WENT WRONG WITHOUT IT. `format` wrote `**\/*.{ts,js,mjs,json,md}` — everything — while
 * `format:check` verified only `packages/**\/*.ts`, `tests/**\/*.ts` and the root files. Measured
 * 2026-08-19 on clean main, 207 files sat inside the writer's scope and outside the checker's: 202
 * under `docs/`, 5 under `scripts/`, plus README.md, ROADMAP.md, npm-reserve/ and packaging/. So
 * running the repo's own documented command silently rewrote 207 files no gate governed, and no
 * gate could report it. It bit at least three seats.
 *
 * And it did not present as a formatting problem. Prettier rewrapped ROADMAP.md, which then no
 * longer matched `gen-roadmap.ts` output, so `roadmap:check` went red — sending the seat to hunt in
 * the roadmap generator for damage done by the formatter.
 *
 * PROSE IS NOT IN SCOPE, deliberately. `docs/` is the decision spine: ADRs are frozen once
 * accepted (AGENTS.md), the wiki carries dated claims and falsifiers, and a reflow rewrites blame
 * for every line of an argument nobody was editing. `.prettierignore` carries the same exclusion,
 * because that file governs invocations this one cannot see — a bare `npx prettier --write .`, an
 * editor's format-on-save, a future script. Belt and braces, on purpose: this list is the contract,
 * `.prettierignore` is the backstop.
 */

/**
 * Every path Prettier reads or writes. Adding one puts it under BOTH the formatter and the gate in
 * the same commit — which is the invariant, so resist the urge to add "just for the writer".
 */
export const FORMAT_GLOBS: readonly string[] = [
  'packages/**/*.ts',
  'tests/**/*.ts',
  // scripts/ decides CI (it holds the gates themselves) and joined typecheck in #854. It was in the
  // writer's scope and outside the checker's for the whole of that time.
  'scripts/**/*.{ts,mjs}',
  'workers/**/*.ts',
  '*.{ts,json}',
];
