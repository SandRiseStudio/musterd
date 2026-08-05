# packages/web — performance contract

You are working in the musterd web UI. **Speed is a feature here.** A 2026-07 optimization arc
(#326–#331) took /live from Lighthouse 49 → 85, 1,077 KB → 381 KB transferred, 4,461 → 1,564 DOM
nodes. Those numbers are the floor, not a high-water mark: do not spend them buying your feature.

## Hard gate

`pnpm perf:check` (runs in CI after build) enforces byte budgets from
[docs/perf/budgets.json](../../docs/perf/budgets.json): **initial** JS gzip, **total** JS gzip,
per-chunk JS gzip, CSS gzip, font bytes, and a font-family allowlist.

**The two JS budgets have different remedies, and reaching for the wrong one wastes a session**
(ADR 183):

- `initialJsGzipBytes` — the worst route's eager graph (entry + statically imported chunks), the
  number a viewer feels. **Lazy-loading moves this.** Measured, 2026-07-29: a `lazy()` split took
  `/asks-preview` 124.1 → 118.3 KB.
- `totalJsGzipBytes` — every chunk, lazy included: how much code the product carries.
  **Lazy-loading cannot move this** and slightly raises it. Delete code or drop the dependency.

Each failure names its own remedy, so read the message rather than guessing. Raising a budget is
allowed but is a deliberate, reviewed act — do it in the same PR and log the measured cost in
[docs/perf/web-live-baseline.md](../../docs/perf/web-live-baseline.md) (ADR 151). **Before raising,
check whether a re-baseline is due instead**: budgets are periodically reset to measured + 15%, and a
re-baseline may only tighten — a loosening one is just a raise (ADR 183). Two ceilings were hit in
one week in 2026-07 because raises were being used to fix a calibration problem.

## Standing rules (each one is a shipped, measured win — don't undo it)

- **Web lanes default to `stakes: low`, and raising it is your call to make** (ADR 244). A team admin
  set that default; you don't declare it per lane. But the default is a *starting point*, not a
  verdict on your change — override upward the moment your change alters what a surface **asserts as
  fact** (counts, recipients, routing claims, who an ask is for) rather than only how it looks. That
  distinction is deliberately not in the config: encoding it would be inferring value from surface,
  which is what ADR 234 rejected and what this default is only admissible for *not* doing. The
  evidence it matters is on the record — on 2026-08-05 four web lanes routed `normal` and acceptance
  caught two real defects on one of them, both on a change a blanket path rule would have exempted.
- **New dependencies are guilty until proven light.** Check the gzip cost before importing; prefer
  what's already in the tree. Heavy, route-specific code gets a lazy chunk, never the entry.
- **Animation/render loops must stop when unseen.** The office scene suspends its rAF loop when the
  panel is collapsed or the tab hidden (#331). Any new canvas/rAF/interval work must do the same —
  idle cost is paid by every viewer, forever.
- **The stream DOM stays windowed** (~60 mounted rows, reveal-on-scrollback, live-edge collapse,
  1,000-envelope memory cap — #328). Don't mount unbounded lists anywhere; window them.
- **Fonts: the three active families only** (Inter, Space Grotesk, Space Mono — body was re-fonted
  Fraunces → Inter on 2026-07-20; `budgets.json` is the authority). A new family or
  weight is a re-font decision, not a side-effect (#329). Canvas painters read type via
  `src/live/canvasFont.ts` tokens — never hard-code a family name in a painter.
- **Colour tokens must be defined, and a `var()` fallback must not contradict them.** `pnpm
  tokens:check` (in the `format:check` chain) fails on two silent lies: a colour token used with a
  fallback but **defined nowhere** (the fallback quietly becomes the value, and defining it later
  silently restyles everything that used it), and a fallback that **disagrees** with the definition
  (dead, since the token resolves — but it misinforms the next reader, which is how a wrong value
  gets copied forward). Runtime-parametric properties are exempt automatically, including colour
  ones the sources actually `setProperty` — don't add fallback-free `var()` to those.
  **Fill and text amber are different tokens**: `--lc-warn` is FILLS ONLY (presence dots, ~1.2:1 on
  paper by design) and `--lc-warn-ink` is anything read as text (4.92:1 worst case). Same split as
  `--lc-ov-accent` / `--lc-ov-accent-ink`. Reaching for the fill as a text colour is the mistake
  this pair exists to prevent.
- **The daemon already serves compressed + cached** (brotli/gzip, immutable hashed assets, ETag app
  shell, compressed JSON — #326/#327). Don't add a second compression layer or cache-bust hashed
  assets.

## Measure before optimizing; re-measure after changing

For any perf-affecting change, run the reproducible harness (`scripts/perf/live-baseline.mjs`;
method + temp-daemon recipe at the top of docs/perf/web-live-baseline.md) and append your numbers to
that file's optimization log. Premises die on contact with profiles here — two plausible levers were
measured and rejected; **do not re-chase these without new evidence**:

- Entry-chunk splitting (the 320 KB entry is framework runtime, not dead marketing code — #2 in the
  findings log).
- `content-visibility` on stream rows (its placeholder sizing fights the scroll anchoring and the
  viewport drifts).
- Split-bake office layers / lowering the 20 fps ambient cap (measured ~2% of one core; product
  call, not a perf default).
