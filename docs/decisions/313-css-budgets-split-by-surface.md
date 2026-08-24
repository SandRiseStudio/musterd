# 313 — The CSS budget splits by surface, and the canvas does not buy the runway

- Status: accepted
- Date: 2026-08-24
- Lane: `01M0GVNJ2SCDBZ9X52QD2FTVEF` (Delight 0)
- Relates to: [ADR 151](151-web-perf-budgets-gate.md), [ADR 183](183-two-js-budgets.md),
  [ADR 302](302-musterd-io-public-site.md)

## Context

Increment 0 of the office delight program (spec: `docs/superpowers/specs/2026-08-20-office-delight-program-design.md`)
exists so that the resolution of "extremely magical" versus a nearly-exhausted byte budget is a
decision nick makes on measurement, not one a seat makes by raising a number in a PR footnote. The
spec posed it as two routes: raise the ceilings deliberately (Route 1), or move office chrome off
CSS onto the canvas that already draws the room (Route 2).

Measured on main @ 6bcc8c4a, 2026-08-24, the way the gate measures (`gzipSync` default level over
`packages/web/dist/client`):

| budget | measured | ceiling | free |
| --- | --- | --- | --- |
| CSS gzip | 26,394 | 26,400 | **6 B** |
| initial JS gzip (worst route `/live`) | 154,372 | 156,000 | 1,628 B |
| total JS gzip | 240,456 | 241,000 | 544 B |

`totalCssGzipBytes` had been raised twice since its last re-baseline (22000 → 25300 on 2026-08-04,
25300 → 26400 on 2026-08-12) — the calibration drift ADR 183 names. And the night the budget ran
out, the change that could not fit was a 30-line table rule on `/docs/spec` — a public-site route
with no office on it. The ceiling was set when the site was one page; the site is eight routes now,
and it competes with the office for the same number.

## The Route 2 measurement

Substitutability was measured by rebuilding with candidate sections of `Live.css` actually removed
and reading the shipped bundle's gzip delta — not by raw-byte arithmetic, which double-counts what
gzip deduplicates.

- **Tier 1 — pure decoration over the canvas** (the Tier-A ambient FX overlay: steam, dust motes,
  bulb twinkle; the room watermark; one retired dead section): **−832 gzip bytes, 5.3 % of
  Live.css's 15,810.** The only part the canvas can take cheaply; precedent exists (the
  working-monitor glow already moved into the canvas).
- **Tier 1 + 2 — adding the interactive over-canvas chrome** (nameplates/paper set, speech bubbles
  with rich tokens and hover-expand, the agile-board hotspot, the work stack): **−4,143 gzip bytes,
  26.2 % of Live.css.**

The spec's falsifier ("under ~15 % substitutable → Route 2 dead") is passed only by counting
tier 2 — which is text, hover, focus, click-through and a11y. Redrawing that in canvas spends JS
bytes, and the JS budgets are the next-fullest in the table above (total JS is 99.8 % consumed).
**Route 2 as a runway strategy moves cost from the fullest budget to the second-fullest.** Tier 1
alone sits under the falsifier's threshold by itself.

## Decision

1. **Route 2 is rejected as the runway strategy.** The 832-byte tier-1 trim stays available inside
   increment-E work on its own merits, but it is not how the program gets its bytes.
2. **`totalCssGzipBytes` is replaced by three budgets** in `docs/perf/budgets.json`, each at that
   surface's measured gzip + 15 %:
   - `appCssGzipBytes` 24,700 (measured 21,492 — Live, Broadcast, Board, approvals, audit),
   - `siteCssGzipBytes` 2,900 (measured 2,538 — SiteNav, routes, index),
   - `sharedCssGzipBytes` 2,700 (measured 2,364 — global, brand).
3. **Classification is explicit and closed.** `scripts/perf/check-budgets.ts` maps each built CSS
   bundle by pre-hash basename against `budgets.cssBundles`; an unlisted bundle fails the gate. A
   new stylesheet is assigned to a surface deliberately, the same design as the font allowlist.
4. **This is a loosening, and it is recorded as one.** A re-baseline may only tighten (ADR 183), so
   no re-baseline could have produced runway; the implied total ceiling rises 26,400 → 30,300. The
   ADR 183 ritual is satisfied here rather than in a PR footnote: the raise is justified by the
   structural defect it removes — two surfaces with different owners and different velocities
   sharing one ceiling, which is how two raises accumulated with no re-baseline and how a
   public-site table rule got blocked by office bytes.

The route choice was nick's, made 2026-08-24 on the numbers above (spec §10).

## Consequences

- The next CSS failure names its owner: an office increment that overruns cannot be paid for by
  trimming the site, and the failure message says so.
- The office delight program's byte-adding increments (A2, B, C, D, E1, E2) unblock against
  `appCssGzipBytes` with ~3.2 KB of measured headroom.
- Re-baselines now happen per budget, and each may still only tighten.
- **Falsifier:** if within two re-baseline cycles the split budgets accumulate raises at the same
  cadence the single budget did (two in eight days), the split fixed nothing and this ADR should be
  revisited as having been a raise wearing structure.

## Observability & Evaluation

- **Traces:** the gate's summary line now prints all three CSS numbers per run
  (`CSS gzip app X/Y · site X/Y · shared X/Y`), so every CI log carries the per-surface consumption
  history; raises stay logged in `docs/perf/web-live-baseline.md` per ADR 151.
- **Eval:** dataset is the raise log itself — budgets.json's `$comment` trail plus the baseline
  doc. Baseline: the single budget took two raises in eight days (2026-08-04, 2026-08-12) with no
  re-baseline. The falsifier above reads the same trail against the same cadence.
- **Experiment:** n/a — the failure-path behaviour was exercised at build time (an unclassified
  bundle fails; an over-budget group fails naming only its own bundles), not A/B-tested.
