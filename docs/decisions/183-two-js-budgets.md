# 183 — Two JS budgets: what a viewer downloads is not what the product carries

- Status: accepted — 2026-07-29
- Date: 2026-07-29

## Context

ADR 151 made the /live perf arc a merge gate: `docs/perf/budgets.json` holds the numbers,
`scripts/perf/check-budgets.ts` enforces them in CI, and a raise is a reviewed diff. It budgets one
JS number, `totalJsGzipBytes`, computed as the gzip sum of **every** `.js` under `dist/client`.

That number cannot be reduced by code-splitting. Moving a module behind a dynamic import does not
remove it from `dist/client`; it only adds per-chunk overhead, so the total goes very slightly _up_.
Meanwhile the gate's failure message names lazy-loading as the **first** remedy for a blocked
engineer. The first thing the gate suggests provably cannot move the number the gate enforces.

Measured, not argued (2026-07-29, during #483/#487): splitting the default-off room-tone engine into
its own chunk moved 1.3 KB out of the live route's initial payload and moved the gate the wrong way,
**243.3 → 243.7 KB**. That split was reverted — 0.5% off initial load did not justify a module
boundary plus a round-trip — and the finding was logged in `docs/perf/web-live-baseline.md` rather
than fixed, because which metric is _correct_ is a policy question, not a bug.

## Problem

Decide what the JS budget is for, then make the gate's advice true. Two honest readings, and the
repo has quietly wanted both:

1. **Total shipped JS** tracks how much code the product carries, which is what rots. A dependency
   added behind a dynamic import is still code someone must maintain, secure, and eventually delete.
2. **Initial payload** tracks what a viewer downloads before the page is interactive. It is what
   users feel, and it is the number Lighthouse moves with.

A single budget cannot serve both, and picking one silently — which is what shipping ADR 151 did —
leaves either the advice wrong or the rot ungated.

The measurement that settles the shape: total shipped JS is **201.7 KB** across 29 chunks, while the
worst route's _eager_ graph is **124.1 KB**. **~40% of shipped JS is already lazy on every route**,
and the single-budget gate gave that architecture no credit at all. The two numbers are not
approximations of each other.

## Decision

**Budget both, with different remedies attached.**

### 1. `initialJsGzipBytes` — the tight budget, measured per route, enforced on the worst

Each prerendered route ships an `index.html` that names its own eager graph: the entry `<script>`
plus one `<link rel="modulepreload">` per statically imported chunk. Dynamic imports are absent by
construction. So **the built HTML is the measurement** — no bundler-internal manifest has to be
trusted or kept in sync, and the checker stays dependency-free native TypeScript.

The gate computes every route's eager gzip and enforces the **worst** one, naming it in both the
pass line and the failure. Worst-route rather than per-route budgets keeps one number to maintain
while still failing on the page a viewer is most likely to feel.

A build emitting no prerendered route HTML **fails** rather than skipping. A budget that silently
measures nothing is worse than no budget, because it reports green.

### 2. `totalJsGzipBytes` — the loose budget, kept as a code-rot ceiling

Unchanged in meaning: every chunk, lazy included. Its remedy is deleting code or dropping a
dependency. Keeping it is what stops "make it lazy" from becoming a way to smuggle in unbounded code
behind a passing initial-payload check.

### 3. The failure text carries the remedy that moves _that_ number

Not one blanket list of suggestions. `initialJsGzipBytes` says lazy-loading works; `totalJsGzipBytes`
says lazy-loading will **not** move this and names deletion instead. This is the actual defect from
ADR 151 being closed: the gate now tells the truth about its own remedies.

### 4. Budgets are re-baselined on a cadence, and the re-baseline may only tighten

ADR 151 set budgets at measured **+10%** on 2026-07-19. That headroom was exhausted in **nine days**
by ordinary shipping, and two ceilings were hit in one week — the CSS budget was raised at 99.3%
utilisation, and JS reached 0.8 KB of headroom. Both raise notes in the optimization log say the same
thing: the raise restored working headroom rather than buying the feature that tripped it. That is a
calibration failure being paid down in installments, one panicked PR at a time.

So: **re-baseline all budgets to measured + 15% on a cadence** — at each perf pass, and otherwise
when a maintainer notices the numbers have drifted — rather than raising per blocked PR. Done in the
calm moment, a re-baseline is a measurement; done under pressure, it is a concession.

With one guard, because the naive ritual is worse than no ritual: **a re-baseline may tighten
freely, but any loosening is an ordinary budget raise** and follows ADR 151's raise protocol
(justified in the PR, cost logged). Without that, "reset to measured + 15%" would ratchet upward
forever and legitimize every regression the gate exists to catch. The first re-baseline shows both
directions live: total JS **250,000 → 238,000** and fonts **760,000 → 653,000** tightened (the
roadmap-map removal and the Inter re-font were wins the budgets never captured), while
`maxChunkGzipBytes` **held at 112,000** because measured + 15% would have loosened it to 115,000.

## Observability & Evaluation

**Traces** — `perf:check`'s one-line summary now prints initial-vs-total side by side on every CI run
and every local invocation, naming the worst route and its eager chunk count
(`initial JS gzip 124.1 KB/142.6 KB (worst route /asks-preview, 6 eager chunks) · total JS gzip
201.7 KB/232.4 KB (29 chunks) · …`). The divergence between the two is itself the instrument: if
initial approaches total, the lazy architecture has quietly collapsed into one eager bundle. As under
ADR 151, `budgets.json`'s git history remains the record of every deliberate move, now distinguishing
a tightening re-baseline from a loosening raise.

**Eval** — the gate self-verified mechanically at introduction, four checks, each run:

- **Passes** on `0acb669`'s build with real headroom (124.1/142.6 initial, 201.7/232.4 total).
- **Negative-tested independently in both directions** — initial budget lowered to 100,000 fails on
  initial alone while total stays green; total lowered to 150,000 fails on total alone while initial
  stays green. This is the property a single budget could not have: the two are separately
  enforceable.
- **Vacuity-tested** — a `dist/client` with no route HTML exits 1 with a message saying so, rather
  than reporting a green initial budget.
- **The central claim tested against the bundler, not assumed.** A lazy-load must actually move
  `initialJsGzipBytes`, and it would not if the bundler emitted `modulepreload` for dynamic imports
  as well. A throwaway `lazy()` split of `AsksStrip` on `/asks-preview` took that route
  **124.1 → 118.3 KB** (6 eager chunks → 5, dropping exactly the 5.9 KB `AsksStrip` chunk) while
  total JS rose **201.7 → 201.9 KB** — the two budgets moving in opposite directions, which is both
  the proof and the design. The probe was reverted; it existed to test the gate, not to ship a split.

Dataset: every future PR build. Headline measure: an engineer blocked by the JS gate can satisfy it
by following the advice it printed — the thing that was false before this ADR. Secondary measure,
checked at the next perf pass: raises become rarer than re-baselines. If they do not, the +15%
headroom or the cadence is still mis-sized, and the log will show it in the same shape as the
2026-07-28 pair.

**Experiment** — the open question ADR 151 left is now testable rather than rhetorical. Its own
`experiment` section predicted that a structural gate changes agent behavior where prose does not;
what it could not predict is what happens when the structure gives **impossible** advice. The
room-tone episode is the answer: an agent followed the gate's suggestion, measured an improvement to
the thing that matters, watched the gate move the wrong way, and reverted correct work. The probe
worth watching is the next lane blocked by `initialJsGzipBytes` — whether a split now lands and
stays landed. The still-open room-tone lane (`01KYNJ6ENB`) is the natural first case, and under these
budgets its 1.3 KB would count as the win it always was.

## Consequences

- Lazy-loading becomes a real remedy in CI, so route-level splitting is worth doing for its own sake
  rather than only against the manual Lighthouse harness.
- One more number to maintain, and a checker that now depends on the shape of prerendered route HTML.
  If the build stops emitting per-route HTML the gate fails loudly and this checker needs updating —
  deliberately the failure mode, not a silent pass.
- Worst-route enforcement means a regression confined to a cheaper route is invisible until it
  becomes the worst route. Per-route budgets would catch it, at the cost of ten numbers to
  re-baseline; revisit if that blind spot ever bites.
- `totalJsGzipBytes` keeps its meaning but loses its status as _the_ JS budget, so a tight fit there
  should now prompt a deletion pass, not a split.
- The re-baseline ritual only works if someone runs it. It is written into the perf ritual in
  `packages/web/AGENTS.md` and the failure text points at it, but nothing enforces the cadence — a
  future gate could fail when `budgets.json` is older than N days.
