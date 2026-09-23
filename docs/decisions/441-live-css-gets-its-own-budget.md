# 441 — Live.css gets its own budget

- Status: accepted
- Date: 2026-09-23
- Lane: `01M2XCABG2CV8QBY9YGGW25TGZ`
- Relates to: [ADR 151](151-web-perf-budgets-gate.md), [ADR 183](183-two-js-budgets.md),
  [ADR 313](313-css-budgets-split-by-surface.md)

## Context

ADR 313 split CSS by surface into `app`, `site` and `shared`. The `app` group holds five
stylesheets: `Live`, `Board`, `Broadcast`, `approvals` and `audit`. Measured on 2026-09-23 after
`pnpm --filter @musterd/web build` (Node zlib, the gate's own measurement):

| bundle    | gzip B |
| --------- | -----: |
| Live      | 18,056 |
| Board     |  2,279 |
| Broadcast |  2,246 |
| approvals |  1,863 |
| audit     |    217 |
| **app**   | **24,661** of 24,700 |

That is 39 B free, far below the ~0.7 KB by which CI gzips higher than local. The gate read green
while the next office change would go red on `main` after merging green on its branch.

## Problem

Trimming was measured first, as ADR 183 requires, and it is not available:

- **Dead selectors: none.** 632 classes are in the app bundles. 109 have no literal token in
  `packages/web/src`, and every one is a modifier built at runtime (`lc-badge--${tone}`) whose
  stem is in use.
- **Duplicate rule bodies:** 36 groups, ~2.3 KB raw in Live.css. Gzip already absorbs most repeated
  text, so a merge gives about 100–200 B. It also reorders the cascade in an 18 KB stylesheet under
  continuous change. That risk buys less than the CI delta.

`Live.css` is 73% of the group and the file under continuous change (the office). The other four
stylesheets change rarely. One ceiling makes them share the office's lack of runway.

## Decision

Split `live` (the `Live` bundle alone) off `app`. Each group gets its measured gzip + 15%, as ADR 313
did: `liveCssGzipBytes` 20,800 (18,056 measured) and `appCssGzipBytes` 7,600 (6,605 measured).
`cssBundles` gains a `live` group, and an unlisted bundle still fails the gate.

This loosens the combined ceiling from 24,700 to 28,400 B. It is a deliberate raise under ADR 183's
ritual, approved by nick on 2026-09-23. It is not a re-baseline, because a re-baseline may only
tighten.

## Consequences

- Free after the split: `live` 2,744 B, `app` 995 B. Both are more than the ~0.7 KB CI delta.
- The office's growth is now visible as its own number. When `live` fills, the question is about
  the office alone, and Board, Broadcast, approvals and audit keep their runway.
- The `live` runway is about 2.7 KB of office CSS. At the 2026-08 rate (+1,019 lines in six days),
  that is weeks, not months. The next time it fills, the question is the canvas trade-off from
  ADR 313 (Route 2), not another raise.

## Observability & Evaluation

n/a — not agent-facing: a build-time byte budget, with no traces, dataset or model behaviour.
`pnpm perf:check` prints `live` and `app` separately. Falsifier: add ~800 B of gzipped CSS to
Live.css, build and run `perf:check`. It must stay green; if it goes red, the split did not create
the runway it claims.
