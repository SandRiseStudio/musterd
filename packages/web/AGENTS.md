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
  `/asks-preview` 124.1 → 118.3 KB (that route was retired on 2026-08-13; the measurement stands as
  the demonstration that lazy-loading moves this budget).
- `totalJsGzipBytes` — every chunk, lazy included: how much code the product carries.
  **Lazy-loading cannot move this** and slightly raises it. Delete code or drop the dependency.

Each failure names its own remedy, so read the message rather than guessing. Raising a budget is
allowed but is a deliberate, reviewed act — do it in the same PR and log the measured cost in
[docs/perf/web-live-baseline.md](../../docs/perf/web-live-baseline.md) (ADR 151). **Before raising,
check whether a re-baseline is due instead**: budgets are periodically reset to measured + 15%, and a
re-baseline may only tighten — a loosening one is just a raise (ADR 183). Two ceilings were hit in
one week in 2026-07 because raises were being used to fix a calibration problem.

## Deploying the public site — miley's, not yours

**`pnpm --filter @musterd/web deploy:site` is miley's to run**
([ADR 308](../../docs/decisions/308-public-site-deploy-authorization.md)). If your change
ends with prose or pixels on musterd.io, land the PR and tell miley. This is standing, not
per-request.

**And miley does not wait for per-publish approval.** It is a standing authorization, not a routing
rule: miley publishes web changes when they are ready, without asking nick each time. Those are two
different rules and only one of them was in the original sentence — "who may deploy" without "and
when" is the half that gets guessed at. Deploy authority is also not review authority: it does not
license merging work miley has not read.

It covers the publish to musterd.io and nothing else. The `/live` bundle is **not** a deploy — merge
to `main` and the build-publisher republishes within ~60s with no daemon bounce (root `AGENTS.md`,
[ADR 132](../../docs/decisions/132-live-viewer-on-daemon-origin.md)). `musterd service refresh` is
the daemon, not the UI. Neither goes through miley.

The reason, in one line: a deploy is the only act in this loop that **no acceptance can
reverse**, and the only place where *landed* and *live* are different facts. ADR 308 carries the
evidence — a merged-but-undeployed fix that stayed broken in public, and two defects on the live
site that no diff, no staging build and no `vite preview` could show.

## The generated content module

`src/content/generated/site-content.ts` (docs, blog and roadmap rendered to HTML at build-prep time,
ADR 302) is **gitignored and produced on demand** — `pnpm build` and `pnpm typecheck` both run
`scripts/gen-site-content.ts` first. That is why typecheck runs a script: without it, a fresh
checkout reports `Cannot find module '../content/generated/site-content'` across five route files
and the red looks like the checker-outer's fault. Three seats hit exactly that on 2026-08-21 before
typecheck was wired to the generator. **Never commit the generated file** — it would go stale
against the markdown the moment either changed.

## Standing rules (each one is a shipped, measured win — don't undo it)

- **Web lanes default to `stakes: low`, and raising it is your call to make** (ADR 244). A team admin
  set that default; you don't declare it per lane. But the default is a *starting point*, not a
  verdict on your change — override upward the moment your change alters what a surface **asserts as
  fact** (counts, recipients, routing claims, who an ask is for) rather than only how it looks. That
  distinction is deliberately not in the config: encoding it would be inferring value from surface,
  which is what ADR 234 rejected and what this default is only admissible for *not* doing. The
  evidence it matters is on the record — on 2026-08-05 four web lanes routed `normal` and acceptance
  caught two real defects on one of them, both on a change a blanket path rule would have exempted.
- **Contrast is a gate now, not a habit** — `pnpm a11y:check` (CI, after Build) sweeps every
  prerendered route and fails on any AA failure. It was added on 2026-08-12 after nine live failures
  had accumulated in the gap where "run the script sometimes" was the whole policy; eight were a
  fill token used as text with its `-ink` sibling defined a line away. It sweeps `/board` and
  `/live` **connected**, against a throwaway daemon over a synthetic team — the first run of that
  phase found eleven more, ten on the goal grid. A green gate is still not full coverage: read the
  per-route "N unmeasurable" count it prints, and remember it can only measure states the fixture
  team actually seeds.
- **The goal grid has a measured ink set — use it, don't add a ninth brown.** `--gg-ink-quiet`,
  `--gg-ink-accent` and `--gg-ink-success` (defined on `.gg-stage`) each clear 4.9+ against every
  paper that file paints. They replaced eight one-off hexes, of which ten usages measured below AA.
- **Contrast is measured in the browser, never computed from the hex.** `pnpm a11y:contrast <url>`
  ([docs/a11y/contrast.md](../../docs/a11y/contrast.md)) resolves each colour by painting it to a
  canvas, so alpha tints, `color-mix()` and translucent stacks are accounted for. Two things it
  exists to stop you doing by hand: parsing `getComputedStyle`, which returns `color(srgb 0.91 …)`
  in **0–1 floats** that a naive parser reads as 0–255 and scores as near-black; and walking
  ancestors past a gradient, which finds the letterbox black behind the office canvas. Both produced
  confident wrong numbers before the script existed.
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
