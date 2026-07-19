# packages/web — performance contract

You are working in the musterd web UI. **Speed is a feature here.** A 2026-07 optimization arc
(#326–#331) took /live from Lighthouse 49 → 85, 1,077 KB → 381 KB transferred, 4,461 → 1,564 DOM
nodes. Those numbers are the floor, not a high-water mark: do not spend them buying your feature.

## Hard gate

`pnpm perf:check` (runs in CI after build) enforces byte budgets from
[docs/perf/budgets.json](../../docs/perf/budgets.json): total/per-chunk JS gzip, CSS gzip, font
bytes, and a font-family allowlist. If your change trips it, first try to shrink the change
(lazy-load, drop the dependency, subset); raising a budget is allowed but is a deliberate, reviewed
act — do it in the same PR and log the measured cost in
[docs/perf/web-live-baseline.md](../../docs/perf/web-live-baseline.md) (ADR 151).

## Standing rules (each one is a shipped, measured win — don't undo it)

- **New dependencies are guilty until proven light.** Check the gzip cost before importing; prefer
  what's already in the tree. Heavy, route-specific code gets a lazy chunk, never the entry.
- **Animation/render loops must stop when unseen.** The office scene suspends its rAF loop when the
  panel is collapsed or the tab hidden (#331). Any new canvas/rAF/interval work must do the same —
  idle cost is paid by every viewer, forever.
- **The stream DOM stays windowed** (~60 mounted rows, reveal-on-scrollback, live-edge collapse,
  1,000-envelope memory cap — #328). Don't mount unbounded lists anywhere; window them.
- **Fonts: the three active families only** (Fraunces, Space Grotesk, Space Mono). A new family or
  weight is a re-font decision, not a side-effect (#329). Canvas painters read type via
  `src/live/canvasFont.ts` tokens — never hard-code a family name in a painter.
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
